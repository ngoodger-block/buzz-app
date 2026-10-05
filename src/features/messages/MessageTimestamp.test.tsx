// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  dateEnvironmentSnapshot,
  subscribeDateEnvironment,
  startDateEnvironment,
} from "../../shared/date-environment";
import {
  formatCompactTime,
  formatDayGroupLabel,
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { continuesMessageGroup } from "./message-grouping";
import type { ChannelMessage } from "../relay/contracts";
import { DayDivider, MessageTimestamp } from "./MessageTimestamp";

let stopDateEnvironment: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 24, 12));
  stopDateEnvironment = startDateEnvironment();
});
afterEach(() => {
  cleanup();
  stopDateEnvironment();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each([
  [new Date(2026, 8, 24, 9, 5), "9:05 AM"],
  [new Date(2026, 8, 23, 9, 5), "Yesterday at 9:05 AM"],
  [new Date(2026, 8, 21, 9, 5), "Monday at 9:05 AM"],
  [new Date(2026, 8, 17, 9, 5), "Thu, Sep 17 at 9:05 AM"],
  [new Date(2025, 8, 17, 9, 5), "Sep 17, 2025 at 9:05 AM"],
])(
  "names the day outside today for %s while retaining the full accessible date",
  (date, label) => {
    const { container } = render(
      <MessageTimestamp createdAt={date.getTime() / 1000} />,
    );
    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      date.toISOString(),
    );
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      new RegExp(`^${label}$`),
    );
    expect(
      screen.getByText(
        date.toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "long",
        }),
      ),
    ).toHaveClass("sr-only");
  },
);
it("keeps the continuation clock compact without dropping its accessible date", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} compact />,
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    /^9:05$/,
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent("2026");
});

it.each([false, true])(
  "refreshes quiet timestamps on minute/focus/visibility signals (compact=%s)",
  (compact) => {
    const NativeFormat = Intl.DateTimeFormat;
    let locale = "en-GB",
      timeZone = "UTC";
    const formatConstructor = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(function dateTimeFormat(requestedLocale, options) {
        return new NativeFormat(requestedLocale ?? locale, {
          timeZone,
          ...options,
        });
      });
    act(() => window.dispatchEvent(new Event("focus")));
    const createdAt = Date.parse("2026-09-24T09:05:00Z") / 1000;
    const { container, rerender } = render(
      <MessageTimestamp createdAt={createdAt} compact={compact} />,
    );
    const visible = () =>
      container.querySelector('time [aria-hidden="true"]')?.textContent;
    const full = () => container.querySelector(".sr-only")?.textContent;
    expect(visible()).toBe("9:05");
    expect(full()).toContain("Thursday, 24 September 2026");
    // Formatting and further renders must neither probe settings nor rebuild formatters.
    formatConstructor.mockClear();
    for (let i = 0; i < 100; i++) {
      formatItemTimestamp(createdAt + i);
      formatFullTimestamp(createdAt + i);
      formatCompactTime(createdAt + i);
    }
    rerender(<MessageTimestamp createdAt={createdAt} compact={compact} />);
    expect(formatConstructor).not.toHaveBeenCalled();
    timeZone = "America/Los_Angeles";
    act(() => vi.advanceTimersByTime(59_999));
    expect(visible()).toBe("9:05");
    expect(formatConstructor).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(visible()).toBe("2:05");
    expect(full()).toContain("GMT-7");
    locale = "de-DE";
    act(() => window.dispatchEvent(new Event("focus")));
    expect(full()).toContain("Donnerstag");
    formatConstructor.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    locale = "en-US";
    timeZone = "UTC";
    act(() => vi.advanceTimersByTime(180_000));
    expect(formatConstructor).not.toHaveBeenCalled();
    expect(full()).toContain("Donnerstag");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(visible()).toBe(compact ? "9:05" : "9:05 AM");
    expect(full()).toContain("Thursday, September 24, 2026");
  },
);
it("updates the visible clock, accessible date and datetime when a mounted row changes", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container, rerender } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  date.setDate(date.getDate() + 1);
  date.setHours(17);
  rerender(<MessageTimestamp createdAt={date.getTime() / 1000} compact />);
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    date.toISOString(),
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent(
    date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      .formatToParts(date)
      .filter((part) => part.type !== "dayPeriod")
      .map((part) => part.value)
      .join("")
      .trim(),
  );
});
it.each([
  [new Date(2026, 8, 24, 0, 1), "2026-09-24", "Today"],
  [new Date(2026, 8, 23, 23, 59), "2026-09-23", "Yesterday"],
  [new Date(2026, 8, 21, 9, 5), "2026-09-21", "Monday"],
  [new Date(2026, 8, 17, 9, 5), "2026-09-17", "Thursday, September 17"],
  [new Date(2025, 8, 17, 9, 5), "2025-09-17", "September 17, 2025"],
])(
  "the day divider for %s names its local day like plugins' dayGroupLabel",
  (date, day, label) => {
    const { container } = render(
      <DayDivider createdAt={date.getTime() / 1000} />,
    );
    expect(container.querySelector(`[data-day="${day}"]`)).toHaveTextContent(
      new RegExp(`^${label}$`),
    );
  },
);

