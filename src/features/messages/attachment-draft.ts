import { useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import {
  UPLOAD_MAX_BYTES,
  UploadError,
  type UploadedAttachment,
} from "../relay/attachments";
import { prepareAttachment } from "./prepare-attachment";

export type DraftAttachment = Readonly<{
  id: string;
  file: File;
  status: "queued" | "preparing" | "uploading" | "ready" | "error";
  uploaded?: UploadedAttachment;
  error?: string | undefined;
}>;
export type AttachmentDraft = {
  snapshot(): readonly DraftAttachment[];
  subscribe(listener: () => void): () => void;
  add(files: readonly File[]): void;
  adopt(files: readonly DraftAttachment[]): boolean;
  prepareForSend(signal: AbortSignal): Promise<readonly UploadedAttachment[]>;
  remove(id: string): void;
  retry(id: string): void;
  cancel(): void;
  clear(): void;
};
const drafts = new WeakMap<RelaySession, Map<string, AttachmentDraft>>();
const MAX_FILES = 10;
const MAX_RETAINED_BYTES = 2 * UPLOAD_MAX_BYTES;

/** Tab-local files survive navigation, not reload. Delivery remains outbox-owned. */
export function attachmentDraft(
  session: RelaySession,
  key: string,
  channelId: string,
): AttachmentDraft {
  let partition = drafts.get(session);
  if (!partition) {
    partition = new Map();
    drafts.set(session, partition);
  }
  const existing = partition.get(key);
  if (existing) return existing;
  const owners = partition;
  let items: readonly DraftAttachment[] = [];
  const listeners = new Set<() => void>();
  const active = new Map<string, AbortController>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const replace = (id: string, change: Partial<DraftAttachment>) => {
    items = items.map((item) =>
      item.id === id
        ? {
            ...item,
            ...change,
            ...("error" in change && change.error === undefined
              ? { error: undefined }
              : {}),
          }
        : item,
    );
    emit();
  };
  function cancelActive() {
    for (const controller of active.values()) controller.abort();
    active.clear();
    items = items.map((item) =>
      item.status === "preparing" || item.status === "uploading"
        ? {
            ...item,
            status: "error",
            error: "Upload paused. Retry to continue.",
          }
        : item,
    );
    emit();
  }
  function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Upload cancelled.", "AbortError");
  }
  function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(abortReason(signal));
      signal.addEventListener("abort", abort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) reject(abortReason(signal));
          else resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
  async function prepareOne(
    item: DraftAttachment,
    signal: AbortSignal,
  ): Promise<UploadedAttachment> {
    if (item.uploaded) return item.uploaded;
    const attachments = session.attachments;
    if (!attachments) throw new UploadError("unavailable");
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    active.set(item.id, controller);
    replace(item.id, { status: "preparing", error: undefined });
    try {
      const prepared = await prepareAttachment(item.file, combined);
      combined.throwIfAborted();
      replace(item.id, { status: "uploading" });
      const uploaded = await abortable(
        attachments.upload(prepared, channelId, combined),
        combined,
      );
      combined.throwIfAborted();
      replace(item.id, { status: "ready", uploaded });
      return uploaded;
    } catch (error) {
      if (combined.aborted) {
        if (signal.aborted && !controller.signal.aborted)
          replace(item.id, { status: "queued", error: undefined });
      } else
        replace(item.id, {
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Upload failed. Retry or remove this file.",
        });
      throw error;
    } finally {
      if (active.get(item.id) === controller) active.delete(item.id);
    }
  }
  const store = {
    snapshot: () => items,
    subscribe(listener: () => void) {
      owners.set(key, store);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          cancelActive();
          if (!items.length && owners.get(key) === store) owners.delete(key);
        }
      };
    },
    add(files: readonly File[]) {
      if (!session.attachments) throw new UploadError("unavailable");
      if (items.length + files.length > MAX_FILES)
        throw new Error(`Attach at most ${MAX_FILES} files per message.`);
      for (const file of files)
        if (!file.size || file.size > UPLOAD_MAX_BYTES)
          throw new UploadError("size");
      const retained = [...owners.values()]
        .flatMap((owner) => owner.snapshot())
        .reduce((sum, item) => sum + item.file.size, 0);
      if (
        retained + files.reduce((sum, file) => sum + file.size, 0) >
        MAX_RETAINED_BYTES
      )
        throw new Error(
          "Attachment drafts are full (1,000 MiB). Send or remove some files first.",
        );
      items = [
        ...items,
        ...files.map(
          (file): DraftAttachment => ({
            id: crypto.randomUUID(),
            file,
            status: "queued",
          }),
        ),
      ];
      owners.set(key, store);
      emit();
    },
    /** Moves already admitted files, with their results and errors, into an empty draft. */
    adopt(files: readonly DraftAttachment[]) {
      if (items.length || !files.length) return false;
      items = files;
      owners.set(key, store);
      emit();
      return true;
    },
    async prepareForSend(signal: AbortSignal) {
      if (!items.length) return [];
      const uploaded: UploadedAttachment[] = [];
      for (const item of items) {
        const current = items.find((candidate) => candidate.id === item.id);
        if (!current) throw new UploadError("cancelled");
        uploaded.push(await prepareOne(current, signal));
      }
      return uploaded;
    },
    remove(id: string) {
      active.get(id)?.abort();
      active.delete(id);
      items = items.filter((item) => item.id !== id);
      emit();
    },
    retry(id: string) {
      if (!items.some((item) => item.id === id && item.status === "error"))
        return;
      replace(id, { status: "queued", error: undefined });
    },
    cancel: cancelActive,
    clear() {
      cancelActive();
      items = [];
      emit();
    },
  };
  return store;
}

/** A confirmed deletion discards only this session's exact scoped composer files.
 * A missing store is a no-op; do not allocate a draft merely to clear it. */
export function clearAttachmentDraft(session: RelaySession, key: string) {
  const owners = drafts.get(session);
  const store = owners?.get(key);
  if (!store) return;
  store.clear(); // abort uploads before disposing the scoped entry
  if (owners?.get(key) === store) owners.delete(key);
}

export function useAttachmentDraft(
  session: RelaySession,
  key: string,
  channelId: string,
) {
  // Composer's destination key remounts this hook on a session/channel/thread change.
  const [store] = useState(() => attachmentDraft(session, key, channelId));
  const items = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  return {
    store,
    items,
    blocked: items.some((item) =>
      ["preparing", "uploading", "error"].includes(item.status),
    ),
  };
}
