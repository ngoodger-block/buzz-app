// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { agentDraft } from "./agent-edit";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentEditor } from "./AgentEditor";
import { useSyncExternalStore } from "react";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("reviews a requested model update before saving it", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const state = control.snapshot();
  const onClose = vi.fn();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={state}
      initialDraft={{ ...agentDraft(fixture.agent), model: "gpt-6-sol" }}
      notice="Requested by an agent. Review every field before saving."
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );

  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
    "gpt-6-sol",
  );
  expect(screen.getByText(/Requested by an agent/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() =>
    expect(fixture.calls.at(-1)).toMatchObject({
      action: "save",
      payload: { edit: { harness: { model: "gpt-6-sol" } } },
    }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  control.dispose();
});

it("keeps a requested update open with its edits when save fails", async () => {
  const fixture = controlFixture();
  fixture.failSave(true);
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const onClose = vi.fn();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={control.snapshot()}
      initialDraft={{ ...agentDraft(fixture.agent), model: "gpt-6-sol" }}
      notice="Requested by an agent. Review every field before saving."
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );

  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The host could not save settings.",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue(
    "gpt-6-sol",
  );
  control.dispose();
});

it("shows restart failures instead of dismissing a saved review", async () => {
  const fixture = controlFixture();
  const save = fixture.host.save;
  const control = createAgentControl({
    ...fixture.host,
    save: async (id, revision, edit) => ({
      ...(await save(id, revision, edit)),
      restartFailures: 1,
    }),
  });
  await control.refresh();
  const onClose = vi.fn();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={control.snapshot()}
      initialDraft={{ ...agentDraft(fixture.agent), model: "gpt-6-sol" }}
      notice="Requested by an agent. Review every field before saving."
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );

  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("status")).toHaveTextContent(
    "1 agent couldn’t restart with the new settings; check Agents.",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(fixture.agent.harness.model).toBe("gpt-6-sol");
  control.dispose();
});

it("closes the ordinary editor and keeps its success toast visible", async () => {
  const fixture = controlFixture();
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const onClose = vi.fn();
  const view = render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={control.snapshot()}
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );
  await userEvent.type(
    screen.getByLabelText("Agent instructions"),
    " Updated.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  view.rerender(null);
  expect(await screen.findByText("Saved.", { exact: true })).toBeVisible();
  expect(fixture.agent.systemPrompt).toBe("Help with the project. Updated.");
  control.dispose();
});

it("keeps the editor open when saved profile publication is unconfirmed", async () => {
  const fixture = controlFixture();
  fixture.failProfile(true);
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const onClose = vi.fn();
  render(
    <AgentEditor
      agent={fixture.agent}
      control={control}
      state={control.snapshot()}
      onClose={onClose}
      initialDraft={{
        ...agentDraft(fixture.agent),
        picture: "https://example.com/avatar.png",
      }}
    />,
    { wrapper: ToastProvider },
  );
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "profile publication is unconfirmed",
    ),
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(fixture.agent.profilePending).toBe(true);
  control.dispose();
});

it("cancels Codex validation in place, fences its late result, and retries the same draft", async () => {
  const fixture = controlFixture();
  fixture.agent.harness = {
    integration: "codex",
    command: "/tools/codex-acp",
    args: [],
    model: "",
    provider: "",
    configuration: { mode: "default" },
    environmentKeys: [],
  };
  const first = deferred<{ proof: string } | null>();
  let ticket = 0;
  const cancel = vi.fn(async () => {});
  fixture.host.codexValidation = {
    begin: vi.fn(async () => ++ticket),
    run: vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ proof: "retry-proof" }),
    cancel,
  };
  const save = vi.spyOn(fixture.host, "save");
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const onClose = vi.fn();
  function Editor() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return (
      <AgentEditor
        agent={fixture.agent}
        control={control}
        state={state}
        onClose={onClose}
      />
    );
  }
  render(<Editor />, { wrapper: ToastProvider });
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Agent instructions"), " Updated.");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Testing Codex connection…")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel validation" }));
  first.resolve({ proof: "late-proof" });

  expect(
    await screen.findByText(/validation was cancelled.*edits are unchanged/i),
  ).toBeVisible();
  expect(screen.getByLabelText("Agent instructions")).toHaveValue(
    "Help with the project. Updated.",
  );
  expect(save).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith(1);

  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith(
    fixture.agent.id,
    1,
    expect.anything(),
    expect.any(String),
    "retry-proof",
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  control.dispose();
});

it("stops offering validation cancellation once native Codex Save begins", async () => {
  const fixture = controlFixture();
  fixture.agent.harness = {
    integration: "codex",
    command: "/tools/codex-acp",
    args: [],
    model: "",
    provider: "",
    configuration: { mode: "default" },
    environmentKeys: [],
  };
  fixture.host.codexValidation = {
    begin: vi.fn(async () => 1),
    run: vi.fn(async () => ({ proof: "sealed" })),
    cancel: vi.fn(async () => {}),
  };
  const pending = deferred<typeof fixture.data>();
  fixture.host.save = vi.fn(() => pending.promise);
  const control = createAgentControl(fixture.host);
  await control.refresh();
  function Editor() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return (
      <AgentEditor
        agent={fixture.agent}
        control={control}
        state={state}
        onClose={() => {}}
      />
    );
  }
  render(<Editor />, { wrapper: ToastProvider });
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Agent instructions"), " Updated.");
  await user.click(screen.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Saving changes…")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Cancel validation" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  pending.resolve(structuredClone(fixture.data));
  await waitFor(() =>
    expect(screen.queryByText("Saving changes…")).not.toBeInTheDocument(),
  );
  control.dispose();
});
