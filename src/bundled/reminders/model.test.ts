import { describe, expect, it } from "vitest";
import type { Reminder } from "../../features/relay/reminders";
import {
  MAX_DELAY_MS,
  TIME_PRESETS,
  countDue,
  dueSince,
  groupReminders,
  hasPendingReminder,
  isDue,
  navigableTarget,
  nextDelay,
  nowSeconds,
  parseCustomDateTime,
  todayDateString,
} from "./model";

const reminder = ({
  id = "r",
  notBefore,
  status = "pending",
  target,
}: Partial<Reminder>): Reminder => ({
  id,
  eventId: `${id}-evt`,
  createdAt: 0,
  status,
  ...(notBefore !== undefined ? { notBefore } : {}),
  ...(target ? { target } : {}),
});
const NOW = 1000;
const target = (eventId = "e", channelId = "c") => ({
  eventId,
  channelId,
  preview: "hi",
  authorPubkey: "a",
});

describe("due reminders", () => {
  it("counts only pending reminders at or before now", () => {
    expect(isDue(reminder({ notBefore: NOW }), NOW)).toBe(true);
    expect(isDue(reminder({ notBefore: NOW + 1 }), NOW)).toBe(false);
    expect(isDue(reminder({ notBefore: NOW - 1, status: "done" }), NOW)).toBe(
      false,
    );
    expect(isDue(reminder({}), NOW)).toBe(false);
    const list = [
      reminder({ id: "a", notBefore: NOW - 1 }),
      reminder({ id: "b", notBefore: NOW }),
      reminder({ id: "c", notBefore: NOW + 1 }),
      reminder({ id: "d", notBefore: NOW - 1, status: "done" }),
      reminder({ id: "e", notBefore: NOW - 1, status: "cancelled" }),
    ];
    expect(countDue(list, NOW)).toBe(2);
    expect(countDue([], NOW)).toBe(0);
  });

  it("notifies only reminders that crossed (watermark, now]", () => {
    const list = [
      reminder({ id: "at-watermark", notBefore: 900 }),
      reminder({ id: "inside", notBefore: 950 }),
      reminder({ id: "at-now", notBefore: NOW }),
      reminder({ id: "future", notBefore: NOW + 1 }),
      reminder({ id: "done", notBefore: 950, status: "done" }),
      reminder({ id: "cancelled", notBefore: 950, status: "cancelled" }),
      reminder({ id: "undated" }),
    ];
    expect(dueSince(list, 900, NOW).map((r) => r.id)).toEqual([
      "inside",
      "at-now",
    ]);
    expect(dueSince(list, NOW, NOW)).toEqual([]);
  });

  it("schedules the next pending due time and caps long delays", () => {
    expect(
      nextDelay(
        [
          reminder({ id: "a", notBefore: NOW + 30 }),
          reminder({ id: "b", notBefore: NOW + 10 }),
          reminder({ id: "c", notBefore: NOW + 5, status: "done" }),
          reminder({ id: "d", notBefore: NOW - 5 }),
        ],
        NOW,
      ),
    ).toBe(10_000);
    expect(nextDelay([reminder({ notBefore: NOW + 60 * 86_400 })], NOW)).toBe(
      MAX_DELAY_MS,
    );
    expect(nextDelay([reminder({ notBefore: NOW - 1 })], NOW)).toBeUndefined();
  });
});

describe("reminder grouping", () => {
  it("buckets pending reminders, lists done newest first and hides cancelled", () => {
    const groups = groupReminders(
      [
        reminder({ id: "later", notBefore: 3000 }),
        reminder({ id: "zero", notBefore: 0 }),
        reminder({ id: "overdue", notBefore: 500 }),
        reminder({ id: "today", notBefore: 1500 }),
        { ...reminder({ id: "done", status: "done" }), createdAt: 1 },
        { ...reminder({ id: "done-later", status: "done" }), createdAt: 2 },
        reminder({ id: "cancelled", notBefore: 1500, status: "cancelled" }),
      ],
      NOW,
      2000,
    );
    expect(groups.map((g) => [g.label, g.reminders.map((r) => r.id)])).toEqual([
      ["Overdue", ["zero", "overdue"]],
      ["Today", ["today"]],
      ["Upcoming", ["later"]],
      ["Done", ["done-later", "done"]],
    ]);
    expect(
      groupReminders([reminder({ notBefore: 3000 })], NOW, 2000).map(
        (g) => g.label,
      ),
    ).toEqual(["Upcoming"]);
    expect(groupReminders([], NOW, 2000)).toEqual([]);
  });
});

describe("reminder targets", () => {
  it("opens only targets with a channel and message", () => {
    expect(navigableTarget(reminder({ target: target() }))).toEqual(target());
    expect(navigableTarget(reminder({}))).toBeUndefined();
    expect(
      navigableTarget(reminder({ target: target("e", "") })),
    ).toBeUndefined();
    expect(
      navigableTarget(reminder({ target: target("", "c") })),
    ).toBeUndefined();
  });

  it("marks a message only while its reminder is pending", () => {
    expect(hasPendingReminder([reminder({ target: target("m") })], "m")).toBe(
      true,
    );
    expect(
      hasPendingReminder(
        [reminder({ target: target("m"), status: "done" })],
        "m",
      ),
    ).toBe(false);
    expect(hasPendingReminder([reminder({ target: target("x") })], "m")).toBe(
      false,
    );
  });
});

describe("time presets", () => {
  it("returns strictly future times matching their labels", () => {
    const before = nowSeconds();
    const at = Object.fromEntries(TIME_PRESETS.map((p) => [p.label, p.at()]));
    for (const value of Object.values(at))
      expect(value).toBeGreaterThan(before);
    expect(
      Math.abs((at["In 30 minutes"] ?? 0) - (before + 1800)),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs((at["In 1 hour"] ?? 0) - (before + 3600)),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs((at["In 3 hours"] ?? 0) - (before + 10_800)),
    ).toBeLessThanOrEqual(2);
    for (const label of ["Tomorrow at 9am", "Next Monday at 9am"]) {
      const date = new Date((at[label] ?? 0) * 1000);
      expect([date.getHours(), date.getMinutes()]).toEqual([9, 0]);
    }
    expect(new Date((at["Next Monday at 9am"] ?? 0) * 1000).getDay()).toBe(1);
  });

  it("accepts only well-formed future custom times", () => {
    const day = (offset: number) => {
      const d = new Date(Date.now() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    expect(parseCustomDateTime(day(86_400_000), "14:30")).toBeGreaterThan(
      nowSeconds(),
    );
    expect(parseCustomDateTime(day(-365 * 86_400_000), "09:00")).toBeNull();
    expect(parseCustomDateTime("", "09:00")).toBeNull();
    expect(parseCustomDateTime("2099-01-01", "")).toBeNull();
    expect(parseCustomDateTime("not-a-date", "09:00")).toBeNull();
    expect(parseCustomDateTime("2099-01-01", "99:99")).toBeNull();
    expect(todayDateString()).toBe(day(0));
  });
});
