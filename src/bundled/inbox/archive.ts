import type { InboxItem } from "../../features/relay/inbox";
import { replaceView, viewRevision } from "../../shared/view-state";

export const archiveKey = "inbox:archives";
type Archive = Readonly<{
  id: string;
  channelId: string;
  through: number;
  messageIds: readonly string[];
}>;
const maxBytes = 512 * 1024;

export function readArchives(
  revision: string | null | undefined,
): readonly Archive[] {
  if (!revision || revision.length > maxBytes) return [];
  try {
    const value: unknown = JSON.parse(revision);
    if (!Array.isArray(value) || value.length > 1000) return [];
    return value.filter(
      (entry): entry is Archive =>
        entry &&
        typeof entry.id === "string" &&
        typeof entry.channelId === "string" &&
        Number.isSafeInteger(entry.through) &&
        entry.through >= 0 &&
        Array.isArray(entry.messageIds) &&
        entry.messageIds.length <= 4096 &&
        entry.messageIds.every(
          (id: unknown) => typeof id === "string" && /^[0-9a-f]{64}$/.test(id),
        ),
    );
  } catch {
    return [];
  }
}

function owns(archive: Archive, item: InboxItem) {
  return (
    archive.channelId === item.channelId &&
    (archive.id === item.id ||
      archive.messageIds.some((id) => item.messageIds.includes(id)))
  );
}

type ArchiveIndex = ReadonlyMap<string, readonly Archive[]>;
const coordinate = (channelId: string, id: string) =>
  JSON.stringify([channelId, id]);
export function archiveIndex(archives: readonly Archive[]): ArchiveIndex {
  const index = new Map<string, Archive[]>();
  for (const archive of archives)
    for (const id of [archive.id, ...archive.messageIds]) {
      const key = coordinate(archive.channelId, id);
      const entries = index.get(key) ?? [];
      entries.push(archive);
      index.set(key, entries);
    }
  return index;
}
function matches(index: ArchiveIndex, item: InboxItem) {
  return [
    ...new Set(
      [item.id, ...item.messageIds].flatMap(
        (id) => index.get(coordinate(item.channelId, id)) ?? [],
      ),
    ),
  ];
}

function renewed(archive: Archive, item: InboxItem) {
  if (!item.mentions.length) return false;
  const observed = new Set(archive.messageIds);
  return item.mentions.some(
    ({ id, createdAt }) => !observed.has(id) && createdAt >= archive.through,
  );
}

export function isArchived(index: ArchiveIndex, item: InboxItem) {
  if (!index.size) return false;
  const entries = matches(index, item);
  return (
    entries.length > 0 && !entries.some((archive) => renewed(archive, item))
  );
}

export function updateArchive(
  scope: string,
  item: InboxItem,
  archived: boolean,
) {
  const revision = viewRevision(scope, archiveKey);
  const archives = readArchives(revision).filter((entry) => !owns(entry, item));
  if (archived)
    archives.push({
      id: item.id,
      channelId: item.channelId,
      through: Math.max(Math.floor(Date.now() / 1000), item.createdAt),
      messageIds: [...item.messageIds],
    });
  if (archives.length > 1000 || JSON.stringify(archives).length > maxBytes)
    throw new Error(
      "Inbox archive storage is full. Restore some archived conversations first.",
    );
  const result = replaceView(scope, archiveKey, revision, archives);
  if (result !== "saved")
    throw new Error(
      result === "changed"
        ? "Inbox archive changed in another window. Try again."
        : "Could not save the Inbox archive on this device. Try again.",
    );
}

/** Retire reopened entries so bounded evidence cannot hide the conversation again. */
export function reopenArchives(
  scope: string,
  items: readonly InboxItem[],
  revision = viewRevision(scope, archiveKey),
) {
  const archives = readArchives(revision);
  if (!archives.length) return;
  const index = archiveIndex(archives);
  const reopened = new Set(
    items.flatMap((item) =>
      matches(index, item).filter((archive) => renewed(archive, item)),
    ),
  );
  const retained = archives.filter((archive) => !reopened.has(archive));
  if (retained.length === archives.length) return;
  if (replaceView(scope, archiveKey, revision, retained) !== "saved")
    throw new Error(
      "Could not save the reopened Inbox conversation on this device. Try again.",
    );
}
