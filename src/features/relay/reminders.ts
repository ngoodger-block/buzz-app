// NIP-ER reminders (kind 30300): the viewer's self-encrypted, replaceable reminder list.
// Encryption and signing stay in the host; this owner sees only decoded intent.
import type { ReadFilter, RelayEvent } from "./events";

export const REMINDER_KIND = 30300;

/** Buzz's target dialect, shared with beta desktop and mobile (not the NIP-ER spec shape). */
export type ReminderTarget = Readonly<{
  eventId: string;
  channelId: string;
  preview: string;
  authorPubkey: string;
}>;
export type ReminderStatus = "pending" | "done" | "cancelled";
export type Reminder = Readonly<{
  /** The `d` coordinate. */
  id: string;
  eventId: string;
  createdAt: number;
  /** Due time in unix seconds; absent once done or cancelled. */
  notBefore?: number;
  status: ReminderStatus;
  target?: ReminderTarget;
  note?: string;
}>;
export type RemindersState = Readonly<{
  status: "loading" | "ready" | "error";
  reminders: readonly Reminder[];
  error?: string;
}>;
export type ReminderIntent = Readonly<{
  d: string;
  createdAt: number;
  notBefore?: number;
  expiration?: number;
  content: Readonly<{
    target?: ReminderTarget;
    note?: string;
    status: ReminderStatus;
  }>;
}>;
/** Purpose-bound host codec: decode only own 30300s, sign only reminder intent. */
export type ReminderHost = Readonly<{
  decode(
    events: readonly RelayEvent[],
    signal: AbortSignal,
  ): Promise<readonly { eventId: string; content: unknown }[]>;
  sign(intent: ReminderIntent, signal: AbortSignal): Promise<RelayEvent>;
}>;
export type Reminders = Readonly<{
  snapshot(): RemindersState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  create(
    target: ReminderTarget,
    notBefore: number,
    note?: string,
  ): Promise<void>;
  snooze(id: string, notBefore: number): Promise<void>;
  complete(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
}>;

/** Mirrors the relay's validator: ASCII digits, no leading zero, safe integer. */
export function parseNotBefore(raw: string | undefined): number | undefined {
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

const text = (value: unknown): value is string => typeof value === "string";

/** Off-shape plaintext fails closed, as NIP-ER requires. */
export function parseReminder(
  event: RelayEvent,
  content: unknown,
): Reminder | undefined {
  const id = event.tags.find(([name]) => name === "d")?.[1];
  if (!id || !content || typeof content !== "object" || Array.isArray(content))
    return undefined;
  const data = content as Record<string, unknown>;
  const status = data.status;
  if (status !== "pending" && status !== "done" && status !== "cancelled")
    return undefined;
  if (data.note !== undefined && !text(data.note)) return undefined;
  let target: ReminderTarget | undefined;
  if (data.target !== undefined) {
    const t = data.target as Record<string, unknown> | null;
    if (
      !t ||
      typeof t !== "object" ||
      !text(t.eventId) ||
      !text(t.channelId) ||
      !text(t.preview) ||
      !text(t.authorPubkey)
    )
      return undefined;
    target = Object.freeze({
      eventId: t.eventId,
      channelId: t.channelId,
      preview: t.preview,
      authorPubkey: t.authorPubkey,
    });
  }
  if (!target && !data.note) return undefined;
  const notBefore = parseNotBefore(
    event.tags.find(([name]) => name === "not_before")?.[1],
  );
  return Object.freeze({
    id,
    eventId: event.id,
    createdAt: event.created_at,
    status,
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(target ? { target } : {}),
    ...(text(data.note) ? { note: data.note } : {}),
  });
}

function randomD() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const now = () => Math.floor(Date.now() / 1000);
/** Completed records expire 30–90 days out, randomized (NIP-ER). */
const expiration = () => now() + (30 + Math.floor(Math.random() * 60)) * 86_400;

export function createReminders(options: {
  viewer: string;
  host: ReminderHost;
  query(filters: ReadFilter[], signal: AbortSignal): Promise<RelayEvent[]>;
  publish(event: RelayEvent, signal: AbortSignal): Promise<unknown>;
  signal: AbortSignal;
}) {
  const { viewer, host, signal } = options;
  const heads = new Map<string, Reminder>();
  const listeners = new Set<() => void>();
  let state: RemindersState = Object.freeze({
    status: "loading",
    reminders: [],
  });
  let loading: Promise<void> | undefined;
  const publishState = (next: Omit<RemindersState, "reminders">) => {
    state = Object.freeze({
      ...next,
      reminders: Object.freeze([...heads.values()]),
    });
    for (const listener of listeners) listener();
  };
  // The relay's replaceable rule: newest created_at wins, then the lowest event id.
  const merge = (reminder: Reminder) => {
    const current = heads.get(reminder.id);
    if (
      current &&
      (current.createdAt > reminder.createdAt ||
        (current.createdAt === reminder.createdAt &&
          current.eventId <= reminder.eventId))
    )
      return false;
    heads.set(reminder.id, reminder);
    return true;
  };
  async function accept(events: readonly RelayEvent[]) {
    const own = events.filter(
      (event) => event.kind === REMINDER_KIND && event.pubkey === viewer,
    );
    if (!own.length) return false;
    const byId = new Map(own.map((event) => [event.id, event]));
    const decoded = await host.decode(own, signal);
    signal.throwIfAborted();
    let changed = false;
    for (const { eventId, content } of decoded) {
      const event = byId.get(eventId);
      const reminder = event && parseReminder(event, content);
      if (reminder && merge(reminder)) changed = true;
    }
    return changed;
  }
  // Edits to one coordinate run in order, each building on the previous result.
  const queues = new Map<string, Promise<void>>();
  function replace(
    id: string,
    next: (current: Reminder) => Omit<ReminderIntent, "d" | "createdAt">,
  ) {
    const run = (queues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = heads.get(id);
        if (!current) throw new Error("Reminder not found");
        await write({
          ...next(current),
          d: id,
          createdAt: Math.max(now(), current.createdAt + 1),
        });
      });
    queues.set(id, run);
    void run
      .finally(() => {
        if (queues.get(id) === run) queues.delete(id);
      })
      .catch(() => {});
    return run;
  }
  async function write(intent: ReminderIntent) {
    const event = await host.sign(intent, signal);
    await options.publish(event, signal);
    if (await accept([event])) publishState({ status: "ready" });
  }
  const content = (current: Reminder, status: ReminderStatus) => ({
    ...(current.target ? { target: current.target } : {}),
    ...(current.note !== undefined ? { note: current.note } : {}),
    status,
  });
  const capability: Reminders = Object.freeze({
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh() {
      loading ??= (async () => {
        try {
          const events = await options.query(
            [{ kinds: [REMINDER_KIND], authors: [viewer], limit: 200 }],
            signal,
          );
          await accept(events);
          publishState({ status: "ready" });
        } catch (error) {
          if (signal.aborted) return;
          publishState({
            status: heads.size ? "ready" : "error",
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          loading = undefined;
        }
      })();
      return loading;
    },
    create: (target, notBefore, note) =>
      write({
        d: randomD(),
        createdAt: now(),
        notBefore,
        content: {
          target,
          ...(note?.trim() ? { note: note.trim() } : {}),
          status: "pending",
        },
      }),
    snooze: (id, notBefore) =>
      replace(id, (current) => ({
        notBefore,
        content: content(current, "pending"),
      })),
    complete: (id) =>
      replace(id, (current) => ({
        expiration: expiration(),
        content: content(current, "done"),
      })),
    cancel: (id) =>
      replace(id, (current) => ({
        expiration: expiration(),
        content: content(current, "cancelled"),
      })),
  });
  return {
    capability,
    /** Live delivery from another device; failures leave the last good list. */
    receive(events: readonly RelayEvent[]) {
      void accept(events)
        .then((changed) => {
          if (changed)
            publishState({
              status: state.status === "error" ? "ready" : state.status,
            });
        })
        .catch(() => {});
    },
  };
}
