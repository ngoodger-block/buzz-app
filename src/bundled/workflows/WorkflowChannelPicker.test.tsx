// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { WorkflowChannelPicker } from "./WorkflowChannelPicker";

afterEach(cleanup);

it("picks the first matching channel with Enter, without an arrow key", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const channel = (id: string, name: string): ChannelSummary => ({ id, name });
  render(
    <WorkflowChannelPicker
      channels={[
        channel("1", "general"),
        channel("2", "design-reviews"),
        channel("3", "design"),
      ]}
      onSelect={onSelect}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.type(input, "des");
  expect(
    await screen.findByRole("option", { name: "design-reviews" }),
  ).toHaveAttribute("data-highlighted");
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("2");
});

it("does not pick a channel with Enter before anything is typed", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <WorkflowChannelPicker
      channels={[{ id: "1", name: "general" }]}
      onSelect={onSelect}
    />,
  );
  const input = screen.getByRole("combobox", { name: "Choose a channel" });
  await user.click(input);
  expect(screen.queryByRole("option", { name: "general" })).not.toHaveAttribute(
    "data-highlighted",
  );
  await user.keyboard("{Enter}");
  expect(onSelect).not.toHaveBeenCalled();
});
