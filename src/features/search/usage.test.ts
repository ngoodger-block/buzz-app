// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createNavigationController } from "../navigation/controller";
import { createMemoryHistory } from "../navigation/history";
import type { OpenTarget } from "../navigation/targets";
import { clearViewScope, writeView } from "../../shared/view-state";
import {
  bindSearchUsage,
  HALF_LIFE_MS,
  MAX_BOOST,
  pickerText,
  readSearchUsage,
  recordChoice,
  recordVisit,
  usageScope,
} from "./usage";

const viewer = "a".repeat(64);
const scope = usageScope({
  viewer,
  communityOrigin: "wss://relay.example",
});
const now = 1_800_000_000_000;

afterEach(() => localStorage.clear());

it("lets visits lose half their weight each week and caps how far they lift", () => {
  recordVisit(scope, "channel:old", now - 2 * HALF_LIFE_MS);
  recordVisit(scope, "channel:new", now - 2 * HALF_LIFE_MS);
  recordVisit(scope, "channel:new", now);
  const usage = readSearchUsage(scope, now);
  // One visit two weeks old is worth a quarter of a visit.
  expect(usage.boost("channel:old")).toBeCloseTo((MAX_BOOST * 0.25) / 4.25);
  expect(usage.boost("channel:new")).toBeCloseTo((MAX_BOOST * 1.25) / 5.25);
  expect(usage.boost("channel:never")).toBe(0);
  for (let visit = 0; visit < 1000; visit++)
    recordVisit(scope, "channel:busy", now);
  expect(readSearchUsage(scope, now).boost("channel:busy")).toBeLessThan(
    MAX_BOOST,
  );
});

it("remembers the choice for typed text, its prefixes and its extensions", () => {
  recordChoice(scope, "wo", "channel:workflows", now - 2);
  recordChoice(scope, "we", "channel:welcome", now - 1);
  const usage = readSearchUsage(scope, now);
  const both = new Set(["channel:workflows", "channel:welcome"]);
  expect(usage.pick("wo", both)).toBe("channel:workflows");
  expect(usage.pick("wor", both)).toBe("channel:workflows");
  // Typing less matches both texts; the more recent choice wins.
  expect(usage.pick("w", both)).toBe("channel:welcome");
  // A choice that no longer matches the typed text is not offered.
  expect(usage.pick("w", new Set(["channel:workflows"]))).toBe(
    "channel:workflows",
  );
  expect(usage.pick("x", both)).toBeUndefined();
  expect(usage.pick("", both)).toBeUndefined();
  // Choosing counts as more than an ordinary open.
  recordVisit(scope, "channel:opened", now);
  expect(usage.boost("channel:workflows")).toBeGreaterThan(
    readSearchUsage(scope, now).boost("channel:opened"),
  );
});

it("replaces the earlier choice for the same text, and keeps pickers apart", () => {
  recordChoice(scope, "wo", "channel:workflows", now - 3);
  recordChoice(scope, "wo", "channel:work", now - 2);
  // The replaced choice does not come back while its successor is missing.
  const usage = readSearchUsage(scope, now);
  expect(usage.pick("wo", new Set(["channel:workflows"]))).toBeUndefined();
  expect(usage.pick("wo", new Set(["channel:work"]))).toBe("channel:work");
  // A picker's text is its own: it neither replaces nor matches Command-K's.
  recordChoice(scope, pickerText("dm", "wo"), "person:woody", now - 1);
  const later = readSearchUsage(scope, now);
  expect(later.pick("wo", new Set(["channel:work"]))).toBe("channel:work");
  expect(later.pick("w", new Set(["person:woody"]))).toBeUndefined();
  expect(later.pick(pickerText("dm", "w"), new Set(["person:woody"]))).toBe(
    "person:woody",
  );
  expect(pickerText("dm", "")).toBe("");
});

