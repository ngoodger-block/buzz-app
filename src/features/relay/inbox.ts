import type { ReadTarget } from "./read-state-model";

/** A conversation projected from the unread owner's bounded verified evidence. */
export type InboxItem = Readonly<{
  id: string;
  channelId: string;
  target: ReadTarget;
  /** Oldest observed unread message, otherwise newest relevant message. */
  messageId: string;
  latestMessageId: string;
  /** Exact verified group members, for pending preview evidence across regrouping. */
  messageIds: readonly string[];
  rootId?: string;
  authorId: string;
  preview: string;
  createdAt: number;
  mentioned: boolean;
  /** Explicit verified mentions, excluding self, for Inbox archive renewal. */
  mentions: readonly Readonly<{ id: string; createdAt: number }>[];
  thread: boolean;
  unreadCount: number;
  manual: boolean;
  /** Explicit prefixes; a thread prefix never acknowledges its top-level root. */
  readThrough: readonly Readonly<{ target: ReadTarget; messageId: string }>[];
}>;
export type InboxSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  items: readonly InboxItem[];
  freshness: "unknown" | "observed" | "stale";
  error?: string | undefined;
}>;
