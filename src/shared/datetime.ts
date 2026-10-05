/**
 * Relative date labels for messages and day groups, ported from Buzz desktop
 * (`desktop/src/shared/lib/datetime.ts`) so both apps read the same.
 *
 * The ladder follows the Block writing standard for relative dates, with one
 * deliberate deviation noted on `formatDayGroupLabel`. Formats use the default
 * locale and time zone from the shared date environment. Settings checks happen
 * on app lifecycle events and the visible one-minute timer, never here.
 */

import { calendarDay, dateEnvironmentSnapshot } from "./date-environment";

function dateFormats() {
  return dateEnvironmentSnapshot().formats;
}

/** Days in a week, past which the weekday name stops being unambiguous. */
const WEEKDAY_BAND_DAYS = 7;

/**
 * Label for a group of items that share a calendar day, such as a day divider.
 *
 * ```
 * Today            → "Today"
 * Yesterday        → "Yesterday"
 * 2–6 days ago     → "Monday"
 * older, this year → "Saturday, June 20"
 * earlier years    → "June 20, 2025"
 * ```
 *
 * Deliberate deviation from the standard: the standard collapses anything over
 * ten months old to month and year ("Aug 2022"). A group label has to identify
 * its day, so the day is kept and only the year is conditional.
 *
 * The shared day updates at midnight. `nowSeconds` can override it for callers
 * formatting relative to a particular instant.
 */
export function formatDayGroupLabel(
  unixSeconds: number,
  nowSeconds?: number,
): string {
  const date = new Date(unixSeconds * 1_000);
  const dateDay = calendarDay(date.getTime());
  const nowDay =
    nowSeconds === undefined
      ? dateEnvironmentSnapshot().day
      : calendarDay(nowSeconds * 1_000);
  const dayDiff = nowDay.ordinal - dateDay.ordinal;
  const f = dateFormats();
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  // Bounded below too: a future timestamp (clock skew) must not get a weekday
  // that reads as the recent past.
  if (dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS) return f.weekday.format(date);
  return dateDay.year === nowDay.year
    ? f.weekdayMonthDay.format(date)
    : f.monthDayYear.format(date);
}

/**
 * Label for one item's timestamp, such as a message byline or a list row.
 *
 * ```
 * withTime: false (narrow rows)   withTime: true (roomy rows)
 * Today   → "2:34 PM"             Today   → "2:34 PM"
 * Yest.   → "Yesterday"           Yest.   → "Yesterday at 2:34 PM"
 * 2–6d    → "Monday"              2–6d    → "Monday at 2:34 PM"
 * year    → "Sat, Jun 20"         year    → "Sat, Jun 20 at 2:34 PM"
 * older   → "Jun 20, 2025"        older   → "Jun 20, 2025 at 2:34 PM"
 * ```
 *
 * Today needs no date word: a bare clock time already reads as today.
 * `withTime` is a surface decision: pass `true` where people read
 * conversation, and `false` in a narrow list row with the full date a hover
 * away.
 */
export function formatItemTimestamp(
  unixSeconds: number,
  {
    withTime = false,
    nowSeconds,
  }: { withTime?: boolean; nowSeconds?: number } = {},
): string {
  const date = new Date(unixSeconds * 1_000);
  const dateDay = calendarDay(date.getTime());
  const nowDay =
    nowSeconds === undefined
      ? dateEnvironmentSnapshot().day
      : calendarDay(nowSeconds * 1_000);
  const dayDiff = nowDay.ordinal - dateDay.ordinal;
  const f = dateFormats();
  const time = f.time.format(date);
  if (dayDiff === 0) return time;
  const dayLabel =
    dayDiff === 1
      ? "Yesterday"
      : dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS
        ? f.weekday.format(date)
        : dateDay.year === nowDay.year
          ? f.shortWeekdayMonthDay.format(date)
          : f.shortMonthDayYear.format(date);
  return withTime ? `${dayLabel} at ${time}` : dayLabel;
}

/** The complete date and time, such as a timestamp's hover text:
 * "Friday, October 2, 2026 at 3:05:09 PM EDT". */
export function formatFullTimestamp(unixSeconds: number): string {
  return dateFormats().full.format(new Date(unixSeconds * 1_000));
}

/** A continuation row's clock, without the day period; uses the same settings as its full date. */
export function formatCompactTime(unixSeconds: number): string {
  return dateFormats()
    .time.formatToParts(unixSeconds * 1_000)
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
}
