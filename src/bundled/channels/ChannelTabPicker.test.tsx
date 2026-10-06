// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelTabPicker, isChannelTabTool } from "./ChannelTabPicker";
import type { RegisteredPanel } from "../../features/panels/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  pickerText,
  readSearchUsage,
  recordChoice,
  recordVisit,
} from "../../features/search/usage";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const scope = `https://relay.example:${"f".repeat(64)}`;
const tool: RegisteredPanel = {
  id: "todos",
  pluginId: "buzz.todos",
  key: "buzz.todos/todos",
  revision: "1",
  title: "Todos",
  matches: () => false,
  channelLauncher: () => null,
  component: () => null,
};
const channels = [
  { id: "alpha", name: "Alpha", channelType: "channel" },
  { id: "dm", name: "Ada", channelType: "dm" },
] as ChannelSummary[];
it("filters by category and query and opens only the chosen registered tool", async () => {
  const user = userEvent.setup(),
    choose = vi.fn(),
    chooseTool = vi.fn();
  const view = render(
    <ChannelTabPicker
      channels={channels}
      tools={[tool]}
      icon={() => null}
      choose={choose}
      chooseTool={chooseTool}
    />,
  );
  expect(screen.getByRole("searchbox")).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Ada" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "DMs" }));
  expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
  await user.type(screen.getByRole("searchbox"), "no match");
  expect(screen.getByRole("status")).toHaveTextContent("No matches");
  await user.clear(screen.getByRole("searchbox"));
  await user.click(screen.getByRole("button", { name: "Ada" }));
  expect(choose).toHaveBeenCalledExactlyOnceWith("dm");
  await user.click(screen.getByRole("tab", { name: "Tools" }));
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(
    within(screen.getByRole("tablist")).getByRole("tab", {
      name: "Tools",
    }),
  ).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("button", { name: "Todos" }));
  expect(chooseTool).toHaveBeenCalledExactlyOnceWith(tool);
  view.rerender(
    <ChannelTabPicker
      channels={channels}
      tools={[]}
      icon={() => null}
      choose={choose}
      chooseTool={chooseTool}
    />,
  );
  expect(screen.queryByRole("button", { name: "Todos" })).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("No channel tools");
});
it("switches categories with the keyboard and labels the active panel", async () => {
  const user = userEvent.setup();
  render(
    <ChannelTabPicker
      channels={channels}
      tools={[tool]}
      icon={() => null}
      choose={vi.fn()}
      chooseTool={vi.fn()}
    />,
  );
  await user.tab({ shift: true });
  expect(screen.getByRole("tab", { name: "Channels" })).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("tab", { name: "DMs" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("tabpanel", { name: "DMs" })).toContainElement(
    screen.getByRole("button", { name: "Ada" }),
  );
  await user.keyboard("{ArrowRight}");
  await user.keyboard("{Enter}");
  expect(screen.getByRole("tabpanel", { name: "Tools" })).toContainElement(
    screen.getByRole("button", { name: "Todos" }),
  );
});
it("accepts only the current supported channel tool contributions", () => {
  expect(isChannelTabTool(tool)).toBe(true);
  expect(isChannelTabTool({ ...tool, pluginId: "other" })).toBe(false);
  expect(
    isChannelTabTool({ ...tool, id: "terminal", pluginId: "buzz.terminal" }),
  ).toBe(true);
  const { channelLauncher: _, ...withoutLauncher } = tool;
  expect(isChannelTabTool(withoutLauncher)).toBe(false);
});
it("orders matches like Command-K, underlines them and opens the highlighted one with Enter", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const user = userEvent.setup(),
    choose = vi.fn();
  const named = (id: string, name: string) =>
    ({ id, name, channelType: "stream" }) as ChannelSummary;
  const list = [
    named("deploys", "deploys"),
    named("prs", "buzz-github-prs"),
    named("bugs", "bugs"),
    named("bug", "bug"),
    named("debug", "debug-log"),
    named("mine", "my-bugs"),
  ];
  for (let visit = 0; visit < 20; visit++) recordVisit(scope, "channel:debug");
  // Command-K's choice for the same text belongs to Command-K: it would put
  // debug-log right after the exact name here.
  recordChoice(scope, "bug", "channel:debug");
  render(
    <ChannelTabPicker
      channels={list}
      tools={[]}
      icon={() => null}
      choose={choose}
      chooseTool={vi.fn()}
      usageScope={scope}
    />,
  );
  const names = () =>
    screen
      .getAllByRole("button")
      .filter((row) => !row.hasAttribute("aria-label"))
      .map((row) => row.textContent);
  // Before typing, the list keeps its own order.
  expect(names()).toEqual(list.map(({ name }) => name));
  const search = screen.getByRole("searchbox");
  // An exact name, then a prefix. Usage lifts a substring past a slightly
  // better word start, never past a much better prefix. Fuzzy comes last.
  await user.type(search, "bug");
  expect(names()).toEqual([
    "bug",
    "bugs",
    "debug-log",
    "my-bugs",
    "buzz-github-prs",
  ]);
  expect(screen.getByRole("status")).toHaveTextContent(
    "bug. Press Enter to open.",
  );
  await user.clear(search);
  // Fuzzy: letters that start words ("bg" in buzz-github-prs) rank above
  // letters anywhere; the much-visited debug-log is lifted past both.
  await user.type(search, "bg");
  expect(names()).toEqual([
    "debug-log",
    "buzz-github-prs",
    "bugs",
    "bug",
    "my-bugs",
  ]);
  expect(
    screen
      .getByRole("button", { name: "buzz-github-prs" })
      .querySelectorAll("mark"),
  ).toHaveLength(2);
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("status")).toHaveTextContent(
    "buzz-github-prs. Press Enter to open.",
  );
  expect(search).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(choose).toHaveBeenCalledExactlyOnceWith("prs");
  // The choice is this picker's own.
  const candidates = new Set(["channel:debug", "channel:prs"]);
  expect(readSearchUsage(scope).pick(pickerText("tab", "bg"), candidates)).toBe(
    "channel:prs",
  );
  expect(readSearchUsage(scope).pick("bg", candidates)).toBeUndefined();
});
it("puts the earlier choice for this text after an exact name", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  const user = userEvent.setup();
  const named = (id: string, name: string) =>
    ({ id, name, channelType: "stream" }) as ChannelSummary;
  recordChoice(scope, pickerText("tab", "de"), "channel:debug");
  render(
    <ChannelTabPicker
      channels={[named("deploys", "deploys"), named("debug", "debug-log")]}
      tools={[tool]}
      icon={() => null}
      choose={vi.fn()}
      chooseTool={vi.fn()}
      usageScope={scope}
    />,
  );
  await user.type(screen.getByRole("searchbox"), "de");
  expect(screen.getByRole("status")).toHaveTextContent(
    "debug-log. Press Enter to open.",
  );
});
