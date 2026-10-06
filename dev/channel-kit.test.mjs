import { expect, it } from "vitest";
import canvasCases from "../src/features/channel-templates/canvas-signing-contract.json";
import { keypair, signed } from "../src/features/relay/testing.ts";
import {
  coordinate,
  KIT_TAG,
  parseKitRecord,
  resolveLineup,
} from "../src/features/channel-templates/model.ts";
import {
  admitChannelKit,
  decodeChannelKit,
  prepareChannelKit,
  validCanvas,
} from "./channel-kit.mjs";

const community = "https://relay.example.test";
const owner = keypair();
const record = {
  version: 1,
  community,
  deleted: false,
  value: {
    type: "template",
    id: "daily",
    name: "Daily",
    description: "",
    teamIds: [],
    agents: [owner.pubkey],
    canvas: "Private working instructions",
  },
};
function encrypted(value = record, tags) {
  return signed(owner, {
    kind: 30078,
    content: prepareChannelKit(value, owner.secret, community),
    tags: tags ?? [
      ["d", coordinate(value)],
      ["t", KIT_TAG],
    ],
  });
}

it("self-encrypts private recipes and admits only the exact community/coordinate", () => {
  const event = encrypted();
  expect(event.content).not.toContain(record.value.canvas);
  expect(decodeChannelKit([event], owner.secret, community)).toEqual([
    { eventId: event.id, record },
  ]);
  expect(() =>
    admitChannelKit(event, owner.secret, "https://elsewhere.test"),
  ).toThrow();
  expect(() => decodeChannelKit([event], keypair().secret, community)).toThrow(
    /another viewer/,
  );
  expect(() =>
    admitChannelKit(
      { ...event, tags: [...event.tags, ["p", owner.pubkey]] },
      owner.secret,
      community,
    ),
  ).toThrow(/coordinate/);
  expect(() =>
    admitChannelKit(
      {
        ...event,
        tags: [
          ["d", "wrong"],
          ["t", KIT_TAG],
        ],
      },
      owner.secret,
      community,
    ),
  ).toThrow(/coordinate/);
  expect(() =>
    decodeChannelKit(Array(17).fill(event), owner.secret, community),
  ).toThrow(/capacity/);
});

it("rejects malformed/oversized recipes and mismatched ciphertext", () => {
  expect(() =>
    parseKitRecord(
      {
        ...record,
        value: { ...record.value, agents: [owner.pubkey, owner.pubkey] },
      },
      community,
    ),
  ).toThrow(/selection/);
  expect(() =>
    prepareChannelKit(
      { ...record, value: { ...record.value, canvas: "x".repeat(17 * 1024) } },
      owner.secret,
      community,
    ),
  ).toThrow(/16 KiB/);
  expect(() =>
    admitChannelKit(
      { ...encrypted(), content: "broken" },
      owner.secret,
      community,
    ),
  ).toThrow();
  const tombstone = { ...record, deleted: true };
  expect(
    decodeChannelKit([encrypted(tombstone)], owner.secret, community)[0].record
      .deleted,
  ).toBe(true);
});

it("expands multiple teams and individual agents by exact key without namesake collapse", () => {
  const other = keypair().pubkey;
  const entries = ["first", "second"].map((id, i) => ({
    eventId: id,
    createdAt: 1,
    record: {
      ...record,
      value: {
        type: "team",
        id,
        name: id,
        agents: i ? [other] : [owner.pubkey, other],
      },
    },
  }));
  const lineup = {
    teamIds: ["first", "second"],
    agents: [owner.pubkey],
    canvas: "",
  };
  const choices = [owner.pubkey, other].map((pubkey) => ({
    pubkey,
    name: "Namesake",
  }));
  expect(resolveLineup(lineup, entries, choices)).toEqual(choices);
  expect(() => resolveLineup(lineup, [], choices)).toThrow(
    /team is unavailable/,
  );
  expect(() => resolveLineup(lineup, entries, choices.slice(0, 1))).toThrow(
    /unavailable in this community/,
  );
});

// Shape only: the broker additionally checks freshness; Rust also deserializes
// EventTemplate and bounds the signed serialization. See contributing.md.
it.each(canvasCases)("Canvas signing shape: $name", ({ accepted, tags }) => {
  expect(validCanvas({ kind: 40100, content: "# Plan", tags })).toBe(accepted);
});

it("bounds Canvas content in UTF-8 bytes, not JavaScript characters", () => {
  const canvas = {
    kind: 40100,
    tags: [["h", "11111111-1111-4111-8111-111111111111"]],
  };
  const content = "é".repeat(12 * 1024);
  expect(validCanvas({ ...canvas, content })).toBe(true);
  expect(validCanvas({ ...canvas, content: `${content}x` })).toBe(false);
});
