/**
 * Relative date labels for messages and day groups, ported from Buzz desktop
 * (`desktop/src/shared/lib/datetime.ts`) so both apps read the same.
 *
 * The ladder follows the Block writing standard for relative dates, with one
 * deliberate deviation noted on `formatDayGroupLabel`. Formats use the default
 * locale and time zone, checked again after yielding, so a running app follows
 * OS changes without resolving the defaults for every row in one render batch.
 */

let defaultsChecked = false;
let formats:
  | {
      locale: string;
      timeZone: string;
      weekday: Intl.DateTimeFormat;
      weekdayMonthDay: Intl.DateTimeFormat;
      monthDayYear: Intl.DateTimeFormat;
      shortWeekdayMonthDay: Intl.DateTimeFormat;
      shortMonthDayYear: Intl.DateTimeFormat;
      time: Intl.DateTimeFormat;
      full: Intl.DateTimeFormat;
    }
  | undefined;
function dateFormats() {
  if (defaultsChecked && formats) return formats;
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  if (formats?.locale !== locale || formats.timeZone !== timeZone) {
    const format = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, options);
    formats = {
      locale,
      timeZone,
      weekday: format({ weekday: "long" }),
      weekdayMonthDay: format({
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
      monthDayYear: format({ month: "long", day: "numeric", year: "numeric" }),
      shortWeekdayMonthDay: format({
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      shortMonthDayYear: format({
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
      time: format({ hour: "numeric", minute: "2-digit" }),
      full: format({ dateStyle: "full", timeStyle: "long" }),
    };
  }
  defaultsChecked = true;
  queueMicrotask(() => {
    defaultsChecked = false;
  });
  return formats;
}

type TimestampStrings = Partial<
  Record<
    "group" | "item" | "itemWithTime" | "compact" | "full",
    string | undefined
  >
> & { day?: number };
const MAX_CACHED_TIMESTAMPS = 2048;
const strings = new Map<number, TimestampStrings>();
let stringFormats: ReturnType<typeof dateFormats> | undefined;

/** Preserve labels across remounts, while keeping settings checks owned by dateFormats. */
function timestampStrings(
  unixSeconds: number,
  f: ReturnType<typeof dateFormats>,
  now?: Date,
): TimestampStrings {
  if (f !== stringFormats) {
    strings.clear();
    stringFormats = f;
  }
  let cached = strings.get(unixSeconds);
  if (!cached) {
    if (strings.size >= MAX_CACHED_TIMESTAMPS) {
      const oldest = strings.keys().next().value;
      if (oldest !== undefined) strings.delete(oldest);
    }
    cached = {};
    strings.set(unixSeconds, cached);
  }
  if (now) {
    const day = startOfLocalDay(now).getTime();
    if (day !== cached.day) {
      cached.day = day;
      cached.group = undefined;
      cached.item = undefined;
      cached.itemWithTime = undefined;
    }
  }
  return cached;
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
 * `nowSeconds` stays a parameter, not a captured constant: a label rendered
 * before midnight has to say "Yesterday" once the day rolls over.
 */
export function formatDayGroupLabel(
  unixSeconds: number,
  nowSeconds?: number,
): string {
  const now = new Date((nowSeconds ?? Date.now() / 1_000) * 1_000);
  const f = dateFormats();
  const cached =
    nowSeconds === undefined
      ? timestampStrings(unixSeconds, f, now)
      : undefined;
  if (cached?.group !== undefined) return cached.group;
  const date = new Date(unixSeconds * 1_000);
  const dayDiff = calendarDaysBetween(now, date);
  // Bounded below too: a future timestamp (clock skew) must not get a weekday
  // that reads as the recent past.
  const label =
    dayDiff === 0
      ? "Today"
      : dayDiff === 1
        ? "Yesterday"
        : dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS
          ? f.weekday.format(date)
          : date.getFullYear() === now.getFullYear()
            ? f.weekdayMonthDay.format(date)
            : f.monthDayYear.format(date);
  if (cached) cached.group = label;
  return label;
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
  const now = new Date((nowSeconds ?? Date.now() / 1_000) * 1_000);
  const f = dateFormats();
  const cached =
    nowSeconds === undefined
      ? timestampStrings(unixSeconds, f, now)
      : undefined;
  const variant = withTime ? "itemWithTime" : "item";
  if (cached?.[variant] !== undefined) return cached[variant];
  const date = new Date(unixSeconds * 1_000);
  const dayDiff = calendarDaysBetween(now, date);
  const time = f.time.format(date);
  if (dayDiff === 0) {
    if (cached) cached[variant] = time;
    return time;
  }
  const dayLabel =
    dayDiff === 1
      ? "Yesterday"
      : dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS
        ? f.weekday.format(date)
        : date.getFullYear() === now.getFullYear()
          ? f.shortWeekdayMonthDay.format(date)
          : f.shortMonthDayYear.format(date);
  const label = withTime ? `${dayLabel} at ${time}` : dayLabel;
  if (cached) cached[variant] = label;
  return label;
}

/** The complete date and time, such as a timestamp's hover text:
 * "Friday, October 2, 2026 at 3:05:09 PM EDT". */
export function formatFullTimestamp(unixSeconds: number): string {
  const f = dateFormats();
  const cached = timestampStrings(unixSeconds, f);
  cached.full ??= f.full.format(unixSeconds * 1_000);
  return cached.full;
}

/** A continuation clock without the day period, using the same settings as its full date. */
export function formatCompactTime(unixSeconds: number): string {
  const f = dateFormats();
  const cached = timestampStrings(unixSeconds, f);
  cached.compact ??= f.time
    .formatToParts(unixSeconds * 1_000)
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
  return cached.compact;
}

/** Local midnight of the calendar day containing `date`. */
function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole calendar days from `date` to `now`, in local time. Rounded, so a
 * 23- or 25-hour DST day still counts as one day. */
function calendarDaysBetween(now: Date, date: Date): number {
  return Math.round(
    (startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime()) /
      86_400_000,
  );
}
