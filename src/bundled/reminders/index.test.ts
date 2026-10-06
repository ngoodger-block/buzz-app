import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../../features/relay/events";
import { createReminders } from "../../features/relay/reminders";
import { apply } from "./index";

const viewer = "v";
const target = {
  eventId: "m",
  channelId: "c",
  preview: "hi",
  authorPubkey: "a",
};
const wire = (id: string, notBefore: number): RelayEvent =>
  ({
    id,
    pubkey: viewer,
    kind: 30300,
    created_at: 1,
    tags: [
      ["d", id],
      ["not_before", String(notBefore)],
    ],
    content: JSON.stringify({ target, status: "pending" }),
    sig: "",
  }) as unknown as RelayEvent;

function session(
  history: Promise<RelayEvent[]> | (() => Promise<RelayEvent[]>),
) {
  return createReminders({
    viewer,
    signal: new AbortController().signal,
    host: {
      decode: async (events) =>
        events.map((e) => ({ eventId: e.id, content: JSON.parse(e.content) })),
      sign: async ({ d, createdAt, notBefore, content }) =>
        ({
          id: d,
          pubkey: viewer,
          kind: 30300,
          created_at: createdAt,
          tags: [
            ["d", d],
            ["not_before", String(notBefore)],
          ],
          content: JSON.stringify(content),
          sig: "",
        }) as unknown as RelayEvent,
    },
    query: typeof history === "function" ? history : () => history,
    publish: async () => {},
  });
}

function mount() {
  const listeners = new Set<() => void>();
  let snapshot: unknown = { status: "connecting" };
  const submit = vi.fn(() => Promise.resolve());
  const ctx = {
    relay: {
      snapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    notifications: { register: () => ({ submit }) },
    pages: { register: vi.fn() },
    navigation: {},
    conversation: { registerMessageAction: vi.fn() },
    effect: (body: () => void) => body(),
  };
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  const connect = (scope: string, reminders: unknown) => {
    snapshot = { status: "ready", scope, viewer, session: { reminders } };
    for (const listener of listeners) listener();
  };
  return { submit, connect };
}

const at = (seconds: number) => vi.setSystemTime(seconds * 1000);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  at(100);
});
afterEach(() => vi.useRealTimers());

it("notifies a reminder from slow history even after a live update moved the clock", async () => {
  let resolveHistory: (events: RelayEvent[]) => void = () => {};
  const model = session(new Promise((resolve) => (resolveHistory = resolve)));
  const { submit, connect } = mount();
  connect(`origin:${viewer}`, model.capability);
  at(105);
  model.receive([wire("later", 10_000)]);
  await flush();
  at(106);
  resolveHistory([wire("overdue", 103)]);
  await flush();
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sourceKey: "overdue:103" }),
  );
  model.receive([wire("other", 20_000)]);
  await flush();
  expect(submit).toHaveBeenCalledTimes(1);
});

it("suppresses reminders already due when a community is first bound, and fires late timers", async () => {
  const { submit, connect } = mount();
  const first = session(Promise.resolve([wire("old", 50), wire("soon", 110)]));
  connect(`a:${viewer}`, first.capability);
  await flush();
  expect(submit).not.toHaveBeenCalled();
  at(120);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sourceKey: "soon:110" }),
  );
  at(200);
  const second = session(Promise.resolve([wire("b-old", 150)]));
  connect(`b:${viewer}`, second.capability);
  await flush();
  expect(submit).toHaveBeenCalledTimes(1);
});

function deferred() {
  let resolve: (events: RelayEvent[]) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<RelayEvent[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("notifies a reminder from slow history after a local save during loading", async () => {
  const history = deferred();
  const model = session(history.promise);
  const { submit, connect } = mount();
  connect(`origin:${viewer}`, model.capability);
  at(105);
  await model.capability.create(target, 10_000);
  await flush();
  at(106);
  history.resolve([wire("overdue", 103)]);
  await flush();
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sourceKey: "overdue:103" }),
  );
});

it("keeps the bind-time window through a failed first read until a refresh succeeds", async () => {
  const first = deferred();
  const reads = [first.promise, Promise.resolve([wire("overdue", 103)])];
  const model = session(() => reads.shift() as Promise<RelayEvent[]>);
  const { submit, connect } = mount();
  connect(`origin:${viewer}`, model.capability);
  model.receive([wire("later", 10_000)]);
  await flush();
  at(105);
  first.reject(new Error("offline"));
  await flush();
  at(106);
  await model.capability.refresh();
  await flush();
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sourceKey: "overdue:103" }),
  );
});

it("keeps the bind-time window when a live arrival follows a failed first read", async () => {
  const reads = [
    Promise.reject(new Error("offline")),
    Promise.resolve([wire("overdue", 103)]),
  ];
  const model = session(() => reads.shift() as Promise<RelayEvent[]>);
  const { submit, connect } = mount();
  connect(`origin:${viewer}`, model.capability);
  await flush();
  expect(model.capability.snapshot().status).toBe("error");
  at(105);
  model.receive([wire("later", 10_000)]);
  await flush();
  at(106);
  await model.capability.refresh();
  await flush();
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sourceKey: "overdue:103" }),
  );
});

it("opens a note-only reminder's notification on its own community's page", async () => {
  const origin = "https://a.example";
  const note = {
    ...wire("note", 110),
    content: JSON.stringify({ note: "call back", status: "pending" }),
  } as RelayEvent;
  const { submit, connect } = mount();
  const model = session(Promise.resolve([note]));
  connect(`${origin}:${viewer}`, model.capability);
  await flush();
  at(120);
  await vi.advanceTimersByTimeAsync(10_000);
  connect(
    `https://b.example:${viewer}`,
    session(Promise.resolve([])).capability,
  );
  await flush();
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    sourceKey: "note:110",
    target: {
      version: 1,
      kind: "page",
      pluginId: "buzz.reminders",
      pageId: "reminders",
      scope: { viewer, communityOrigin: origin },
    },
  });
});