it("scores a row by the sum of its keys", () => {
  recordVisit(scope, "channel:dm", now);
  recordChoice(scope, "", "person:logan", now);
  const usage = readSearchUsage(scope, now);
  expect(usage.boost("person:logan", "channel:dm")).toBeGreaterThan(
    usage.boost("person:logan"),
  );
  expect(usage.boost("person:logan", "channel:dm")).toBeLessThan(MAX_BOOST);
  expect(usage.boost()).toBe(0);
});

it("keeps each community apart, bounds its size and ignores malformed data", () => {
  const other = usageScope({
    viewer,
    communityOrigin: "wss://other.example",
  });
  recordChoice(scope, "wo", "channel:workflows", now);
  expect(
    readSearchUsage(other, now).pick("wo", new Set(["channel:workflows"])),
  ).toBeUndefined();
  for (let index = 0; index < 250; index++) {
    recordVisit(other, `channel:${index}`, now + index);
    recordChoice(other, `text-${index}`, "channel:x", now + index);
  }
  const saved = JSON.parse(
    localStorage.getItem(
      `buzz-view.v1:${JSON.stringify([other, "search-usage"])}`,
    ) ?? "{}",
  );
  expect(saved.visits).toHaveLength(200);
  expect(saved.picks).toHaveLength(200);
  writeView(scope, "search-usage", {
    visits: [["channel:a", "x", 1], null, ["channel:b", 1, now]],
    picks: "nope",
  });
  const usage = readSearchUsage(scope, now);
  expect(usage.boost("channel:a")).toBe(0);
  expect(usage.boost("channel:b")).toBeGreaterThan(0);
  expect(usage.pick("wo", new Set(["channel:workflows"]))).toBeUndefined();
  // Leaving a community clears its view state, and this with it.
  clearViewScope(other);
  expect(readSearchUsage(other, now).boost("channel:0")).toBe(0);
});

it("counts every completed open once, but not the destination restored at startup", async () => {
  const conversation: OpenTarget = {
    version: 1,
    kind: "conversation",
    scope: { viewer, communityOrigin: "wss://relay.example" },
    channelId: "general",
  };
  const history = createMemoryHistory(
    { ...conversation, channelId: "restored" },
    100,
  );
  const host = createNavigationController(history);
  let selected: typeof conversation.scope | undefined = conversation.scope;
  const stop = bindSearchUsage(host.navigation, () => selected);
  try {
    host.complete(host.navigation.snapshot().attempt, { status: "opened" });
    const opened = host.navigation.open(conversation);
    host.complete(host.navigation.snapshot().attempt, { status: "opened" });
    await opened;
    // Personal-space pages belong to no community.
    const personal = host.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.todos",
      pageId: "todos",
      scope: null,
    });
    host.complete(host.navigation.snapshot().attempt, { status: "opened" });
    await personal;
    // Cmd/Ctrl+, opens Settings without a scope: it stays in the selected
    // community, so the visit counts there.
    const settings = host.navigation.open({ version: 1, kind: "settings" });
    host.complete(host.navigation.snapshot().attempt, { status: "opened" });
    await settings;
    // With no community selected, an unscoped open belongs to none.
    selected = undefined;
    const unscoped = host.navigation.open({
      version: 1,
      kind: "page",
      pluginId: "buzz.todos",
      pageId: "todos",
    });
    host.complete(host.navigation.snapshot().attempt, { status: "opened" });
    await unscoped;
    const failed = host.navigation.open({ ...conversation, channelId: "gone" });
    host.complete(host.navigation.snapshot().attempt, {
      status: "failed",
      reason: "not-found",
    });
    await failed;
    const usage = readSearchUsage(scope);
    expect(usage.boost("channel:general")).toBeCloseTo((MAX_BOOST * 1) / 5, 3);
    expect(usage.boost("channel:gone")).toBe(0);
    expect(usage.boost("channel:restored")).toBe(0);
    expect(usage.boost("buzz.todos/todos")).toBe(0);
    expect(usage.boost("settings")).toBeCloseTo((MAX_BOOST * 1) / 5, 3);
  } finally {
    stop();
    host.dispose();
  }
});
