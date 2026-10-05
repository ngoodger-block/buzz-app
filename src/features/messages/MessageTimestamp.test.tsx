// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DayDivider, MessageTimestamp } from "./MessageTimestamp";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 24, 12));
});
afterEach(() => {
  cleanup();
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
  "refreshes cached styles after yielding when locale or timezone changes (compact=%s)",
  async (compact) => {
    const NativeFormat = Intl.DateTimeFormat;
    let locale = "en-GB";
    let timeZone = "Europe/London";
    function dateTimeFormat(
      requestedLocale?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new NativeFormat(requestedLocale ?? locale, {
        timeZone,
        ...options,
      });
    }
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(dateTimeFormat);
    const date = new Date("2026-09-24T09:05:00Z");
    const { container, rerender } = render(
      <MessageTimestamp createdAt={date.getTime() / 1000} compact={compact} />,
    );
    const assertDate = () => {
      expect(container.querySelector(".sr-only")).toHaveTextContent(
        new NativeFormat(locale, {
          timeZone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(date),
      );
      const clock = new NativeFormat(locale, {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      });
      expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
        compact
          ? clock
              .formatToParts(date)
              .filter((part) => part.type !== "dayPeriod")
              .map((part) => part.value)
              .join("")
              .trim()
          : clock.format(date),
      );
    };
    assertDate();
    await Promise.resolve();
    timeZone = "America/Los_Angeles";
    rerender(
      <MessageTimestamp createdAt={date.getTime() / 1000} compact={compact} />,
    );
    assertDate();
    await Promise.resolve();
    locale = "de-DE";
    rerender(
      <MessageTimestamp createdAt={date.getTime() / 1000} compact={compact} />,
    );
    assertDate();
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
  vi.setSystemTime(new Date(2026, 8, 24, 23, 59));
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
  act(() => vi.advanceTimersByTime(60_000));
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
