import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createEnrollment } from "./enrollment";
import { enrollmentFixture } from "./enrollment-testing";
import type { RemoteAgent } from "./client";
import { PublishRejected } from "../../../features/relay/outbox";

const agent: RemoteAgent = {
  id: "one",
  name: "Helper",
  pubkey: "ab".repeat(32),
  status: "Active",
};
const owners: ReturnType<typeof enrollmentFixture>[] = [];
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture(kinds?: readonly number[]) {
  const login = createOAuthSession(async () => ({
    value: "secret",
    account: { subject: "user", email: "a@example.com" },
  }));
  await login.signIn();
  const h = enrollmentFixture(login, "https://community.example", kinds);
  owners.push(h);
  return {
    ...h,
    login,
    signal: new AbortController().signal,
    client: { delete: vi.fn(async () => {}) },
  };
}

it("resumes a saved enrollment with the original signed event after a lost receipt", async () => {
  const h = await fixture();
  h.publish.mockRejectedValueOnce(new Error("receipt lost"));
  const context = h.enrollment.capture();
  h.enrollment.remember(context, agent);
  await expect(
    h.enrollment.publish(context, agent, h.signal, () => true),
  ).rejects.toThrow("receipt lost");
  await vi.waitFor(() => expect(h.saved()[0]?.delivery).toBe("unknown"));
  const first = h.publish.mock.calls[0]?.[0];
  await h.restart();
  const restored = createEnrollment(h.relay, h.reader, h.login);
  await restored.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.publish.mock.calls[1]?.[0]).toEqual(first);
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(restored.pending([agent])).toEqual([]);
});

it("recovers the activation-to-outbox gap only for intended Active agents", async () => {
  const h = await fixture();
  await h.enrollment.recover([agent], h.signal, () => true);
  expect(h.sign).not.toHaveBeenCalled();
  h.enrollment.remember(h.enrollment.capture(), agent);
  const restored = createEnrollment(h.relay, h.reader, h.login);
  for (const status of ["Unattested", "Revoked", "Unknown"] as const)
    await restored.recover([{ ...agent, status }], h.signal, () => true);
  expect(h.sign).not.toHaveBeenCalled();
  await restored.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(restored.pending([agent])).toEqual([]);
});

it.each(["community", "account", "card", "abort"])(
  "fences %s changes while registration signing is held",
  async (change) => {
    const h = await fixture();
    const gate = deferred<void>();
    const sign = h.sign.getMockImplementation();
    if (!sign) throw new Error("Missing signer");
    h.sign.mockImplementationOnce(async (event) => {
      await gate.promise;
      return sign(event);
    });
    const controller = new AbortController();
    let active = true;
    const context = h.enrollment.capture();
    h.enrollment.remember(context, agent);
    const result = h.enrollment
      .publish(context, agent, controller.signal, () => active)
      .catch((error) => error);
    try {
      await vi.waitFor(() => expect(h.sign).toHaveBeenCalledTimes(1));
      if (change === "community") h.setCommunity("https://other.example");
      if (change === "account") h.login.signOut();
      if (change === "card") active = false;
      if (change === "abort") controller.abort();
      gate.resolve();
      expect(await result).toBeInstanceOf(Error);
      await vi.waitFor(() =>
        expect(h.relay.snapshot().session.outbox?.snapshot()[0]?.delivery).toBe(
          "failed",
        ),
      );
      expect(h.publish).not.toHaveBeenCalled();
      if (change === "community") {
        expect(h.enrollment.pending([agent])).toEqual([]);
        h.setCommunity("https://community.example");
        expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
      }
    } finally {
      gate.resolve();
      await result;
    }
  },
);

it("retains accepted delivery when discovery fails, then refreshes without another publication", async () => {
  const h = await fixture();
  const query = h.query.getMockImplementation();
  if (!query) throw new Error("Missing reader");
  h.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30175)))
      throw new Error("inventory unavailable");
    return query(filters);
  });
  h.enrollment.remember(h.enrollment.capture(), agent);
  await expect(
    h.enrollment.recover([agent], h.signal, () => true),
  ).rejects.toThrow("discovery is pending");
  expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
  h.query.mockImplementation(query);
  await h.enrollment.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.enrollment.pending([agent])).toEqual([]);
});

