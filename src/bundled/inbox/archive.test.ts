// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InboxItem } from "../../features/relay/inbox";
import { keypair, message } from "../../features/relay/testing";
import { viewRevision } from "../../shared/view-state";
import {
  archiveKey,
  archiveIndex,
  isArchived,
  readArchives,
  reopenArchives,
  updateArchive,
} from "./archive";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const viewer = keypair(),
    alice = keypair();
  const mention = message(alice, "room", "Please review", 20, [
    ["p", viewer.pubkey],
  ]);
  const events = new Map([[mention.id, mention]]);
  const item: InboxItem = {
    id: `room:${mention.id}`,
    channelId: "room",
    target: { kind: "message", channelId: "room", messageId: mention.id },
    messageId: mention.id,
    latestMessageId: mention.id,
    messageIds: [mention.id],
    authorId: alice.pubkey,
    preview: mention.content,
    createdAt: 20,
    mentioned: true,
    mentions: [{ id: mention.id, createdAt: mention.created_at }],
    thread: false,
    unreadCount: 1,
    manual: false,
    readThrough: [],
  };
  const scope = `https://relay.test:${viewer.pubkey}`;
  const archived = (row = item) =>
    isArchived(
      archiveIndex(readArchives(viewRevision(scope, archiveKey))),
      row,
    );
  vi.spyOn(Date, "now").mockReturnValue(30_000);
  return { viewer, alice, events, item, scope, archived };
}

it("keeps observed mentions and ordinary replies archived, but reopens for a same-second new tag", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  expect(h.archived()).toBe(true);
  const add = (at: number, tag: boolean) => {
    const event = message(
      h.alice,
      "room",
      `Update at ${at}`,
      at,
      tag ? [["p", h.viewer.pubkey]] : [],
    );
    h.events.set(event.id, event);
    return {
      ...h.item,
      latestMessageId: event.id,
      messageIds: [...h.item.messageIds, event.id],
      createdAt: at,
      mentions: [
        ...h.item.mentions,
        ...(tag ? [{ id: event.id, createdAt: at }] : []),
      ],
    };
  };
  expect(h.archived(add(40, false))).toBe(true);
  expect(h.archived(add(29, true))).toBe(true);
  const reopened = add(30, true);
  expect(h.archived(reopened)).toBe(false);
  reopenArchives(h.scope, [reopened]);
  expect(readArchives(viewRevision(h.scope, archiveKey))).toEqual([]);
  expect(h.archived()).toBe(false);
});

it("preserves archive intent when exact conversation evidence regroups and restores it", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  const regrouped = { ...h.item, id: "room:root" };
  expect(h.archived(regrouped)).toBe(true);
  expect(h.archived({ ...regrouped, channelId: "another-room" })).toBe(false);
  updateArchive(h.scope, regrouped, false);
  expect(h.archived(regrouped)).toBe(false);
});

it("persists a regrouped archive coordinate after its original evidence is replaced", () => {
  const h = fixture();
  const rootId = "a".repeat(64);
  const reply = message(h.alice, "room", "Unresolved reply", 20, [
    ["e", rootId, "", "reply"],
  ]);
  const unresolvedReply: InboxItem = {
    ...h.item,
    id: `room:${reply.id}`,
    target: { kind: "message", channelId: "room", messageId: reply.id },
    messageId: reply.id,
    latestMessageId: reply.id,
    messageIds: [reply.id],
    createdAt: reply.created_at,
    mentioned: false,
    mentions: [],
    thread: true,
  };
  updateArchive(h.scope, unresolvedReply, true);
  expect(h.archived(unresolvedReply)).toBe(true);

  const regrouped: InboxItem = {
    ...unresolvedReply,
    id: `room:${rootId}`,
    rootId,
    messageIds: [reply.id, "b".repeat(64)],
  };
  reopenArchives(h.scope, [regrouped]);
  const laterReplies: InboxItem = {
    ...regrouped,
    messageId: "c".repeat(64),
    latestMessageId: "c".repeat(64),
    messageIds: ["c".repeat(64)],
    createdAt: 40,
    mentions: [],
  };
  expect(h.archived(laterReplies)).toBe(true);

  const saved = readArchives(viewRevision(h.scope, archiveKey));
  expect(saved).toEqual([
    {
      id: regrouped.id,
      channelId: h.item.channelId,
      through: 30,
      messageIds: [reply.id],
    },
  ]);
});

it("partitions archives by community and viewer, and never hides a failed save", () => {
  const h = fixture();
  updateArchive(h.scope, h.item, true);
  expect(
    readArchives(viewRevision("https://other.test:viewer", archiveKey)),
  ).toEqual([]);
  expect(
    readArchives(
      viewRevision(`https://relay.test:${h.alice.pubkey}`, archiveKey),
    ),
  ).toEqual([]);
  updateArchive(h.scope, h.item, false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("disk full");
  });
  expect(() => updateArchive(h.scope, h.item, true)).toThrow("Could not save");
  expect(h.archived()).toBe(false);
});

it("ignores malformed archive records", () => {
  expect(readArchives("{bad json")).toEqual([]);
  expect(
    readArchives(
      '[{"id":"room:root","channelId":"room","through":0,"messageIds":["invalid"]}]',
    ),
  ).toEqual([]);
});
