import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentActivity } from "./activity";
import { observedSessionSettings } from "./session-settings";

const agent = "a".repeat(64);
const otherAgent = "b".repeat(64);
const channel = "00000000-0000-4000-8000-000000000001";

type EventOptions = {
  sessionId?: string | null;
  turnId?: string;
  channelId?: string | null;
  agentIndex?: number;
  startedAt?: string;
  timestamp?: string;
};

function fixture(canAccess: (channelId: string) => boolean = () => true) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
  const observe = vi.fn();
  const owner = createAgentActivity(true, observe, canAccess);
  const release = owner.queries.activate();
  owner.state({
    status: "connected",
    routes: [{ id: "observer", status: "live", replay: "unknown" }],
  });
  let serial = 0;
  const startedAt = new Date().toISOString();
  const event = (
    kind: string,
    seq: number,
    payload: object,
    options: EventOptions = {},
  ) => ({
    kind,
    seq,
    payload,
    timestamp: options.timestamp ?? new Date().toISOString(),
    startedAt: options.startedAt ?? startedAt,
    agentIndex: options.agentIndex ?? 0,
    channelId: "channelId" in options ? options.channelId : channel,
    turnId: options.turnId ?? "turn",
    sessionId: options.sessionId ?? null,
  });
  const open = (
    values: object = {
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: "model-a",
        },
        {
          id: "reasoning_effort",
          category: "thought_level",
          currentValue: "low",
        },
      ],
    },
    options: EventOptions = {},
  ) => [
    event(
      "acp_write",
      1,
      { id: 1, method: "session/new", params: {} },
      options,
    ),
    event(
      "acp_read",
      2,
      { id: 1, result: { sessionId: options.sessionId ?? "S", ...values } },
      options,
    ),
  ];
  const resolve = (seq = 10, options: EventOptions = {}) => {
    const sessionId = options.sessionId ?? "S";
    return event(
      "session_resolved",
      seq,
      { sessionId, isNewSession: true },
      { ...options, sessionId },
    );
  };
  const send = (
    value: unknown,
    pubkey = agent,
    generation = observe.mock.lastCall?.[0] as number,
  ) =>
    owner.receive(
      {
        id: (++serial).toString(16).padStart(64, "0"),
        agent: pubkey,
        createdAt: Math.floor(Date.now() / 1000),
        plaintext: JSON.stringify(value),
      },
      generation,
    );
  const batch = (events: unknown[]) => ({ kind: "batch", payload: { events } });
  return {
    owner,
    release,
    observe,
    event,
    open,
    resolve,
    send,
    batch,
    reports: () =>
      observedSessionSettings(owner.queries.snapshot().records, agent),
  };
}

afterEach(() => vi.useRealTimers());

