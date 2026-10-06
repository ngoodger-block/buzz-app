// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../../features/relay/events";
import {
  createReminders,
  type Reminder,
  type Reminders,
} from "../../features/relay/reminders";
import type { RelayData } from "../../features/relay/service";
import type { Navigation } from "../../features/navigation/controller";
import { RemindersPage } from "./RemindersPage";
import { apply } from "./index";

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

it("recovers a failed first history read through Retry, then notifies", async () => {
  vi.useFakeTimers({ now: now * 1000 });
  try {
    const live = {
      id: "live",
      pubkey: viewer,
      kind: 30300,
      created_at: now,
      tags: [
        ["d", "live"],
        ["not_before", String(now + 3)],
      ],
      content: JSON.stringify({ note: "stand-up", status: "pending" }),
      sig: "",
    } as unknown as RelayEvent;
    const query = vi
      .fn<() => Promise<RelayEvent[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([]);
    const model = createReminders({
      viewer,
      signal: new AbortController().signal,
      host: {
        decode: async (events) =>
          events.map((e) => ({
            eventId: e.id,
            content: JSON.parse(e.content),
          })),
        sign: vi.fn(),
      },
      query,
      publish: async () => {},
    });
    const connection = {
      status: "ready",
      scope: `https://community.example:${viewer}`,
      viewer,
      session: { reminders: model.capability },
    };
    const submit = vi.fn(() => Promise.resolve());
    let Page: () => ReactNode = () => null;
    apply({
      relay: { snapshot: () => connection, subscribe: () => () => {} },
      notifications: { register: () => ({ submit }) },
      pages: {
        register: (page: { component: () => ReactNode }) => {
          Page = page.component;
        },
      },
      navigation: {},
      conversation: { registerMessageAction: vi.fn() },
      effect: (body: () => void) => body(),
    } as unknown as Parameters<typeof apply>[0]);
    render(<Page />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const retry = screen.getByRole("button", { name: "Retry reminders" });
    act(() => model.receive([live]));
    await act(() => vi.advanceTimersByTimeAsync(0));
    // The live arrival fills the list, but history is still incomplete.
    expect(screen.getByText("stand-up")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some reminders could not be loaded.",
    );
    fireEvent.click(retry);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(query).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sourceKey: `live:${now + 3}` }),
    );
  } finally {
    vi.useRealTimers();
  }
});