it("drains an inventory read started before publication before refreshing discovery", async () => {
  const h = await fixture();
  const inventory = deferred<Awaited<ReturnType<typeof h.query>>>();
  h.query.mockImplementationOnce(() => inventory.promise);
  const prior = h.relay.snapshot().session.agentChoices.refresh();
  await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
  h.enrollment.remember(h.enrollment.capture(), agent);
  const recovered = h.enrollment.recover([agent], h.signal, () => true);
  try {
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    inventory.resolve([]);
    await prior;
    await recovered;
    expect(h.enrollment.pending([agent])).toEqual([]);
  } finally {
    inventory.resolve([]);
    await Promise.allSettled([prior, recovered]);
  }
});

it.each(["receipt dismissal", "intent removal"])(
  "recovers an interruption during %s after acknowledgment without republishing",
  async (boundary) => {
    const h = await fixture();
    h.enrollment.remember(h.enrollment.capture(), agent);
    const save = h.save.getMockImplementation();
    if (!save) throw new Error("Missing storage");
    if (boundary === "receipt dismissal") {
      h.save.mockImplementation(async (next) => {
        if (!next.length && h.events.length)
          throw new Error("cleanup interrupted");
        return save(next);
      });
    } else {
      vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
        throw new Error("cleanup interrupted");
      });
    }
    await expect(
      h.enrollment.recover([agent], h.signal, () => true),
    ).rejects.toThrow("cleanup interrupted");
    expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
    if (boundary === "receipt dismissal")
      expect(h.saved()[0]?.acknowledged).toBe(true);
    h.save.mockImplementation(save);
    await h.restart();
    await h.enrollment.recover([agent], h.signal, () => true);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual([]);
    expect(h.enrollment.pending([agent])).toEqual([]);
  },
);

it("keeps enrollment and deletion intent scoped to the verified account", async () => {
  const h = await fixture();
  h.enrollment.remember(h.enrollment.capture(), agent);
  const other = createOAuthSession(async () => ({
    value: "other-secret",
    account: { subject: "other", email: "a@example.com" },
  }));
  await other.signIn();
  const enrollment = createEnrollment(h.relay, h.reader, other);
  expect(enrollment.pending([agent])).toEqual([]);
  await enrollment.recover([agent], h.signal, () => true);
  expect(h.publish).not.toHaveBeenCalled();
  await h.enrollment.remove(agent, h.client, h.signal, () => true);
  expect(h.enrollment.deleting(agent)).toBe(true);
  expect(enrollment.deleting(agent)).toBe(false);
});

it.each([new PublishRejected("denied"), new Error("receipt lost")])(
  "does not delete the runtime after unconfirmed relay delivery: %s",
  async (failure) => {
    const h = await fixture();
    h.publish.mockRejectedValueOnce(failure);
    await expect(
      h.enrollment.remove(agent, h.client, h.signal, () => true),
    ).rejects.toThrow(failure.message);
    expect(h.client.delete).not.toHaveBeenCalled();
    expect(h.enrollment.deleting(agent)).toBe(true);
    expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual([]);
  },
);