describe("observedSessionSettings", () => {
  it("reports independently returned Default model and effort for a real session", () => {
    const f = fixture();
    f.send(f.batch([...f.open(), f.resolve()]));
    expect(f.reports()).toEqual([
      {
        sessionId: "S",
        turnId: "turn",
        workerIndex: 0,
        channelId: channel,
        sessionObservedAt: Date.now(),
        model: { value: "model-a", observedAt: Date.now() },
        effort: { value: "low", observedAt: Date.now() },
        requestedModel: null,
        modelRejection: null,
        requestedEffort: null,
        effortRejected: false,
        failedAt: null,
      },
    ]);
    f.release();
  });

  it("keeps requested Advanced values separate from independently returned values", () => {
    const f = fixture();
    const events = [
      ...f.open(),
      f.event("acp_write", 3, {
        id: 2,
        method: "session/set_config_option",
        params: { sessionId: "S", configId: "model", value: "model-b" },
      }),
      f.event("acp_read", 4, {
        id: 2,
        result: {
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "model-b",
            },
            {
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "medium",
            },
          ],
        },
      }),
      f.event("acp_write", 5, {
        id: 3,
        method: "session/set_config_option",
        params: {
          sessionId: "S",
          configId: "reasoning_effort",
          value: "high",
        },
      }),
      f.event("acp_read", 6, {
        id: 3,
        result: {
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "model-b",
            },
            {
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "high",
            },
          ],
        },
      }),
      f.resolve(),
    ];
    f.send(f.batch(events.reverse()));
    expect(f.reports()[0]).toMatchObject({
      model: { value: "model-b", observedAt: Date.now() },
      effort: { value: "high", observedAt: Date.now() },
      requestedModel: "model-b",
      requestedEffort: "high",
      modelRejection: null,
      effortRejected: false,
    });
    f.release();
  });

  it("folds notifications and setting responses by protocol sequence", () => {
    const f = fixture();
    const events = [
      ...f.open(),
      f.event("acp_read", 3, {
        method: "session/update",
        params: {
          sessionId: "S",
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              { id: "model", category: "model", currentValue: "model-a" },
              {
                id: "reasoning_effort",
                category: "thought_level",
                currentValue: "low",
              },
            ],
          },
        },
      }),
      f.event("acp_write", 4, {
        id: 2,
        method: "session/set_config_option",
        params: { sessionId: "S", configId: "model", value: "model-b" },
      }),
      f.event("acp_read", 5, {
        id: 2,
        result: {
          configOptions: [
            { id: "model", category: "model", currentValue: "model-b" },
            {
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "high",
            },
          ],
        },
      }),
      f.resolve(6),
    ];
    f.send(f.batch(events.reverse()));
    expect(f.reports()[0]).toMatchObject({
      model: { value: "model-b", observedAt: Date.now() },
      effort: { value: "high", observedAt: Date.now() },
      requestedModel: "model-b",
    });
    f.release();
  });

  it("never treats semantic capture or a successful empty response as actual settings", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open(),
        f.event("acp_write", 3, {
          id: 2,
          method: "session/set_config_option",
          params: { sessionId: "S", configId: "model", value: "model-b" },
        }),
        f.event("acp_read", 4, { id: 2, result: {} }),
        f.event("session_config_captured", 5, {
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "model-b",
            },
            {
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "high",
            },
          ],
        }),
        f.resolve(),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      model: null,
      effort: null,
      requestedModel: "model-b",
    });
    f.release();
  });

  it("reports explicit rejections and only a same-session reported fallback", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open(),
        f.event("acp_write", 3, {
          id: 2,
          method: "session/set_config_option",
          params: { sessionId: "S", configId: "model", value: "missing" },
        }),
        f.event("acp_read", 4, {
          id: 2,
          error: { code: -32602, message: "private model error" },
        }),
        f.event("control_result", 5, {
          type: "switch_model",
          status: "unsupported_model",
          modelId: "missing",
          error: "private semantic error",
        }),
        f.event("acp_write", 6, {
          id: 3,
          method: "session/set_config_option",
          params: {
            sessionId: "S",
            configId: "reasoning_effort",
            value: "extreme",
          },
        }),
        f.event("acp_read", 7, {
          id: 3,
          error: { code: -32602, message: "private effort error" },
        }),
        f.resolve(),
      ]),
    );
    expect(f.reports()[0]).toEqual({
      sessionId: "S",
      turnId: "turn",
      workerIndex: 0,
      channelId: channel,
      sessionObservedAt: Date.now(),
      model: { value: "model-a", observedAt: Date.now() },
      effort: { value: "low", observedAt: Date.now() },
      requestedModel: "missing",
      modelRejection: "unsupported",
      requestedEffort: "extreme",
      effortRejected: true,
      failedAt: null,
    });
    expect(JSON.stringify(f.reports())).not.toContain("private");
    f.release();
  });

  it("reports an unsupported model control result even when no switch RPC was sent", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open(),
        f.event("control_result", 3, {
          type: "switch_model",
          status: "unsupported_model",
          modelId: "not-in-catalog",
        }),
        f.resolve(4),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      model: { value: "model-a", observedAt: Date.now() },
      effort: { value: "low", observedAt: Date.now() },
      requestedModel: "not-in-catalog",
      modelRejection: "unsupported",
    });
    f.release();
  });

  it("invalidates old effort when a model update omits effort", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open(),
        f.event("acp_read", 3, {
          method: "session/update",
          params: {
            sessionId: "S",
            update: {
              sessionUpdate: "config_option_update",
              configOptions: [
                {
                  id: "model",
                  category: "model",
                  currentValue: "model-b",
                },
              ],
            },
          },
        }),
        f.resolve(4),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      model: { value: "model-b", observedAt: Date.now() },
      effort: null,
    });
    f.release();
  });

  it("does not assign one config ID to both model and effort", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open({
          configOptions: [
            { id: "shared", category: "model", currentValue: "model-a" },
            {
              id: "shared",
              category: "thought_level",
              currentValue: "low",
            },
          ],
        }),
        f.event("acp_write", 3, {
          id: 2,
          method: "session/set_config_option",
          params: { sessionId: "S", configId: "shared", value: "unknown" },
        }),
        f.event("acp_read", 4, {
          id: 2,
          error: { code: -32602, message: "private" },
        }),
        f.resolve(),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      requestedModel: null,
      modelRejection: null,
      requestedEffort: null,
      effortRejected: false,
    });
    f.release();
  });

  it("does not override an explicit unrelated category with a known config ID", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open(),
        f.event("acp_read", 3, {
          method: "session/update",
          params: {
            sessionId: "S",
            update: {
              sessionUpdate: "config_option_update",
              configOptions: [
                {
                  id: "reasoning_effort",
                  category: "mode",
                  currentValue: "auto",
                },
              ],
            },
          },
        }),
        f.resolve(4),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      effort: { value: "low", observedAt: Date.now() },
    });
    f.release();
  });

  it("marks a failed prompt without inventing unreported settings", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open({}),
        f.resolve(3),
        f.event(
          "acp_write",
          4,
          { id: 2, method: "session/prompt", params: { sessionId: "S" } },
          { sessionId: "S" },
        ),
        f.event(
          "acp_read",
          5,
          { id: 2, error: { code: -32000, message: "private failure" } },
          { sessionId: "S" },
        ),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      model: null,
      effort: null,
      failedAt: Date.now(),
    });
    expect(JSON.stringify(f.reports())).not.toContain("private failure");
    f.release();
  });

  it("projects a reused session turn from its own update and failure evidence", () => {
    const f = fixture();
    const options = {
      sessionId: "S",
      turnId: "reused-turn",
      startedAt: new Date(Date.now() + 1000).toISOString(),
    };
    f.send(
      f.batch([
        f.resolve(1, options),
        f.event(
          "acp_read",
          2,
          {
            method: "session/update",
            params: {
              sessionId: "S",
              update: {
                sessionUpdate: "config_option_update",
                configOptions: [
                  {
                    id: "model",
                    category: "model",
                    currentValue: "reported-model",
                  },
                  {
                    id: "reasoning_effort",
                    category: "thought_level",
                    currentValue: "medium",
                  },
                ],
              },
            },
          },
          { ...options, sessionId: "S" },
        ),
        f.event(
          "acp_write",
          3,
          { id: 1, method: "session/prompt", params: { sessionId: "S" } },
          { ...options, sessionId: "S" },
        ),
        f.event(
          "acp_read",
          4,
          { id: 1, error: { code: -32000, message: "private" } },
          { ...options, sessionId: "S" },
        ),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      sessionId: "S",
      turnId: "reused-turn",
      model: { value: "reported-model", observedAt: Date.now() },
      effort: { value: "medium", observedAt: Date.now() },
      failedAt: Date.now(),
    });
    f.release();
  });

  it("keeps typed RPC IDs distinct and accepts unscoped runtime turns", () => {
    const f = fixture();
    const options = { channelId: null };
    f.send(
      f.batch([
        f.event(
          "acp_write",
          1,
          { id: 1, method: "session/new", params: {} },
          options,
        ),
        f.event(
          "acp_read",
          2,
          {
            id: "1",
            result: {
              sessionId: "S",
              configOptions: [
                {
                  id: "model",
                  category: "model",
                  currentValue: "wrongly-correlated",
                },
              ],
            },
          },
          options,
        ),
        f.resolve(3, options),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      channelId: null,
      model: null,
      effort: null,
    });
    f.release();
  });

  it("retains an early failed turn without claiming a session or settings", () => {
    const f = fixture();
    f.send(
      f.batch([
        f.event("acp_write", 1, {
          id: 1,
          method: "session/new",
          params: {},
        }),
        f.event("acp_read", 2, {
          id: 1,
          error: { code: -32000, message: "private startup failure" },
        }),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({
      sessionId: null,
      sessionObservedAt: null,
      model: null,
      effort: null,
      failedAt: Date.now(),
    });
    f.release();
  });

  it("fails a turn projection closed when its relevant event bound is exceeded", () => {
    const f = fixture();
    const events = [...f.open(), f.resolve(3)];
    for (let index = 0; index < 64; index++)
      events.push(
        f.event("acp_read", 4 + index, {
          method: "session/update",
          params: {
            sessionId: "S",
            update: {
              sessionUpdate: "config_option_update",
              configOptions: [],
            },
          },
        }),
      );
    f.send(f.batch(events));
    expect(f.reports()).toEqual([]);
    f.release();
  });

  it("does not correlate orphan responses across turns, workers, or adapter requests", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open({}, { turnId: "one", agentIndex: 0 }),
        f.event(
          "acp_read",
          2,
          { id: 1, result: { sessionId: "S", configOptions: [] } },
          { turnId: "other", agentIndex: 0 },
        ),
        f.event(
          "acp_read",
          2,
          { id: 1, result: { sessionId: "S", configOptions: [] } },
          { turnId: "one", agentIndex: 1 },
        ),
        f.event(
          "acp_read",
          2,
          { id: 1, method: "request_permission", params: {} },
          { turnId: "one", agentIndex: 0 },
        ),
        f.resolve(3, { turnId: "one", agentIndex: 0 }),
      ]),
    );
    expect(f.reports()).toHaveLength(1);
    expect(f.reports()[0]).toMatchObject({ model: null, effort: null });
    f.release();
  });

  it("rejects ambiguous, malformed, and unsafe reported labels", () => {
    const f = fixture();
    f.send(
      f.batch([
        ...f.open({
          models: { currentModelId: "legacy-model" },
          configOptions: [
            {
              id: "model",
              category: "model",
              currentValue: "stable-model",
            },
            {
              id: "second-model",
              category: "model",
              currentValue: "other-model",
            },
            {
              id: "reasoning_effort",
              category: "thought_level",
              currentValue: "unsafe\nlabel",
            },
          ],
        }),
        f.resolve(),
      ]),
    );
    expect(f.reports()[0]).toMatchObject({ model: null, effort: null });
    f.release();
  });

  it("caps and orders independent sessions while preserving exact agent scope", () => {
    const f = fixture();
    for (let index = 0; index < 7; index++) {
      vi.setSystemTime(Date.now() + 1000);
      const options = {
        sessionId: `S${index}`,
        turnId: `turn-${index}`,
        startedAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      };
      f.send(f.batch([...f.open({}, options), f.resolve(3, options)]));
    }
    f.send(
      f.batch([
        ...f.open(
          {},
          {
            sessionId: "OTHER",
            turnId: "other-agent",
            startedAt: new Date().toISOString(),
          },
        ),
        f.resolve(3, {
          sessionId: "OTHER",
          turnId: "other-agent",
          startedAt: new Date().toISOString(),
        }),
      ]),
      otherAgent,
    );
    expect(f.reports().map((report) => report.sessionId)).toEqual([
      "S6",
      "S5",
      "S4",
      "S3",
      "S2",
    ]);
    f.release();
  });

  it("inherits activity access, generation, clear, and eviction boundaries", () => {
    const denied = fixture((channelId) => channelId !== channel);
    denied.send(denied.batch([...denied.open(), denied.resolve()]));
    expect(denied.reports()).toEqual([]);
    denied.release();

    const f = fixture();
    const oldGeneration = f.observe.mock.lastCall?.[0] as number;
    f.send(f.batch([...f.open(), f.resolve()]));
    expect(f.reports()).toHaveLength(1);
    f.owner.clear();
    expect(f.reports()).toEqual([]);
    f.send(f.batch([...f.open(), f.resolve()]), agent, oldGeneration);
    expect(f.reports()).toEqual([]);

    const generation = f.observe.mock.lastCall?.[0] as number;
    f.send(f.batch([...f.open(), f.resolve()]), agent, generation);
    for (let index = 0; index < 200; index++)
      f.send(f.event("unrelated", index, { value: index }), agent, generation);
    expect(f.reports()).toEqual([]);
    f.release();
  });
});
