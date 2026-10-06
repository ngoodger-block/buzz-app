// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentControl,
  type AgentControlHost,
  type HarnessInstallReport,
} from "../features/agents/control";
import { controlFixture } from "../features/agents/control-testing";
import { AgentSettings } from "./AgentSettings";
import {
  rememberAgentsPreference,
  setRememberAgentsPreference,
} from "../features/messages/mention-preferences";

const browserControl = createAgentControl(null);
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
  setRememberAgentsPreference(true);
  localStorage.clear();
});

it("defaults on, persists opt-out, and follows another window's preference", async () => {
  const user = userEvent.setup();
  render(<AgentSettings control={browserControl} />, {
    wrapper: ToastProvider,
  });
  const toggle = () =>
    screen.getByRole("switch", { name: "Remember mentioned agents" });
  expect(toggle()).toBeChecked();
  await user.click(toggle());
  expect(rememberAgentsPreference()).toBe(false);
  cleanup();
  render(<AgentSettings control={browserControl} />, {
    wrapper: ToastProvider,
  });
  expect(toggle()).not.toBeChecked();
  act(() => {
    localStorage.removeItem("buzz-remember-mentioned-agents.v1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "buzz-remember-mentioned-agents.v1" }),
    );
  });
  expect(toggle()).toBeChecked();
});

