// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState, useSyncExternalStore } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentControl,
  type ControlSnapshot,
} from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { agentDraft, type AgentDraft } from "./agent-edit";

afterEach(cleanup);

const codexOption: NonNullable<ControlSnapshot["harnessOptions"]>[number] = {
  id: "codex" as const,
  command: "/tools/codex-acp",
  label: "Codex",
  available: true,
  status: "check-needed" as const,
  defaultArgs: [],
  providers: [],
  configurationPolicy: {
    authentication: "external" as const,
    provider: "external" as const,
    supportedModes: ["default", "advanced"],
    model: "optional" as const,
    effortDiscovery: "modelSpecific" as const,
    selectorEnvironment: null,
  },
};

it("selects managed Codex Default or discovered Advanced settings without provider fields", async () => {
  const fixture = controlFixture();
  fixture.data.harnessOptions?.push(codexOption);
  fixture.host.codexReadiness = {
    begin: vi.fn(async () => 1),
    cancel: vi.fn(async () => {}),
    run: vi.fn(async () => ({
      status: "binding-ready" as const,
      message: "Codex CLI and adapter are ready.",
    })),
  };
  let ticket = 0;
  fixture.host.models = {
    begin: vi.fn(async () => ++ticket),
    cancel: vi.fn(async () => {}),
    run: vi.fn(async (_ticket, request) => ({
      host: "",
      models: [
        { id: "model-a", name: "Model A" },
        { id: "model-b", name: "Model B" },
      ],
      modelOverridden: false,
      disconnected: false,
      codex: {
        modelsKnown: true,
        ...(request.selectedModel
          ? {
              effort: {
                model: request.selectedModel,
                options: [
                  { id: "medium", name: "Medium" },
                  { id: "high", name: "High" },
                ],
              },
            }
          : {}),
      },
    })),
  };
  const control = createAgentControl(fixture.host);
  await control.refresh();
  let current = agentDraft(fixture.agent);
  function Example() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <>
        <AgentSettingsFields
          draft={draft}
          control={control}
          state={state}
          disabled={false}
          onChange={(patch) => setDraft((value) => ({ ...value, ...patch }))}
        />
        <output>{JSON.stringify(draft)}</output>
      </>
    );
  }
  const user = userEvent.setup();
  const view = render(<Example />);
  try {
    await user.click(screen.getByRole("combobox", { name: "Harness" }));
    await user.click(await screen.findByRole("option", { name: "Codex" }));
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
    expect(screen.queryByText(/Databricks workspace/)).not.toBeInTheDocument();
    expect(current).toMatchObject({
      integration: "codex",
      command: "/tools/codex-acp",
      args: "[]",
      provider: "",
      model: "",
      configuration: { mode: "default" },
    });
    expect(
      screen.getByText(/Codex chooses the model and effort/),
    ).toBeVisible();

    await user.click(
      screen.getByRole("combobox", { name: "Codex configuration" }),
    );
    await user.click(await screen.findByRole("option", { name: "Advanced" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Codex model" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("combobox", { name: "Codex model" }));
    await user.click(await screen.findByRole("option", { name: "Model A" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Codex effort" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("combobox", { name: "Codex effort" }));
    await user.click(await screen.findByRole("option", { name: "High" }));
    expect(current).toMatchObject({
      model: "model-a",
      configuration: {
        mode: "advanced",
        effort: { kind: "value", value: "high" },
      },
    });
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();
  } finally {
    view.unmount();
    control.dispose();
  }
});

async function renderSavedAdvanced(
  run: NonNullable<ReturnType<typeof controlFixture>["host"]["models"]>["run"],
) {
  const fixture = controlFixture();
  fixture.data.harnessOptions?.push(codexOption);
  let ticket = 0;
  fixture.host.models = {
    begin: vi.fn(async () => ++ticket),
    cancel: vi.fn(async () => {}),
    run,
  };
  const control = createAgentControl(fixture.host);
  await control.refresh();
  let current: AgentDraft = {
    ...agentDraft(fixture.agent),
    integration: "codex" as const,
    command: "/tools/codex-acp",
    args: "[]",
    provider: "",
    model: "model-a",
    configuration: {
      mode: "advanced" as const,
      effort: { kind: "value" as const, value: "high" },
    },
  };
  function Example() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    const [draft, setDraft] = useState(current);
    current = draft;
    return (
      <AgentSettingsFields
        draft={draft}
        control={control}
        state={state}
        disabled={false}
        onChange={(patch) => setDraft((value) => ({ ...value, ...patch }))}
      />
    );
  }
  const view = render(<Example />);
  return { fixture, control, current: () => current, view };
}

it("does not restart discovery on unrelated renders and preserves a stale saved effort", async () => {
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "model-a", name: "Model A" }],
    modelOverridden: false,
    disconnected: false,
    codex: {
      modelsKnown: true,
      effort: {
        model: "model-a",
        options: [{ id: "medium", name: "Medium" }],
      },
    },
  }));
  const { control, current, view } = await renderSavedAdvanced(run);
  const user = userEvent.setup();
  try {
    expect(
      await screen.findByText(/saved effort is no longer reported/i),
    ).toBeVisible();
    expect(run).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText("Name"), " updated");
    expect(run).toHaveBeenCalledTimes(1);
    expect(current().configuration).toEqual({
      mode: "advanced",
      effort: { kind: "value", value: "high" },
    });
    await user.click(
      screen.getByRole("button", { name: "Refresh Codex models" }),
    );
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(current().configuration).toEqual({
      mode: "advanced",
      effort: { kind: "value", value: "high" },
    });
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("falls back to the general catalog when a saved model was removed", async () => {
  const run = vi.fn(async (_ticket, request) => {
    if (request.selectedModel === "model-a")
      throw "This model is no longer available. Refresh models and choose another.";
    return {
      host: "",
      models: [{ id: "model-b", name: "Model B" }],
      modelOverridden: false,
      disconnected: false,
      codex: {
        modelsKnown: true,
        ...(request.selectedModel === "model-b"
          ? {
              effort: {
                model: "model-b",
                options: [{ id: "medium", name: "Medium" }],
              },
            }
          : {}),
      },
    };
  });
  const { control, current, view } = await renderSavedAdvanced(run);
  const user = userEvent.setup();
  try {
    expect(
      await screen.findByText(/choose a model from the refreshed catalog/i),
    ).toBeVisible();
    expect(current().model).toBe("model-a");
    const picker = screen.getByRole("combobox", { name: "Codex model" });
    expect(picker).toBeEnabled();
    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "Model B" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Codex effort" }),
      ).toBeEnabled(),
    );
    expect(current()).toMatchObject({
      model: "model-b",
      configuration: {
        mode: "advanced",
        effort: { kind: "value", value: "" },
      },
    });
  } finally {
    view.unmount();
    control.dispose();
  }
});

it("keeps a saved effort visible until the user accepts a confirmed no-effort model", async () => {
  const run = vi.fn(async () => ({
    host: "",
    models: [{ id: "model-a", name: "Model A" }],
    modelOverridden: false,
    disconnected: false,
    codex: {
      modelsKnown: true,
      effort: { model: "model-a", options: [] },
    },
  }));
  const { control, current, view } = await renderSavedAdvanced(run);
  const user = userEvent.setup();
  try {
    expect(
      await screen.findByText(/saved high effort is no longer supported/i),
    ).toBeVisible();
    expect(current().configuration).toEqual({
      mode: "advanced",
      effort: { kind: "value", value: "high" },
    });
    await user.click(
      screen.getByRole("button", { name: "Use model configuration" }),
    );
    expect(current().configuration).toEqual({
      mode: "advanced",
      effort: { kind: "unsupported" },
    });
  } finally {
    view.unmount();
    control.dispose();
  }
});
