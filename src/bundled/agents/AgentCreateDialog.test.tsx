// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import * as communityApi from "../../features/communities/api";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { useSyncExternalStore } from "react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function codexFixture() {
  const fixture = controlFixture();
  fixture.data.createAvailable = true;
  fixture.data.defaultWorkspace = "/fixture/workspace";
  fixture.agent.harness = {
    integration: "codex",
    command: "/tools/codex-acp",
    args: [],
    model: "",
    provider: "",
    configuration: { mode: "default" },
    environmentKeys: [],
  };
  fixture.data.harnessOptions?.push({
    id: "codex",
    command: "/tools/codex-acp",
    label: "Codex",
    available: true,
    status: "check-needed",
    defaultArgs: [],
    providers: [],
    configurationPolicy: {
      authentication: "external",
      provider: "external",
      supportedModes: ["default", "advanced"],
      model: "optional",
      effortDiscovery: "modelSpecific",
      selectorEnvironment: null,
    },
  });
  return fixture;
}

it("matches native wss recovery to the https form destination and resumes the same identity", async () => {
  const fixture = codexFixture();
  const recovery = {
    requestId: "pending-request",
    agentId: "recovered-agent",
    pubkey: "cd".repeat(32),
    destination: "wss://relay.example.test",
    owner: "de".repeat(32),
  };
  fixture.host.createRecovery = vi.fn(async () => recovery);
  const resume = vi.fn(async (_requestId, edit) => {
    fixture.data.agents.push({
      ...structuredClone(fixture.agent),
      id: recovery.agentId,
      pubkey: recovery.pubkey,
      name: edit.name,
      relayUrl: recovery.destination,
      enabled: false,
      status: "stopped",
      runningRevision: null,
      profilePending: false,
    });
    return structuredClone(fixture.data);
  });
  fixture.host.resumeCreate = resume;
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const onClose = vi.fn();
  render(
    <AgentCreateDialog
      control={control}
      state={control.snapshot()}
      destination="https://relay.example.test"
      owner={recovery.owner}
      source={fixture.agent}
      onClose={onClose}
    />,
  );
  const user = userEvent.setup();

  expect(
    await screen.findByText(/previous agent creation is ready to resume/i),
  ).toBeVisible();
  const submit = screen.getByRole("button", { name: "Create agent" });
  expect(submit).toBeEnabled();
  await user.click(submit);
  await waitFor(() => expect(resume).toHaveBeenCalledOnce());
  expect(resume).toHaveBeenCalledWith(
    recovery.requestId,
    expect.objectContaining({
      name: "Fixture agent copy",
      harness: expect.objectContaining({ integration: "codex" }),
    }),
    "[]",
  );
  control.dispose();
});

it("discards an inaccessible pending creation before enabling a fresh Create", async () => {
  const fixture = codexFixture();
  const recovery = {
    requestId: "other-request",
    agentId: "other-agent",
    pubkey: "cd".repeat(32),
    destination: "wss://other.example.test",
    owner: "ab".repeat(32),
  };
  fixture.host.createRecovery = vi.fn(async () => recovery);
  const discard = vi.fn(async () => {});
  fixture.host.discardCreate = discard;
  fixture.host.prepareCreate = vi.fn(async () => ({
    id: "unused",
    pubkey: "ef".repeat(32),
  }));
  fixture.host.commitCreate = vi.fn(async () => structuredClone(fixture.data));
  const control = createAgentControl(fixture.host);
  await control.refresh();
  render(
    <AgentCreateDialog
      control={control}
      state={control.snapshot()}
      destination="https://relay.example.test"
      owner={"de".repeat(32)}
      source={fixture.agent}
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();

  expect(
    await screen.findByText(/another community or owner must be discarded/i),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Discard pending creation" }),
  );
  await waitFor(() => expect(discard).toHaveBeenCalledWith(recovery.requestId));
  await waitFor(() =>
    expect(
      screen.queryByText(/another community or owner must be discarded/i),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Create agent" })).toBeEnabled();
  control.dispose();
});

it("cancels Create validation in place, ignores its late proof, and retries one identity", async () => {
  const fixture = codexFixture();
  fixture.host.createRecovery = vi.fn(async () => null);
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
  const prepare = vi.fn(
    async (_requestId, _destination, _owner, _edit, proof?: string) =>
      proof
        ? { id: "created", pubkey: "ef".repeat(32) }
        : { validationRequired: true },
  );
  fixture.host.prepareCreate = prepare;
  const commit = vi.fn(async (_requestId, edit) => {
    fixture.data.agents.push({
      ...structuredClone(fixture.agent),
      id: "created",
      pubkey: "ef".repeat(32),
      name: edit.name,
      enabled: false,
      status: "stopped",
      runningRevision: null,
      profilePending: false,
    });
    return structuredClone(fixture.data);
  });
  fixture.host.commitCreate = commit;
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  render(
    <AgentCreateDialog
      control={control}
      state={control.snapshot()}
      destination="https://relay.example.test"
      owner={"de".repeat(32)}
      source={fixture.agent}
      onClose={() => {}}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByText("Testing Codex connection…")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel validation" }));
  first.resolve({ proof: "late-proof" });

  expect(
    await screen.findByText(/validation was cancelled.*edits are unchanged/i),
  ).toBeVisible();
  expect(screen.getByLabelText("Name")).toHaveValue("Fixture agent copy");
  expect(commit).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith(1);

  await user.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(commit).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(
    fixture.data.agents.filter((agent) => agent.id === "created"),
  ).toHaveLength(1);
  control.dispose();
});

it("switches from Testing to Creating before a native create commit waits", async () => {
  const fixture = codexFixture();
  fixture.host.createRecovery = vi.fn(async () => null);
  fixture.host.codexValidation = {
    begin: vi.fn(async () => 1),
    run: vi.fn(async () => ({ proof: "sealed" })),
    cancel: vi.fn(async () => {}),
  };
  fixture.host.prepareCreate = vi.fn(
    async (_requestId, _destination, _owner, _edit, proof?: string) =>
      proof
        ? { id: "created", pubkey: "ef".repeat(32) }
        : { validationRequired: true },
  );
  const committed = deferred<typeof fixture.data>();
  fixture.host.commitCreate = vi.fn(() => committed.promise);
  vi.spyOn(communityApi, "communityRequest").mockResolvedValue({ auth: [] });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  function Dialog() {
    const state = useSyncExternalStore(control.subscribe, control.snapshot);
    return (
      <AgentCreateDialog
        control={control}
        state={state}
        destination="https://relay.example.test"
        owner={"de".repeat(32)}
        source={fixture.agent}
        onClose={() => {}}
      />
    );
  }
  render(<Dialog />);
  await userEvent.click(screen.getByRole("button", { name: "Create agent" }));

  expect(await screen.findByText("Creating agent…")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Cancel validation" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
  committed.resolve(structuredClone(fixture.data));
  control.dispose();
});