it("keeps an unsaved opt-out effective and offers retry without changing the choice", async () => {
  const user = userEvent.setup();
  render(<AgentSettings control={browserControl} />, {
    wrapper: ToastProvider,
  });
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  await user.click(
    screen.getByRole("switch", { name: "Remember mentioned agents" }),
  );
  expect(rememberAgentsPreference()).toBe(false);
  expect(screen.getByRole("dialog")).toHaveTextContent("could not be saved");
  write.mockRestore();
  await user.click(screen.getByRole("button", { name: "Retry saving" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(localStorage.getItem("buzz-remember-mentioned-agents.v1")).toBe("off");
});

it("does not prefill when storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  expect(rememberAgentsPreference()).toBe(false);
});

function setupHarnesses(
  piStatus: "ready" | "cli-needed" | "adapter-needed",
  pi: {
    installSupported?: boolean;
    updateSupported?: boolean;
    installPi?: NonNullable<AgentControlHost["installPi"]>;
  } = {},
) {
  const fixture = controlFixture();
  if (pi.installPi) fixture.host.installPi = pi.installPi;
  fixture.data.harnessOptions = [
    {
      command: "buzz-agent",
      label: "Buzz Agent",
      available: true,
      status: "ready",
      providers: [],
    },
    {
      command: "goose",
      label: "Goose",
      available: true,
      status: "ready",
      providers: [],
    },
    {
      command: "buzz-pi-acp",
      label: "Pi",
      available: piStatus === "ready",
      status: piStatus,
      ...(pi.installSupported !== undefined
        ? { installSupported: pi.installSupported }
        : {}),
      ...(pi.updateSupported !== undefined
        ? { updateSupported: pi.updateSupported }
        : {}),
      providers: [],
    },
    {
      command: "hermes-acp",
      label: "Hermes Agent",
      available: false,
      status: "cli-needed",
      installSupported: false,
      providers: [],
    },
  ];
  const control = createAgentControl(fixture.host);
  disposals.push(() => control.dispose());
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  return { fixture, control };
}

it.each(["cli-needed", "adapter-needed", "ready"] as const)(
  "shows Harnesses and keeps manual Pi commands collapsed until requested (%s)",
  async (piStatus) => {
    const user = userEvent.setup();
    setupHarnesses(piStatus);
    const list = await screen.findByRole("list", { name: "Harnesses" });
    const rows = within(list)
      .getAllByRole("listitem")
      .filter((row) => row.parentElement === list);
    expect(rows).toHaveLength(3);
    const pi = rows[2];
    if (!pi) throw new Error("Missing Pi row");
    expect(rows[0]).toHaveTextContent("Buzz AgentReady");
    expect(rows[1]).toHaveTextContent("GooseReady");
    expect(rows[2]).toHaveTextContent(
      `Pi${piStatus === "ready" ? "Ready" : piStatus === "cli-needed" ? "CLI needed" : "Adapter needed"}`,
    );
    const copyPi = screen.queryByRole("button", { name: "Copy Pi command" });
    if (piStatus === "ready") {
      expect(copyPi).not.toBeInTheDocument();
      expect(screen.queryByText(/npm install -g/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByLabelText("Copy Pi command")).not.toBeVisible();
      const manual = within(pi).getByText("Manual setup");
      expect(manual.closest("details")).not.toHaveAttribute("open");
      await user.click(manual);
      const steps = within(
        screen.getByRole("list", { name: "Manual setup steps" }),
      ).getAllByRole("listitem");
      expect(steps).toHaveLength(4);
      expect(steps[0]).toHaveTextContent("Install Node.js");
      expect(steps[1]).toHaveTextContent("Install Pi");
      expect(steps[2]).toHaveTextContent("Install the ACP adapter");
      expect(steps[3]).toHaveTextContent("Check the installation");
      expect(
        screen.getByText(
          "npm install -g '@earendil-works/pi-coding-agent@>=0.99.0'",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          /git\+https:\/\/github.com\/salman1993\/buzz-pi-acp.git#72015de/,
        ),
      ).toBeVisible();
      const write = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();
      await user.click(screen.getByRole("button", { name: "Copy Pi command" }));
      expect(write).toHaveBeenCalledWith(
        "npm install -g '@earendil-works/pi-coding-agent@>=0.99.0'",
      );
      await user.click(
        screen.getByRole("button", { name: "Copy Adapter command" }),
      );
      expect(write).toHaveBeenCalledWith(
        "npm install -g --install-links=true 'git+https://github.com/salman1993/buzz-pi-acp.git#72015de'",
      );
      expect(await screen.findByRole("status", { name: "" })).toHaveTextContent(
        "Adapter command copied.",
      );
    }
    await user.hover(screen.getByRole("button", { name: "About ACP" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Hermes Agent uses its own ACP launcher and sign-in.",
    );
  },
);

it("discovers Tier 2 Hermes through Add harness and follows installation changes", async () => {
  const user = userEvent.setup();
  const { fixture } = setupHarnesses("ready");
  const list = await screen.findByRole("list", { name: "Harnesses" });
  expect(within(list).queryByText("Hermes Agent")).not.toBeInTheDocument();
  const add = screen.getByRole("button", { name: "Add harness" });
  await user.click(add);
  const dialog = await screen.findByRole("dialog", { name: "Add harness" });
  expect(within(dialog).getByText("CLI needed")).toBeVisible();
  expect(
    within(dialog).queryByRole("button", { name: /Install|Update/ }),
  ).toBeNull();
  expect(
    within(dialog).getByRole("link", { name: "Hermes Agent setup guide" }),
  ).toHaveAttribute(
    "href",
    "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/",
  );
  await user.click(within(dialog).getByText("Terminal setup"));
  expect(within(dialog).getByText("hermes model")).toBeVisible();
  expect(within(dialog).getByText("hermes acp --check")).toBeVisible();
  const hermes = fixture.data.harnessOptions?.find(
    (option) => option.label === "Hermes Agent",
  );
  if (!hermes) throw new Error("Missing Hermes option");
  Object.assign(hermes, {
    command: "/local/hermes-acp",
    available: true,
    status: "ready",
  });
  await user.click(within(dialog).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(within(dialog).getByText("Ready")).toBeVisible());
  expect(within(dialog).getByText("/local/hermes-acp")).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(add).toHaveFocus());
  expect(
    within(list).getByText("Hermes Agent").closest("li"),
  ).toHaveTextContent("Ready");
  Object.assign(hermes, {
    command: "hermes-acp",
    available: false,
    status: "cli-needed",
  });
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(within(list).queryByText("Hermes Agent")).not.toBeInTheDocument(),
  );
  await user.click(add);
  expect(
    within(await screen.findByRole("dialog")).getByText("CLI needed"),
  ).toBeVisible();
});

it("keeps Tier 1 harnesses usable when an older desktop has no Hermes option", async () => {
  const user = userEvent.setup();
  const { fixture, control } = setupHarnesses("ready");
  fixture.data.harnessOptions = (fixture.data.harnessOptions ?? []).filter(
    (option) => option.label !== "Hermes Agent",
  );
  await act(() => control.refresh());
  const list = await screen.findByRole("list", { name: "Harnesses" });
  expect(within(list).getByText("Goose")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add harness" }));
  expect(
    await screen.findByRole("dialog", { name: "Add harness" }),
  ).toHaveTextContent("Update the desktop app to check Hermes Agent.");
});

it("recognizes harness commands independently of native display labels", async () => {
  const { fixture, control } = setupHarnesses("ready");
  for (const option of fixture.data.harnessOptions ?? []) {
    option.label = `Renamed ${option.label}`;
  }
  await act(() => control.refresh());
  const list = await screen.findByRole("list", { name: "Harnesses" });
  expect(within(list).getByText("Renamed Goose")).toBeVisible();
  expect(
    within(list).queryByText("Renamed Hermes Agent"),
  ).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add harness" }));
  const dialog = await screen.findByRole("dialog", { name: "Add harness" });
  expect(
    within(dialog).getByRole("heading", { name: "Renamed Hermes Agent" }),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("link", {
      name: "Renamed Hermes Agent setup guide",
    }),
  ).toHaveAttribute(
    "href",
    "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/",
  );
});

it("offers manual copying when clipboard access fails", async () => {
  const user = userEvent.setup();
  setupHarnesses("cli-needed");
  await user.click(await screen.findByText("Manual setup"));
  expect(
    await screen.findByRole("button", { name: "Copy Pi command" }),
  ).toBeVisible();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  await user.click(screen.getByRole("button", { name: "Copy Pi command" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Select it to copy manually.",
  );
  expect(
    screen.getByText(
      "npm install -g '@earendil-works/pi-coding-agent@>=0.99.0'",
    ),
  ).toBeVisible();
});

it("Check again re-reads the native snapshot without restarting the app", async () => {
  const user = userEvent.setup();
  const { fixture } = setupHarnesses("adapter-needed");
  expect(await screen.findByText("Adapter needed")).toBeVisible();
  await user.hover(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Check again");
  const before = fixture.calls.filter(
    (call) => call.action === "snapshot",
  ).length;
  const pi = fixture.data.harnessOptions?.[2];
  const goose = fixture.data.harnessOptions?.[1];
  if (!pi || !goose) throw new Error("Missing Harness fixture");
  pi.status = "ready";
  pi.available = true;
  goose.status = "ready";
  goose.available = true;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Harnesses" })).getAllByRole(
        "listitem",
      )[2],
    ).toHaveTextContent("PiReady"),
  );
  expect(screen.queryByRole("button", { name: "Copy Pi command" })).toBeNull();
  expect(
    within(screen.getByRole("list", { name: "Harnesses" })).getAllByRole(
      "listitem",
    )[1],
  ).toHaveTextContent("GooseReady");
  expect(
    fixture.calls.filter((call) => call.action === "snapshot"),
  ).toHaveLength(before + 1);
});

it("keeps the last statuses and offers Check again after a failed read", async () => {
  const user = userEvent.setup();
  const installPi = vi.fn();
  const { fixture } = setupHarnesses("cli-needed", {
    installSupported: true,
    installPi,
  });
  const list = await screen.findByRole("list", { name: "Harnesses" });
  const piRow = within(list).getByText("Pi", { exact: true }).closest("li");
  if (!piRow) throw new Error("Missing Pi row");
  expect(within(piRow).getByText("CLI needed")).toBeVisible();
  const original = fixture.host.snapshot.bind(fixture.host);
  fixture.host.snapshot = vi
    .fn()
    .mockRejectedValueOnce("unavailable")
    .mockImplementation(original);
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("last check");
  expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  expect(installPi).not.toHaveBeenCalled();
  expect(
    within(screen.getByRole("list", { name: "Harnesses" })).getAllByRole(
      "listitem",
    )[0],
  ).toHaveTextContent("Buzz AgentReady");
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("button", { name: "Install" })).toBeEnabled();
});

it.each([
  ["cli-needed", true, true],
  ["adapter-needed", true, true],
  ["ready", true, false],
  ["cli-needed", false, false],
  ["adapter-needed", false, false],
] as const)(
  "shows Pi Install only when needed and supported (%s, %s)",
  async (status, supported, visible) => {
    setupHarnesses(status, { installSupported: supported, installPi: vi.fn() });
    const pi = within(
      await screen.findByRole("list", { name: "Harnesses" }),
    ).getAllByRole("listitem")[2];
    if (!pi) throw new Error("Missing Pi row");
    expect(within(pi).queryByRole("button", { name: "Install" }) !== null).toBe(
      visible,
    );
    if (status !== "ready") {
      expect(screen.getByLabelText("Copy Pi command")).not.toBeVisible();
      if (supported)
        expect(
          within(pi).getByText(
            /Buzz installs Node.js, Pi, and its ACP adapter for you/,
          ),
        ).toBeVisible();
      else
        expect(
          within(pi).getByText(/Use Manual setup on this device/),
        ).toBeVisible();
    }
  },
);

it("offers no Pi update or command for a current or user-global Pi install", async () => {
  setupHarnesses("ready", {
    installSupported: true,
    updateSupported: false,
    installPi: vi.fn(),
  });
  const pi = within(
    await screen.findByRole("list", { name: "Harnesses" }),
  ).getAllByRole("listitem")[2];
  if (!pi) throw new Error("Missing Pi row");
  expect(within(pi).getByText("Ready")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Update Pi" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Copy Adapter command" }),
  ).toBeNull();
  expect(screen.queryByText(/buzz-pi-acp.git#/)).toBeNull();
});

it("updates an outdated app-owned Pi and tells the user to restart running agents", async () => {
  const user = userEvent.setup();
  const installPi = vi.fn().mockResolvedValue({
    ready: true,
    restarted: 0,
    restartFailures: 0,
    logPath: "/fixture/pi-install.log",
    output: "done",
    error: null,
  });
  setupHarnesses("ready", {
    installSupported: true,
    updateSupported: true,
    installPi,
  });
  const pi = within(
    await screen.findByRole("list", { name: "Harnesses" }),
  ).getAllByRole("listitem")[2];
  if (!pi) throw new Error("Missing Pi row");
  await user.click(within(pi).getByRole("button", { name: "Update Pi" }));
  expect(installPi).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByText(/Restart running Pi agents to use them/),
  ).toBeVisible();
});

it("keeps Pi install progress and report across Settings remounts without taking the agent-write lane", async () => {
  const user = userEvent.setup();
  let complete!: (report: HarnessInstallReport) => void;
  const installing = new Promise<HarnessInstallReport>((resolve) => {
    complete = resolve;
  });
  const installPi = vi.fn(() => installing);
  const { control, fixture } = setupHarnesses("adapter-needed", {
    installSupported: true,
    installPi,
  });
  const pi = within(
    await screen.findByRole("list", { name: "Harnesses" }),
  ).getAllByRole("listitem")[2];
  if (!pi) throw new Error("Missing Pi row");
  await user.click(within(pi).getByRole("button", { name: "Install" }));
  expect(
    await screen.findByText("Installing Pi and its ACP adapter…"),
  ).toBeVisible();
  expect(control.snapshot().busy).toBe(false);
  expect(installPi).toHaveBeenCalledTimes(1);
  cleanup();
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  expect(
    await screen.findByText("Installing Pi and its ACP adapter…"),
  ).toBeVisible();
  const option = fixture.data.harnessOptions?.[2];
  if (!option) throw new Error("Missing Pi fixture");
  option.status = "ready";
  option.available = true;
  complete({
    ready: true,
    restarted: 1,
    restartFailures: 0,
    logPath: "/fixture/pi-install.log",
    output: "done",
    error: null,
  });
  expect(
    await screen.findByText(
      /Pi and its adapter are up to date.*Restarted 1 waiting agents\./,
    ),
  ).toBeVisible();
  cleanup();
  render(<AgentSettings control={control} />, { wrapper: ToastProvider });
  expect(
    await screen.findByText(
      /Pi and its adapter are up to date.*Restarted 1 waiting agents\./,
    ),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Copy Pi command" })).toBeNull();
});

it("keeps bundled Goose Ready during a Pi installation", async () => {
  const user = userEvent.setup();
  let complete!: (report: HarnessInstallReport) => void;
  const pending = new Promise<HarnessInstallReport>((resolve) => {
    complete = resolve;
  });
  setupHarnesses("cli-needed", {
    installSupported: true,
    installPi: () => pending,
  });
  const rows = within(
    await screen.findByRole("list", { name: "Harnesses" }),
  ).getAllByRole("listitem");
  if (!rows[1] || !rows[2]) throw new Error("Missing Harness rows");
  await user.click(within(rows[2]).getByRole("button", { name: "Install" }));
  expect(within(rows[1]).queryByRole("button", { name: "Install" })).toBeNull();
  expect(rows[1]).toHaveTextContent("GooseReady");
  complete({
    ready: false,
    restarted: 0,
    restartFailures: 0,
    logPath: "/fixture/pi-install.log",
    output: "Full diagnostic output",
    error:
      "Installing Pi failed (exit code 1).\nnpm error code E404\nnpm error 404 No match found for version >=0.99.0",
  });
  const alert = await screen.findByRole("alert");
  expect(rows[2]).toContainElement(alert);
  expect(within(alert).getByText(/Installing Pi failed/)).toBeVisible();
  expect(alert).toHaveTextContent("E404");
  expect(alert).toHaveTextContent("No match found for version >=0.99.0");
  const log = within(alert).getByText("Pi install log");
  expect(log.closest("details")).not.toHaveAttribute("open");
  expect(within(alert).getByText("Full diagnostic output")).not.toBeVisible();
  await user.click(log);
  expect(within(alert).getByText("Full diagnostic output")).toBeVisible();
});
