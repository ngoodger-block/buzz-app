/** One locale/timezone snapshot for all date formatting. Refreshed by app lifecycle, never by rendering. */
function createFormats(locale: string, timeZone: string) {
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone });
  return {
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
    calendar: new Intl.DateTimeFormat("en", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    full: format({ dateStyle: "full", timeStyle: "long" }),
  };
}

let formats = createFormats(...defaults());
const listeners = new Set<() => void>();
let current = { formats, day: calendarDay(Date.now()).key };

function defaults(): [string, string] {
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  return [locale, timeZone];
}

/** Gregorian day in the cached timezone, including during the delay before a settings refresh. */
export function calendarDay(milliseconds: number, calendar = formats.calendar) {
  const parts = calendar.formatToParts(milliseconds);
  const number = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = number("year"),
    month = number("month"),
    day = number("day");
  return {
    key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    ordinal: Date.UTC(year, month - 1, day) / 86_400_000,
  };
}

export function dateEnvironmentSnapshot() {
  return current;
}
export function subscribeDateEnvironment(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function refresh() {
  const [locale, timeZone] = defaults();
  if (locale !== formats.locale || timeZone !== formats.timeZone) {
    formats = createFormats(locale, timeZone);
  }
  const day = calendarDay(Date.now()).key;
  if (formats !== current.formats || day !== current.day) {
    current = { formats, day };
    for (const listener of listeners) listener();
  }
}

/** The app owns one timer and two listeners, independent of which rows are mounted. */
export function startDateEnvironment() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState === "hidden") return;
    const now = new Date();
    const midnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    );
    // Keep exact midnight updates as well as the one-minute settings check.
    timer = setTimeout(
      wake,
      Math.min(60_000, midnight.getTime() - now.getTime()),
    );
  }
  function wake() {
    if (document.visibilityState !== "hidden") refresh();
    schedule();
  }
  refresh();
  schedule();
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", wake);
  };
}
