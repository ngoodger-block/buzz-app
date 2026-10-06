// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Reminder, Reminders } from "../../features/relay/reminders";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { RemindersPage } from "./RemindersPage";

afterEach(cleanup);

const viewer = "v";
const now = 1_000_000;
const reminder = (
  id: string,
  status: Reminder["status"],
  createdAt: number,
  notBefore?: number,
): Reminder => ({
  id,
  eventId: `${id}-event`,
  createdAt,
  status,
  ...(notBefore !== undefined ? { notBefore } : {}),
  target: {
    eventId: `${id}-message`,
    channelId: "c",
    preview: id,
    authorPubkey: "a",
  },
});

it("lists finished reminders newest first in a Done group with only Open", () => {
  const state = {
    status: "ready" as const,
    reminders: [
      reminder("overdue item", "pending", 1, now - 60),
      reminder("older done", "done", 10),
      reminder("newer done", "done", 20),
      reminder("cancelled item", "cancelled", 30),
    ],
  };
  const reminders = {
    snapshot: () => state,
    subscribe: () => () => {},
    complete: vi.fn(),
  } as unknown as Reminders;
  const connection = {
    status: "ready",
    scope: `https://community:${viewer}`,
    viewer,
    session: { reminders },
  };
  const relay = {
    snapshot: () => connection,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const open = vi.fn(() => Promise.resolve({ status: "opened" }));
  render(
    <RemindersPage
      relay={relay}
      navigator={{ open } as unknown as Navigation}
      clock={{ subscribe: () => () => {}, read: () => now }}
    />,
  );
  const labels = screen
    .getAllByRole("heading", { level: 2 })
    .map((h) => h.textContent);
  expect(labels.at(-1)).toBe("Done");
  const done = screen.getByRole("region", { name: "Done" });
  expect(
    within(done)
      .getAllByRole("listitem")
      .map((row) => row.querySelector("p")?.textContent),
  ).toEqual(["newer done", "older done"]);
  expect(
    within(done)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["Open", "Open"]);
  expect(screen.queryByText("cancelled item")).toBeNull();
  fireEvent.click(
    within(done).getAllByRole("button", { name: "Open" })[0] as HTMLElement,
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "newer done-message" }),
  );
});