it("keeps deletion intent across restart and retries with a fresh event after backend failure", async () => {
  const startedAt = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
  const h = await fixture();
  h.enrollment.remember(h.enrollment.capture(), agent);
  await h.enrollment.recover([agent], h.signal, () => true);
  h.enrollment.remember(h.enrollment.capture(), agent);
  h.client.delete.mockRejectedValueOnce(new Error("backend offline"));
  await expect(
    h.enrollment.remove(agent, h.client, h.signal, () => true),
  ).rejects.toThrow("backend offline");
  expect(h.relay.snapshot().session.agentChoices.snapshot().identities).toEqual(
    [],
  );
  const first = h.events.find((event) => event.kind === 5);
  expect(first).toMatchObject({
    pubkey: h.viewer,
    content: "",
    tags: [
      ["a", `30177:${h.viewer}:${agent.pubkey}`],
      ["client-id", expect.any(String)],
    ],
  });
  await h.restart();
  const restored = createEnrollment(h.relay, h.reader, h.login);
  expect(restored.pending([agent])).toEqual([]);
  await restored.recover([agent], h.signal, () => true);
  expect(h.events.map((event) => event.kind)).toEqual([30177, 5]);
  clock.mockReturnValue(startedAt + 20 * 60_000);
  await restored.remove(agent, h.client, h.signal, () => true);
  const second = h.events.at(-1);
  expect(second?.kind).toBe(5);
  expect(second?.id).not.toBe(first?.id);
  expect(second?.created_at).toBe((first?.created_at ?? 0) + 20 * 60);
  expect(h.client.delete).toHaveBeenCalledTimes(2);
  // A stale row/intent in another window remains fenced even after successful deletion.
  expect(restored.deleting(agent)).toBe(true);
  await expect(
    restored.publish(restored.capture(), agent, h.signal, () => true),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it.each(["community", "account", "card", "abort"])(
  "does not contact Builderlab after %s changes during deletion publication",
  async (change) => {
    const h = await fixture();
    const gate = deferred<void>();
    const publish = h.publish.getMockImplementation();
    if (!publish) throw new Error("Missing publisher");
    h.publish.mockImplementationOnce(async (event) => {
      await gate.promise;
      return publish(event);
    });
    let active = true;
    const controller = new AbortController();
    const removing = h.enrollment
      .remove(agent, h.client, controller.signal, () => active)
      .catch((error) => error);
    try {
      await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
      if (change === "community") h.setCommunity("https://other.example");
      if (change === "account") h.login.signOut();
      if (change === "card") active = false;
      if (change === "abort") controller.abort();
      gate.resolve();
      expect(await removing).toMatchObject({ name: "AbortError" });
      expect(h.client.delete).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await removing;
    }
  },
);

it("fences a registration still signing in another window", async () => {
  const h = await fixture();
  h.enrollment.remember(h.enrollment.capture(), agent);
  const gate = deferred<void>();
  const sign = h.sign.getMockImplementation();
  if (!sign) throw new Error("Missing signer");
  h.sign.mockImplementationOnce(async (event) => {
    await gate.promise;
    return sign(event);
  });
  const enrolling = h.enrollment
    .recover([agent], h.signal, () => true)
    .catch((error) => error);
  try {
    await vi.waitFor(() => expect(h.sign).toHaveBeenCalledTimes(1));
    const otherWindow = createEnrollment(h.relay, h.reader, h.login);
    await otherWindow.remove(agent, h.client, h.signal, () => true);
    gate.resolve();
    expect(await enrolling).toBeInstanceOf(Error);
    expect(h.events.map((event) => event.kind)).toEqual([5]);
    expect(h.client.delete).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve();
    await enrolling;
  }
});

it("fails before any write if deletion intent cannot be persisted", async () => {
  const h = await fixture();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("storage full");
  });
  await expect(
    h.enrollment.remove(agent, h.client, h.signal, () => true),
  ).rejects.toThrow("storage full");
  expect(h.events).toEqual([]);
  expect(h.client.delete).not.toHaveBeenCalled();
});

it("does not save deletion intent when the selected relay cannot publish kind 5", async () => {
  const h = await fixture([30177]);
  h.enrollment.remember(h.enrollment.capture(), agent);
  await expect(
    h.enrollment.remove(agent, h.client, h.signal, () => true),
  ).rejects.toThrow("Connect");
  expect(h.enrollment.deleting(agent)).toBe(false);
  expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
  expect(h.events).toEqual([]);
  expect(h.client.delete).not.toHaveBeenCalled();
});
