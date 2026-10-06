import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "./events";
import {
  createReminders,
  parseNotBefore,
  parseReminder,
  type ReminderIntent,
} from "./reminders";

const event = (tags: string[][]): RelayEvent =>
  ({
    id: "e1",
    pubkey: "p",
    kind: 30300,
    created_at: 5,
    tags,
    content: "",
    sig: "",
  }) as unknown as RelayEvent;
const tagged = event([
  ["d", "abc"],
  ["not_before", "100"],
]);
const target = {
  eventId: "m",
  channelId: "c",
  preview: "hi",
  authorPubkey: "a",
};

describe("NIP-ER reminder parsing", () => {
  it("accepts target and note-only reminders in every status", () => {
    expect(parseReminder(tagged, { target, status: "pending" })).toEqual({
      id: "abc",
      eventId: "e1",
      createdAt: 5,
      status: "pending",
      notBefore: 100,
      target,
    });
    expect(
      parseReminder(tagged, { note: "call", status: "pending" })?.note,
    ).toBe("call");
    for (const status of ["done", "cancelled"] as const)
      expect(parseReminder(tagged, { target, status })?.status).toBe(status);
    expect(
      parseReminder(tagged, { target, status: "pending", extra: 1 }),
    ).toBeDefined();
  });

  it("fails closed on off-shape plaintext", () => {
    for (const content of [
      null,
      "text",
      [],
      { target, status: "snoozed" },
      { status: "pending" },
      { note: "", status: "pending" },
      { note: 3, status: "pending" },
      { target: { ...target, eventId: 1 }, status: "pending" },
      { target: { id: "x", a: "y", relays: [] }, status: "pending" },
    ])
      expect(parseReminder(tagged, content)).toBeUndefined();
    expect(
      parseReminder(event([]), { target, status: "pending" }),
    ).toBeUndefined();
  });

  it("mirrors the relay's not_before validator", () => {
    expect(parseNotBefore("1700000000")).toBe(1_700_000_000);
    expect(parseNotBefore("0")).toBe(0);
    for (const raw of [
      "01",
      "1e9",
      "-1",
      "1.5",
      "",
      undefined,
      "9007199254740992",
    ])
      expect(parseNotBefore(raw)).toBeUndefined();
  });
});

const viewer = "v";
const wire = (
  id: string,
  createdAt: number,
  status: string,
  d = "r1",
): RelayEvent =>
  ({
    id,
    pubkey: viewer,
    kind: 30300,
    created_at: createdAt,
    tags: [["d", d]],
    content: JSON.stringify({ target, status }),
    sig: "",
  }) as unknown as RelayEvent;

function harness(history: RelayEvent[] = []) {
  const signed: ReminderIntent[] = [];
  let fail = false;
  let query = () => Promise.resolve(history);
  const model = createReminders({
    viewer,
    signal: new AbortController().signal,
    host: {
      decode: async (events) =>
        events.map((e) => ({ eventId: e.id, content: JSON.parse(e.content) })),
      sign: async (intent) => {
        signed.push(intent);
        return wire(
          `e${signed.length}`,
          intent.createdAt,
          intent.content.status,
          intent.d,
        );
      },
    },
    query: () => query(),
    publish: async () => {
      await Promise.resolve();
      if (fail) {
        fail = false;
        throw new Error("rejected");
      }
    },
  });
  return {
    model,
    signed,
    failNextPublish() {
      fail = true;
    },
    setHistory(events: RelayEvent[]) {
      query = () => Promise.resolve(events);
    },
    head: () =>
      model.capability.snapshot().reminders.find((r) => r.id === "r1"),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reminder writes and reconciliation", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the relay's winner whichever order versions arrive in", async () => {
    for (const order of [
      ["ffff", "0000"],
      ["0000", "ffff"],
    ]) {
      const { model, head } = harness();
      for (const id of order)
        model.receive([wire(id, 100, id === "0000" ? "pending" : "done")]);
      await settle();
      expect(head()).toMatchObject({ eventId: "0000", status: "pending" });
      model.receive([wire("aaaa", 99, "cancelled")]);
      await settle();
      expect(head()?.eventId).toBe("0000");
    }
  });

  it("adopts the relay's equal-time winner on refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 50_000 });
    const h = harness([wire("e0", 40, "pending")]);
    await h.model.capability.refresh();
    await h.model.capability.complete("r1");
    expect(h.head()).toMatchObject({ eventId: "e1", createdAt: 50 });
    h.setHistory([wire("0000", 50, "pending")]);
    await h.model.capability.refresh();
    expect(h.head()).toMatchObject({ eventId: "0000", status: "pending" });
  });

  it("runs overlapping Done and Snooze one after the other", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 100_000 });
    const h = harness([wire("e0", 90, "pending")]);
    await h.model.capability.refresh();
    await Promise.all([
      h.model.capability.complete("r1"),
      h.model.capability.snooze("r1", 500),
    ]);
    expect(h.signed.map((i) => [i.createdAt, i.content.status])).toEqual([
      [100, "done"],
      [101, "pending"],
    ]);
    expect(h.head()).toMatchObject({ createdAt: 101, status: "pending" });
  });

  it("recovers after a failed write", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 100_000 });
    const h = harness([wire("e0", 90, "pending")]);
    await h.model.capability.refresh();
    h.failNextPublish();
    const failed = h.model.capability.complete("r1");
    const after = h.model.capability.snooze("r1", 500);
    await expect(failed).rejects.toThrow("rejected");
    await after;
    expect(h.head()).toMatchObject({ createdAt: 100, status: "pending" });
  });
});
