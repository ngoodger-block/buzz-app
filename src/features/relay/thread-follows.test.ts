// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  browserThreadFollows,
  forgetThreadFollows,
  THREAD_FOLLOW_LIMIT,
} from "./thread-follows";

afterEach(() => localStorage.clear());
const alice = "https://one.example:" + "a".repeat(64);
const bob = "https://one.example:" + "b".repeat(64);
const elsewhere = "https://two.example:" + "a".repeat(64);

it("keeps each community and viewer's choices apart across reloads", () => {
  browserThreadFollows(alice).write(new Map([["c:r", true]]));
  browserThreadFollows(elsewhere).write(new Map([["c:r", false]]));
  expect([...browserThreadFollows(alice).read()]).toEqual([["c:r", true]]);
  expect([...browserThreadFollows(elsewhere).read()]).toEqual([["c:r", false]]);
  expect(browserThreadFollows(bob).read().size).toBe(0);
  forgetThreadFollows(alice);
  expect(browserThreadFollows(alice).read().size).toBe(0);
  expect(browserThreadFollows(elsewhere).read().size).toBe(1);
});

it("ignores malformed entries and keeps only the newest choices", () => {
  const entries = Array.from(
    { length: THREAD_FOLLOW_LIMIT + 1 },
    (_, index) => [`c:${index}`, true],
  );
  localStorage.setItem(
    `buzz.thread-follows.v1:${alice}`,
    JSON.stringify([["bad", "yes"], 7, ...entries]),
  );
  const read = browserThreadFollows(alice).read();
  expect(read.size).toBe(THREAD_FOLLOW_LIMIT);
  expect(read.has("c:0")).toBe(false);
  expect(read.get(`c:${THREAD_FOLLOW_LIMIT}`)).toBe(true);
  localStorage.setItem(`buzz.thread-follows.v1:${alice}`, "{");
  expect(browserThreadFollows(alice).read().size).toBe(0);
});

it("hears only its own scope's saves from other windows", () => {
  const listener = vi.fn();
  const stop = browserThreadFollows(alice).subscribe(listener);
  const save = (key: string | null) =>
    window.dispatchEvent(new StorageEvent("storage", { key }));
  save(`buzz.thread-follows.v1:${bob}`);
  expect(listener).not.toHaveBeenCalled();
  save(`buzz.thread-follows.v1:${alice}`);
  save(null);
  expect(listener).toHaveBeenCalledTimes(2);
  stop();
  save(`buzz.thread-follows.v1:${alice}`);
  expect(listener).toHaveBeenCalledTimes(2);
});
