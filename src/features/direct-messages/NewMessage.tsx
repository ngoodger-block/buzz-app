import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { OutgoingEvent } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import { DraftMentionRoster } from "../messages/draft-mention-roster";
import { MessageComposer } from "../messages/MessageComposer";
import { mentionDraft, type MentionDraft } from "../messages/mention-draft";
import { clearView, readView, writeView } from "../../shared/view-state";
import { Button } from "../../shared/design-system/ui/Button";
import { RecipientPicker } from "./RecipientPicker";
import type { Recipient } from "./usePeople";
import styles from "./NewMessage.module.css";

const draftKey = "direct-message:new-draft";
const recoveryKey = "direct-message:new";

type Pending = {
  id: string;
  channelId: string;
  recipients: string;
  draft: MentionDraft;
};
const keyFor = (people: readonly Recipient[]) =>
  people
    .map((person) => person.pubkey)
    .sort()
    .join(":");
// Persist identity and a bounded label, never the directory's full metadata.
const recipientView = ({ pubkey, name, isAgent }: Recipient): Recipient => ({
  pubkey,
  name: name.slice(0, 500),
  ...(isAgent === true ? { isAgent: true } : {}),
});
function savedRecipients(scope: string, viewer?: string) {
  return validRecipients(
    readView<unknown>(scope, "direct-message:recipients", []),
    viewer,
  );
}
function validRecipients(saved: unknown, viewer?: string) {
  if (!Array.isArray(saved)) return [];
  return [
    ...new Map(
      saved
        .filter(
          (person): person is Recipient =>
            person &&
            typeof person.pubkey === "string" &&
            /^[0-9a-f]{64}$/.test(person.pubkey) &&
            person.pubkey !== viewer &&
            typeof person.name === "string",
        )
        .map((person) => [person.pubkey, recipientView(person)]),
    ).values(),
  ].slice(0, 8);
}
// Earlier development builds wrote a separate pointer. Keep it confirmation-only;
// its absence from the journal must never authorize a replacement message.
function savedLegacy(scope: string, viewer?: string) {
  const value = readView<Partial<Pending> | null>(
    scope,
    "direct-message:pending",
    null,
  );
  if (
    value &&
    typeof value.id === "string" &&
    /^[0-9a-f]{64}$/.test(value.id) &&
    typeof value.channelId === "string" &&
    /^[0-9a-f-]{36}$/.test(value.channelId) &&
    typeof value.recipients === "string" &&
    value.recipients.length <= 519 &&
    value.draft
  )
    return {
      id: value.id,
      channelId: value.channelId,
      recipients: value.recipients,
      draft: mentionDraft(value.draft),
      people: savedRecipients(scope, viewer),
    };
}

function recovered(operations: readonly OutgoingEvent[], viewer?: string) {
  const item = operations.find((item) => item.recovery?.key === recoveryKey);
  if (!item?.recovery) return undefined;
  const value = JSON.parse(item.recovery.value);
  const people = validRecipients(value.people, viewer);
  const channelId = item.event.tags.find(([name]) => name === "h")?.[1];
  if (item.event.kind !== 9 || !channelId || !people.length)
    throw new Error("The saved new message could not be restored.");
  return {
    id: item.event.id,
    channelId,
    recipients: keyFor(people),
    draft: mentionDraft(value.draft),
    people,
  };
}

