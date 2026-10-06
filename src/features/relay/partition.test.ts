import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import {
  relayPartition,
  splitPartition,
  transportOrigin,
  transportPartition,
} from "./partition";
import { keypair, scriptedTransport } from "./testing";
import type { ReadTransport } from "./transport";

// Record the partition bytes each durable owner receives without opening storage.
const opened = vi.hoisted(() => ({
  outbox: [] as string[],
  readState: [] as string[],
  setup: [] as string[],
  choices: [] as string[],
}));
vi.mock("./outbox-storage", async (original) => ({
  ...(await original<typeof import("./outbox-storage")>()),
  browserOutboxStorage: (scope: string) => {
    opened.outbox.push(scope);
    return { load: () => [], save: () => {} };
  },
}));
vi.mock("./read-state-storage", async (original) => ({
  ...(await original<typeof import("./read-state-storage")>()),
  browserReadStateStorage: (scope: string) => {
    opened.readState.push(scope);
    return {
      update: async () => Promise.reject(new Error("unused")),
      close() {},
    };
  },
}));
vi.mock("../channel-templates/setup", async (original) => {
  const actual = await original<typeof import("../channel-templates/setup")>();
  return {
    ...actual,
    createChannelSetup: (
      options: Parameters<typeof actual.createChannelSetup>[0],
    ) => {
      opened.setup.push(options.scope);
      return actual.createChannelSetup(options);
    },
  };
});
vi.mock("../agents/choices", async (original) => {
  const actual = await original<typeof import("../agents/choices")>();
  return {
    ...actual,
    createAgentChoices: (
      options: Parameters<typeof actual.createAgentChoices>[0],
    ) => {
      opened.choices.push(options.scope);
      return actual.createAgentChoices(options);
    },
  };
});

const viewer = keypair().pubkey;
const relay = keypair().pubkey;
const origin = "https://community.example";
const sessions: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const list of Object.values(opened)) list.splice(0);
});

function writable(scope?: string): ReadTransport {
  return {
    ...scriptedTransport(viewer, relay).transport,
    ...(scope ? { scope } : {}),
    writer: {
      sign: () => Promise.reject(new Error("unused")),
      publish: async () => {
        throw new Error("unused");
      },
    },
    channelKit: { decode: async () => [], prepare: async () => "" },
  };
}

it("keeps the persisted `origin:viewer` bytes and the relay-author fallback", () => {
  expect(relayPartition(origin, viewer)).toBe(`${origin}:${viewer}`);
  expect(transportOrigin({ scope: origin, relayAuthor: relay, viewer })).toBe(
    origin,
  );
  expect(
    transportPartition({ scope: origin, relayAuthor: relay, viewer }),
  ).toBe(`${origin}:${viewer}`);
  expect(transportOrigin({ relayAuthor: relay, viewer })).toBe(relay);
  expect(transportPartition({ relayAuthor: relay, viewer })).toBe(
    `${relay}:${viewer}`,
  );
});

it("opens every session-owned partition with the exact existing bytes", () => {
  for (const [transport, partition] of [
    [writable(origin), `${origin}:${viewer}`],
    [writable(), `${relay}:${viewer}`],
  ] as const) {
    sessions.push(createRelaySession(transport));
    expect(opened).toEqual({
      outbox: [partition],
      readState: [partition],
      setup: [partition],
      choices: [partition],
    });
    for (const list of Object.values(opened)) list.splice(0);
  }
  // Offline keeps its historical, distinct keys: read state is `offline:` and
  // agent choices never match a community.
  sessions.push(createRelaySession(null));
  expect(opened).toEqual({
    outbox: [],
    readState: ["offline:"],
    setup: [],
    choices: ["undefined:undefined"],
  });
});

it("splits a partition back into its origin and viewer, ports included", () => {
  const viewer = "a".repeat(64);
  for (const origin of ["https://relay.example", "http://127.0.0.1:3000"])
    expect(splitPartition(relayPartition(origin, viewer))).toEqual({
      communityOrigin: origin,
      viewer,
    });
  expect(splitPartition("no-separator")).toBeUndefined();
});
