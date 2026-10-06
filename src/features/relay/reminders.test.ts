import { describe, expect, it } from "vitest";
import type { RelayEvent } from "./events";
import { parseNotBefore, parseReminder } from "./reminders";

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
