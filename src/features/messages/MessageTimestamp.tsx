import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  formatDayGroupLabel,
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { useLocalDay } from "../../shared/use-local-day";
import styles from "./Messages.module.css";

// Retain only the current locale/zone pair, never message content. Resolve the
// defaults on each render so a running app still follows OS timezone changes.
let clockFormat:
  | { locale: string; timeZone: string; clock: Intl.DateTimeFormat }
  | undefined;
function clock() {
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  if (clockFormat?.locale !== locale || clockFormat.timeZone !== timeZone)
    clockFormat = {
      locale,
      timeZone,
      clock: new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
    };
  return clockFormat.clock;
}

/** The divider above a day's first row: "Today", "Monday", "June 20, 2025".
 * `data-day` carries the local calendar day. */
export function DayDivider({ createdAt }: { createdAt: number }) {
  useLocalDay();
  const date = new Date(createdAt * 1000);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
  return (
    <div className={styles.day}>
      <span data-day={day}>{formatDayGroupLabel(createdAt)}</span>
    </div>
  );
}

/** One date source for the byline and the compact continuation clock. The
 * byline names the day outside today ("Yesterday at 9:05 AM"): a day divider
 * scrolls away, and surfaces such as Activity have none. The continuation
 * clock sits under a byline, so it shows the time only. */
export function MessageTimestamp({
  createdAt,
  compact = false,
}: {
  createdAt: number;
  compact?: boolean;
}) {
  useLocalDay();
  const date = new Date(createdAt * 1000);
  const label = compact
    ? clock()
        .formatToParts(date)
        .filter((part) => part.type !== "dayPeriod")
        .map((part) => part.value)
        .join("")
        .trim()
    : formatItemTimestamp(createdAt, { withTime: true });
  const fullDate = formatFullTimestamp(createdAt);
  return (
    // The action bar can sit over the byline; keep the date hint non-interactive
    // so it cannot intercept nearby controls when their paint layers overlap.
    <Tooltip content={fullDate} delay={500} disableHoverablePopup>
      <time
        dateTime={date.toISOString()}
        style={{ cursor: "default" }}
        className={compact ? styles.continuationTime : undefined}
      >
        <span aria-hidden="true">{label}</span>
        {/* Engines copy visually hidden text; a selection across rows would
            otherwise repeat every clock as a date the reader never saw. */}
        <span className="sr-only select-none">{fullDate}</span>
      </time>
    </Tooltip>
  );
}
