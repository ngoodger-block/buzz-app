import type { Reminder } from "../../features/relay/reminders";

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A pending reminder whose due time has arrived. */
export const isDue = (reminder: Reminder, now: number) =>
  reminder.status === "pending" &&
  reminder.notBefore !== undefined &&
  reminder.notBefore <= now;

export const countDue = (reminders: readonly Reminder[], now: number) =>
  reminders.filter((reminder) => isDue(reminder, now)).length;

/**
 * Pending reminders that came due in `(watermark, now]`. The strict lower bound
 * keeps reminders already overdue at launch from notifying again.
 */
export const dueSince = (
  reminders: readonly Reminder[],
  watermark: number,
  now: number,
) =>
  reminders.filter(
    (reminder) =>
      reminder.status === "pending" &&
      reminder.notBefore !== undefined &&
      reminder.notBefore > watermark &&
      reminder.notBefore <= now,
  );

/** setTimeout fires at once past 2^31-1 ms, so long delays are re-checked. */
export const MAX_DELAY_MS = 2 ** 31 - 1;

/** Milliseconds until the next pending reminder comes due, capped. */
export function nextDelay(reminders: readonly Reminder[], now: number) {
  let next: number | undefined;
  for (const { status, notBefore } of reminders)
    if (status === "pending" && notBefore !== undefined && notBefore > now)
      next = Math.min(next ?? notBefore, notBefore);
  return next === undefined
    ? undefined
    : Math.min((next - now) * 1000, MAX_DELAY_MS);
}

export const hasPendingReminder = (
  reminders: readonly Reminder[],
  messageId: string,
) =>
  reminders.some(
    (reminder) =>
      reminder.status === "pending" && reminder.target?.eventId === messageId,
  );

export type ReminderGroup = Readonly<{ label: string; reminders: Reminder[] }>;

/** Overdue, Today and Upcoming pending reminders; done and cancelled are hidden. */
export function groupReminders(
  reminders: readonly Reminder[],
  now: number,
  endOfToday: number,
): ReminderGroup[] {
  const groups = { Overdue: [], Today: [], Upcoming: [] } as Record<
    string,
    Reminder[]
  >;
  for (const reminder of reminders) {
    const at = reminder.notBefore;
    if (reminder.status !== "pending" || at === undefined) continue;
    const label =
      at <= now ? "Overdue" : at <= endOfToday ? "Today" : "Upcoming";
    groups[label]?.push(reminder);
  }
  return Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(([label, list]) => ({
      label,
      reminders: list.sort((a, b) => (a.notBefore ?? 0) - (b.notBefore ?? 0)),
    }));
}

export function endOfToday() {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return Math.floor(end.getTime() / 1000);
}

/** The given day offset at 9am local, rolled forward a day if already past. */
function nextDayAt9am(dayOffset: number) {
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + dayOffset);
  target.setHours(9, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return Math.floor(target.getTime() / 1000);
}

export type TimePreset = Readonly<{ label: string; at(): number }>;
export const TIME_PRESETS: readonly TimePreset[] = [
  { label: "In 30 minutes", at: () => nowSeconds() + 30 * 60 },
  { label: "In 1 hour", at: () => nowSeconds() + 60 * 60 },
  { label: "In 3 hours", at: () => nowSeconds() + 3 * 60 * 60 },
  { label: "Tomorrow at 9am", at: () => nextDayAt9am(1) },
  {
    label: "Next Monday at 9am",
    at: () => nextDayAt9am((8 - new Date().getDay()) % 7 || 7),
  },
];

/** Today as local `YYYY-MM-DD`, for the custom date input. */
export function todayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** A strictly future local date and time in unix seconds, or null. */
export function parseCustomDateTime(date: string, time: string) {
  if (!date || !time) return null;
  const at = Math.floor(new Date(`${date}T${time}`).getTime() / 1000);
  return Number.isNaN(at) || at <= nowSeconds() ? null : at;
}

export const formatDue = (at: number) =>
  new Date(at * 1000).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });

/** Beta may store empty target fields; those reminders cannot open a message. */
export const navigableTarget = (reminder: Reminder) =>
  reminder.target?.channelId && reminder.target.eventId
    ? reminder.target
    : undefined;
