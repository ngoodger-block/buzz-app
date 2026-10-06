import { relayOrigin } from "../communities/destination";
import type { Navigation } from "../navigation/controller";
import { relayPartition } from "../relay/partition";
import type { NavigationScope, OpenTarget } from "../navigation/targets";
import { readView, writeView } from "../../shared/view-state";

/** What this device remembers about where a viewer goes in one community, so
 * search can put those places first. Kept in view state, partitioned like the
 * rest of it by `origin:viewer`; leaving a community clears it. Nothing here
 * goes to the relay. */
const KEY = "search-usage";
const LIMIT = 200;
/** A visit is worth half as much after a week. */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** A search choice also opens its destination, which counts one visit. */
const CHOICE_WEIGHT = 2;
/** The most a usage score can lift a match: past a slightly better match
 * (one rank), never past a much better one (two ranks). */
export const MAX_BOOST = 1.5;

type Stored = {
  version: 1;
  /** [destination key, decayed score, score time] */
  visits: [string, number, number][];
  /** [typed text, destination key, time] */
  picks: [string, string, number][];
};

const isTuple = <T extends unknown[]>(
  value: unknown,
  ...types: string[]
): value is T =>
  Array.isArray(value) &&
  value.length === types.length &&
  value.every((part, index) =>
    types[index] === "number"
      ? Number.isFinite(part)
      : typeof part === types[index],
  );

function read(scope: string): Stored {
  const value = readView<unknown>(scope, KEY, null);
  const stored = value as Partial<Stored> | null;
  return {
    version: 1,
    visits: Array.isArray(stored?.visits)
      ? stored.visits.filter((entry) =>
          isTuple<[string, number, number]>(
            entry,
            "string",
            "number",
            "number",
          ),
        )
      : [],
    picks: Array.isArray(stored?.picks)
      ? stored.picks.filter((entry) =>
          isTuple<[string, string, number]>(
            entry,
            "string",
            "string",
            "number",
          ),
        )
      : [],
  };
}

const decayed = (score: number, at: number, now: number) =>
  score * 2 ** (-Math.max(0, now - at) / HALF_LIFE_MS);

function addVisit(stored: Stored, key: string, weight: number, now: number) {
  const previous = stored.visits.find(([visited]) => visited === key);
  const score =
    (previous ? decayed(previous[1], previous[2], now) : 0) + weight;
  stored.visits = [
    [key, score, now] as [string, number, number],
    ...stored.visits.filter(([visited]) => visited !== key),
  ]
    .sort((a, b) => decayed(b[1], b[2], now) - decayed(a[1], a[2], now))
    .slice(0, LIMIT);
}

/** Counts one open of `key`, from anywhere in the app. */
export function recordVisit(scope: string, key: string, now = Date.now()) {
  const stored = read(scope);
  addVisit(stored, key, 1, now);
  writeView(scope, KEY, stored);
}

/** Typed text in a picker other than Command-K. Each picker keeps its own
 * earlier choices, so a choice in one cannot replace another's for the same
 * text. The prefix cannot be typed, so Command-K text never matches it. */
export const pickerText = (picker: string, typed: string) =>
  typed ? `\u0000${picker}\u0000${typed}` : "";

/** Remembers that typed text led to `key`, replacing the earlier choice for
 * that text. A search choice counts more than an ordinary open; the open that
 * follows adds its own visit. */
export function recordChoice(
  scope: string,
  typed: string,
  key: string,
  now = Date.now(),
) {
  const stored = read(scope);
  addVisit(stored, key, CHOICE_WEIGHT, now);
  if (typed)
    stored.picks = [
      [typed, key, now] as [string, string, number],
      ...stored.picks.filter(([text]) => text !== typed),
    ].slice(0, LIMIT);
  writeView(scope, KEY, stored);
}

export type SearchUsage = {
  /** How far usage lifts a match's rank, from 0 up to MAX_BOOST. Several
   * keys for one row, such as a person and their DM, share one score. */
  boost(...keys: string[]): number;
  /** The destination last chosen for this typed text, a longer text that
   * starts with it, or a shorter text it starts with, among `candidates`. */
  pick(typed: string, candidates: ReadonlySet<string>): string | undefined;
};

export const noSearchUsage: SearchUsage = {
  boost: () => 0,
  pick: () => undefined,
};

export function readSearchUsage(scope: string, now = Date.now()): SearchUsage {
  const stored = read(scope);
  const scores = new Map(
    stored.visits.map(([key, score, at]) => [key, decayed(score, at, now)]),
  );
  return {
    // Half the maximum at four visits' worth of score.
    boost: (...keys) => {
      const score = keys.reduce((sum, key) => sum + (scores.get(key) ?? 0), 0);
      return (MAX_BOOST * score) / (score + 4);
    },
    pick(typed, candidates) {
      if (!typed) return undefined;
      const related = stored.picks.filter(
        ([text, key]) =>
          candidates.has(key) &&
          (text.startsWith(typed) || typed.startsWith(text)),
      );
      return (related.find(([text]) => text === typed) ??
        related.sort((a, b) => b[2] - a[2])[0])?.[1];
    },
  };
}

/** The view-state partition for a community, as the rest of view state uses. */
export function usageScope(scope: NavigationScope) {
  return relayPartition(
    relayOrigin(scope.communityOrigin),
    scope.viewer.toLowerCase(),
  );
}

/** The search destination key that an opened target corresponds to. An
 * omitted scope leaves the selected community alone, so the open belongs to
 * that community; an explicit null scope is Personal space, which has none. */
function visited(
  target: OpenTarget,
  selectedScope: () => NavigationScope | undefined,
): { scope: string; key: string } | undefined {
  if (target.kind === "home" || target.scope === null) return undefined;
  const scope = target.scope ?? selectedScope();
  if (!scope) return undefined;
  const key =
    target.kind === "conversation"
      ? `channel:${target.channelId}`
      : target.kind === "page"
        ? `${target.pluginId}/${target.pageId}`
        : "settings";
  return { scope: usageScope(scope), key };
}

/** Counts every completed open as a visit: sidebar, links, notifications,
 * shortcuts, history and search alike. The destination already showing at
 * startup is a restore, not a visit. `selectedScope` is the community selected
 * when an open completes. */
export function bindSearchUsage(
  navigation: Navigation,
  selectedScope: () => NavigationScope | undefined,
) {
  let counted = navigation.snapshot().attempt.id;
  return navigation.subscribe(() => {
    const snapshot = navigation.snapshot();
    if (snapshot.status !== "opened" || snapshot.attempt.id === counted) return;
    counted = snapshot.attempt.id;
    const visit = visited(snapshot.entry.target, selectedScope);
    if (visit) recordVisit(visit.scope, visit.key);
  });
}
