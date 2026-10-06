// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentActivity } from "../../features/agents/activity";
import { controlFixture } from "../../features/agents/control-testing";
import { AgentSessionSettings } from "./AgentSessionSettings";

afterEach(cleanup);

function setup() {
  const fixture = controlFixture();
  fixture.agent.harness = {
    integration: "codex",
    command: "codex-acp",
    args: [],
    model: "model-b",
    provider: "",
    configuration: {
      mode: "advanced",
      effort: { kind: "value", value: "high" },
    },
    environmentKeys: [],
  };
  const observe = vi.fn();
  const owner = createAgentActivity(true, observe, () => true);
  render(
    <AgentSessionSettings agent={fixture.agent} activity={owner.queries} />,
  );
  const now = new Date().toISOString();
  const event = (kind: string, seq: number, payload: object) => ({
    kind,
    seq,
    payload,
    timestamp: now,
    startedAt: now,
    agentIndex: 0,
    channelId: "00000000-0000-4000-8000-000000000001",
    turnId: "turn-one",
    sessionId: kind === "session_resolved" ? "S-1" : null,
  });
  const send = (events: object[]) => {
    const generation = observe.mock.lastCall?.[0] as number;
    act(() => {
      owner.state({
        status: "connected",
        routes: [{ id: "observer", status: "live", replay: "unknown" }],
      });
      owner.receive(
        {
          id: "1".repeat(64),
          agent: fixture.agent.pubkey,
          createdAt: Math.floor(Date.now() / 1000),
          plaintext: JSON.stringify({ kind: "batch", payload: { events } }),
        },
        generation,
      );
    });
  };
  return { fixture, observe, event, send };
}

it("keeps saved requested settings separate from missing observations", async () => {
  const { observe } = setup();
  await waitFor(() => expect(observe).toHaveBeenCalledWith(1));
  expect(screen.getByText("model-b")).toBeVisible();
  expect(screen.getByText("high")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Not reported");
  expect(screen.getByText(/historical conversation evidence/)).toBeVisible();
});

it("shows independently reported values with session identity and time", async () => {
  const { observe, event, send } = setup();
  await waitFor(() => expect(observe).toHaveBeenCalledWith(1));
  send([
    event("acp_write", 1, { id: 1, method: "session/new", params: {} }),
    event("acp_read", 2, {
      id: 1,
      result: {
        sessionId: "S-1",
        configOptions: [
          { id: "model", category: "model", currentValue: "model-a" },
          {
            id: "effort",
            category: "thought_level",
            currentValue: "medium",
          },
        ],
      },
    }),
    event("session_resolved", 3, { sessionId: "S-1" }),
  ]);
  expect(screen.getByText("Session S-1")).toBeVisible();
  expect(screen.getByText(/model-a/)).toBeVisible();
  expect(screen.getByText(/medium/)).toBeVisible();
  expect(document.querySelectorAll("time")).toHaveLength(3);
});

it("shows rejection, explicit fallback, and failed turn without raw errors", async () => {
  const { observe, event, send } = setup();
  await waitFor(() => expect(observe).toHaveBeenCalledWith(1));
  send([
    event("acp_write", 1, { id: 1, method: "session/new", params: {} }),
    event("acp_read", 2, {
      id: 1,
      result: { sessionId: "S-1", models: { currentModelId: "fallback" } },
    }),
    event("control_result", 3, {
      type: "switch_model",
      status: "unsupported_model",
      modelId: "missing",
      error: "private output",
    }),
    event("session_resolved", 4, { sessionId: "S-1" }),
    event("agent_panic", 5, { error: "other private output" }),
  ]);
  expect(
    screen.getByText(/Requested model missing was unsupported/),
  ).toHaveTextContent("Reported fallback: fallback");
  expect(screen.getByText(/This turn failed/)).toBeVisible();
  expect(document.body).not.toHaveTextContent("private output");
});