// Rows are memoized and a quiet conversation never re-renders them, so the
// labels must follow the local day on their own.
const QuietRow = memo(function QuietRow({ createdAt }: { createdAt: number }) {
  return (
    <>
      <DayDivider createdAt={createdAt} />
      <MessageTimestamp createdAt={createdAt} />
    </>
  );
});
function renderQuietRow() {
  vi.setSystemTime(new Date(2026, 8, 24, 23, 59, 30));
  stopDateEnvironment();
  stopDateEnvironment = startDateEnvironment();
  const createdAt = new Date(2026, 8, 24, 9, 5).getTime() / 1000;
  const { container } = render(<QuietRow createdAt={createdAt} />);
  const divider = () => container.querySelector("[data-day]");
  const byline = () => container.querySelector('time [aria-hidden="true"]');
  expect(divider()).toHaveTextContent(/^Today$/);
  expect(byline()).toHaveTextContent(/^9:05 AM$/);
  return { divider, byline };
}

it("relabels a mounted quiet row at local midnight", () => {
  const { divider, byline } = renderQuietRow();
  act(() => vi.advanceTimersByTime(30_000));
  expect(divider()).toHaveTextContent(/^Yesterday$/);
  expect(byline()).toHaveTextContent(/^Yesterday at 9:05 AM$/);
});

it("relabels a mounted quiet row when the window wakes after midnight", () => {
  const { divider, byline } = renderQuietRow();
  // Sleep: the clock moves on but the midnight timer has not fired yet.
  vi.setSystemTime(new Date(2026, 8, 26, 8));
  expect(divider()).toHaveTextContent(/^Today$/);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(divider()).toHaveTextContent(/^Thursday$/);
  expect(byline()).toHaveTextContent(/^Thursday at 9:05 AM$/);
});

it("keeps a stable snapshot on unchanged checks and releases the app's timer/listeners", () => {
  const snapshot = dateEnvironmentSnapshot();
  const changed = vi.fn();
  const unsubscribe = subscribeDateEnvironment(changed);
  const probe = vi.spyOn(Intl, "DateTimeFormat");
  act(() => vi.advanceTimersByTime(60_000));
  expect(dateEnvironmentSnapshot()).toBe(snapshot);
  expect(changed).not.toHaveBeenCalled();
  expect(probe).toHaveBeenCalledTimes(1);
  stopDateEnvironment();
  probe.mockClear();
  act(() => {
    vi.advanceTimersByTime(180_000);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(probe).not.toHaveBeenCalled();
  unsubscribe();
});

it.each([
  ["2026-03-08T23:30:00-04:00", "2026-03-07T23:45:00-05:00"],
  ["2026-11-01T23:30:00-05:00", "2026-10-31T23:45:00-04:00"],
  ["2027-01-01T00:30:00-05:00", "2026-12-31T23:45:00-05:00"],
])(
  "uses the cached calendar zone across DST/year boundaries at %s",
  (now, previous) => {
    const NativeFormat = Intl.DateTimeFormat;
    let timeZone = "America/New_York";
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function dateTimeFormat(locale, options) {
        return new NativeFormat(locale ?? "en-US", { timeZone, ...options });
      },
    );
    act(() => window.dispatchEvent(new Event("focus")));
    const nowSeconds = Date.parse(now) / 1000;
    const unixSeconds = Date.parse(previous) / 1000;
    expect(formatDayGroupLabel(unixSeconds, nowSeconds)).toBe("Yesterday");
    // Runtime defaults can change before the next scheduled check. Both the
    // calendar decision and clock must keep using the published timezone.
    timeZone = "UTC";
    expect(formatDayGroupLabel(unixSeconds, nowSeconds)).toBe("Yesterday");
    expect(formatCompactTime(unixSeconds)).toBe("11:45");
  },
);

it("keeps grouping and day labels on the same cached zone until refresh", () => {
  const NativeFormat = Intl.DateTimeFormat;
  let timeZone = "America/Los_Angeles";
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
    function dateTimeFormat(locale, options) {
      return new NativeFormat(locale ?? "en-US", { timeZone, ...options });
    },
  );
  act(() => window.dispatchEvent(new Event("focus")));
  const first: ChannelMessage = {
    id: "first",
    channelId: "channel",
    authorId: "author",
    content: "Hello",
    createdAt: Date.parse("2026-09-24T06:59:00Z") / 1000,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const second = { ...first, id: "second", createdAt: first.createdAt + 120 };
  const { container } = render(
    <>
      <DayDivider createdAt={first.createdAt} />
      <DayDivider createdAt={second.createdAt} />
    </>,
  );
  const days = () =>
    [...container.querySelectorAll("[data-day]")].map((el) =>
      el.getAttribute("data-day"),
    );
  expect(continuesMessageGroup(first, second)).toBe(false);
  expect(days()).toEqual(["2026-09-23", "2026-09-24"]);
  timeZone = "UTC";
  expect(continuesMessageGroup(first, second)).toBe(false);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(continuesMessageGroup(first, second)).toBe(true);
  expect(days()).toEqual(["2026-09-24", "2026-09-24"]);
});
