import { expect, it, vi } from "vitest";
import { calendarDay } from "./date-environment";

it("bounds retained calendar work without changing evicted results", () => {
  const calendar = new Intl.DateTimeFormat("en", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const first = Date.parse("2026-09-24T06:59:00Z");
  expect(calendarDay(first, calendar).key).toBe("2026-09-23");
  // More timestamps than the retained-history budget: older entries may be
  // recomputed, but history growth must not grow the cache indefinitely.
  for (let i = 1; i <= 2048; i++) calendarDay(first + i * 1000, calendar);
  const work = vi.spyOn(calendar, "formatToParts");
  expect(calendarDay(first, calendar).key).toBe("2026-09-23");
  expect(work).toHaveBeenCalledTimes(1);
  expect(calendarDay(first + 120_000, calendar).key).toBe("2026-09-24");
  work.mockRestore();
});