/** Recipient-first conversation that can open directly or send through the durable outbox. */
export function NewMessage({
  session,
  scope,
  extensions,
  onPreparing,
  onOpened,
  onStarted,
}: {
  session: RelaySession;
  scope: string;
  extensions?: ConversationExtensions | undefined;
  onPreparing?(pubkeys: readonly string[]): void;
  onOpened(channelId: string): void;
  onStarted(channelId: string, messageId: string): void;
}) {
  const [recipients, setRecipients] = useState(() =>
    savedRecipients(scope, session.viewer),
  );
  const recipientNames = recipients.map((person) => person.name).join(", ");
  const [legacy, setLegacy] = useState(() =>
    savedLegacy(scope, session.viewer),
  );
  const initialLegacy = useRef(legacy);
  const [ready, setReady] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<MentionDraft>();
  const [draftRevision, setDraftRevision] = useState(0);
  const retiring = useRef<string | undefined>(undefined);
  const [busy, setBusy] = useState<"opening" | "sending" | undefined>();
  const [error, setError] = useState("");
  const [draftChannel] = useState(() => crypto.randomUUID());
  const attempt = useRef<AbortController | null>(null);
  const prepared = useRef<{ key: string; id: string } | undefined>(undefined);
  const outbox = session.outbox;
  const operations = useSyncExternalStore(
    outbox?.subscribe ?? noSubscribe,
    outbox?.snapshot ?? emptySnapshot,
    emptySnapshot,
  );
  let pending: (Pending & { people: Recipient[] }) | undefined;
  try {
    pending = recovered(operations, session.viewer) ?? legacy;
  } catch {
    /* Readiness presents invalid recovery. */
  }
  const failed =
    pending && session.directMessages.delivery(pending.id) === "failed";
  const locked = !ready || !!busy || (!!pending && !failed);
  useLayoutEffect(() => {
    const confirmed = pending && session.directMessages.delivery(pending.id);
    if (pending) {
      retiring.current =
        confirmed === "accepted" || confirmed === "seen"
          ? pending.id
          : undefined;
    } else if (retiring.current) {
      // A different mount may have completed acknowledgement while this page
      // restored its recovery payload. Never leave that payload as a fresh draft.
      retiring.current = undefined;
      setRecipients([]);
      setRestoredDraft(mentionDraft(""));
      setDraftRevision((revision) => revision + 1);
    }
  }, [pending, session.directMessages]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await outbox?.ready();
        if (!active) return;
        const saved =
          recovered(outbox?.snapshot() ?? [], session.viewer) ??
          initialLegacy.current;
        if (saved) {
          const editable =
            session.directMessages.delivery(saved.id) === "failed";
          setRecipients(
            editable
              ? validRecipients(
                  readView(scope, "direct-message:recipients", saved.people),
                  session.viewer,
                )
              : saved.people,
          );
          setRestoredDraft(
            editable
              ? mentionDraft(readView(scope, draftKey, saved.draft))
              : saved.draft,
          );
        }
        setReady(true);
      } catch (reason) {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not restore the message.",
          );
      }
    })();
    return () => {
      active = false;
      attempt.current?.abort();
    };
  }, [outbox, session.viewer, session.directMessages, scope]);
  function validateAgents() {
    const controlled = new Set(
      session.agentChoices
        .snapshot()
        .identities.filter((agent) => agent.managed)
        .map((agent) => agent.pubkey),
    );
    if (
      recipients.some(
        (person) =>
          (person.isAgent ||
            session.profiles.snapshot().get(person.pubkey)?.isAgent) &&
          !controlled.has(person.pubkey),
      )
    )
      throw new Error(
        "A selected agent is no longer available. Remove it or wait for agent controls to reconnect.",
      );
  }
  function change(people: Recipient[]) {
    if (locked || attempt.current) return;
    prepared.current = undefined;
    setRecipients(people);
    writeView(scope, "direct-message:recipients", people.map(recipientView));
    setError("");
  }
  async function open() {
    if (
      attempt.current ||
      !ready ||
      !recipients.length ||
      !session.directMessages.available
    )
      return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy("opening");
    setError("");
    try {
      validateAgents();
      const pubkeys = recipients.map((person) => person.pubkey);
      onPreparing?.(pubkeys);
      const id = await session.directMessages.open(pubkeys, controller.signal);
      controller.signal.throwIfAborted();
      clearView(scope, "direct-message:recipients");
      onOpened(id);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not open the conversation. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
      if (attempt.current === controller) attempt.current = null;
    }
  }
  async function send(draft: MentionDraft) {
    if (
      attempt.current ||
      !ready ||
      !recipients.length ||
      !draft.text.trim() ||
      !session.directMessages.available
    )
      return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy("sending");
    setError("");
    const key = keyFor(recipients);
    let current: Pending | undefined = pending;
    try {
      if (current && session.directMessages.delivery(current.id) === "failed")
        validateAgents();
      if (
        current &&
        (current.recipients !== key ||
          JSON.stringify(current.draft) !== JSON.stringify(draft))
      ) {
        if (session.directMessages.delivery(current.id) !== "failed")
          throw new Error(
            "Retry the earlier message to confirm its delivery before editing.",
          );
        validateAgents();
        await outbox?.dismiss(current.id);
        controller.signal.throwIfAborted();
        current = undefined;
        setLegacy(undefined);
        writeView(scope, "direct-message:pending", null);
      }
      if (!current) {
        validateAgents();
        onPreparing?.(recipients.map((person) => person.pubkey));
        const id =
          prepared.current?.key === key
            ? prepared.current.id
            : await session.directMessages.open(
                recipients.map((person) => person.pubkey),
                controller.signal,
              );
        controller.signal.throwIfAborted();
        prepared.current = { key, id };
        validateAgents();
        const messageId = session.messages.send(
          id,
          draft.text,
          draft.recipients.map((person) => person.pubkey),
          [],
          {
            key: recoveryKey,
            value: JSON.stringify({
              people: recipients.map(recipientView),
              draft,
            }),
          },
        );
        current = { id: messageId, channelId: id, recipients: key, draft };
      }
      await session.directMessages.delivered(
        current.id,
        current.channelId,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      // Clear disposable views before releasing durable recovery. A failed clear
      // retains the operation for confirmation-only retry, even across unmount.
      clearView(
        scope,
        draftKey,
        "direct-message:pending",
        "direct-message:recipients",
      );
      await outbox?.acknowledge(current.id);
      if (controller.signal.aborted) return;
      setLegacy(undefined);
      onStarted(current.channelId, current.id);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not send your message. Try again.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(undefined);
      if (attempt.current === controller) attempt.current = null;
    }
  }
  return (
    <section className={styles.page} aria-label="New message">
      <RecipientPicker
        session={session}
        scope={scope}
        selected={recipients}
        disabled={locked}
        onChange={change}
      />
      <div className={styles.blank} data-new-message-body="" />
      <div className={styles.feedback}>
        {recipients.length > 0 && !pending && (
          <Button
            type="button"
            disabled={locked || !session.directMessages.available}
            onClick={() => void open()}
          >
            Open conversation
          </Button>
        )}
        {busy && (
          <p role="status">
            {busy === "opening" ? "Opening conversation…" : "Sending message…"}
          </p>
        )}
        {!session.directMessages.available && (
          <p role="status">
            Starting direct messages is unavailable on this connection.
          </p>
        )}
        {pending && !failed && !busy && !error && (
          <Button
            type="button"
            onClick={() => pending && void send(pending.draft)}
          >
            Retry send
          </Button>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            {pending && !failed && (
              <Button
                type="button"
                disabled={!!busy}
                onClick={() => pending && void send(pending.draft)}
              >
                Retry send
              </Button>
            )}
          </div>
        )}
      </div>
      <DraftMentionRoster.Provider value={recipients}>
        <MessageComposer
          key={`${ready ? "ready" : "hydrating"}:${draftRevision}`}
          session={session}
          scope={scope}
          extensions={extensions}
          channelId={draftChannel}
          channelName={recipientNames || "new message"}
          label={recipientNames ? `Message ${recipientNames}` : "New message"}
          placeholder={recipientNames ? undefined : ""}
          disabled={!recipients.length}
          submission={{
            draftKey,
            recoveredDraft: restoredDraft,
            locked,
            disabled:
              !ready ||
              !!busy ||
              !recipients.length ||
              !session.directMessages.available,
            submit: (draft) => void send(draft),
          }}
        />
      </DraftMentionRoster.Provider>
    </section>
  );
}
const empty: readonly never[] = [];
const emptySnapshot = () => empty;
const noSubscribe = () => () => {};
