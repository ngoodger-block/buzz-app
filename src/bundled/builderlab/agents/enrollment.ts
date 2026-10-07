import type { CommunityReader } from "../../../features/communities/service";
import { communityDestination } from "../../../features/communities/destination";
import type { EventData } from "../../../features/relay/events";
import type { Outbox } from "../../../features/relay/outbox";
import type { RelayData } from "../../../features/relay/service";
import { relayPartition } from "../../../features/relay/partition";
import { oauthTarget } from "../oauth/browser";
import type { OAuthSession } from "../oauth/session";
import type { AgentClient, RemoteAgent } from "./client";

const PREFIX = "buzz.builderlab.enrollment.v1:";
const DELETION_PREFIX = "buzz.builderlab.deletion.v1:";

/** Builderlab owns agent intent; the session owns signing and durable delivery. */
export function createEnrollment(
  relay: RelayData,
  community: CommunityReader,
  login: OAuthSession,
) {
  function deletionKey(pubkey: string) {
    return (
      DELETION_PREFIX +
      JSON.stringify([oauthTarget(), login.credential().account.subject]) +
      ":" +
      pubkey
    );
  }
  function deleting(agent: RemoteAgent) {
    const value = localStorage.getItem(deletionKey(agent.pubkey));
    if (value !== null && value !== "deleting")
      throw new Error("Saved agent deletion is invalid.");
    return value === "deleting";
  }
  function scope() {
    const selected = community.snapshot();
    if (!selected.selected) return;
    const url = communityDestination(selected.selected).url;
    const viewer = selected.viewer;
    if (!viewer) throw new Error("Community identity is unavailable. Retry.");
    const credential = login.credential();
    return {
      url,
      viewer,
      credential,
      key:
        PREFIX +
        JSON.stringify([
          oauthTarget(),
          credential.account.subject,
          url,
          viewer,
        ]),
    };
  }
  function capture(kind = 30177) {
    const identity = scope();
    if (!identity) return;
    const connection = relay.snapshot();
    const outbox = connection.session.outbox;
    if (
      connection.status !== "ready" ||
      connection.scope !== relayPartition(identity.url, identity.viewer) ||
      connection.viewer !== identity.viewer ||
      !outbox?.supports(kind)
    )
      throw new Error("Connect to this community before changing an agent.");
    return { ...identity, connection, outbox };
  }
  type Enrollment = ReturnType<typeof capture>;
  function current(context: Enrollment) {
    if (login.snapshot().status !== "signed-in") return false;
    const selected = scope();
    if (!context) return !selected;
    const connection = relay.snapshot();
    return (
      selected?.key === context.key &&
      selected.credential === context.credential &&
      connection.session === context.connection.session &&
      connection.generation === context.connection.generation &&
      connection.status === "ready"
    );
  }
  const storageKey = (key: string, pubkey: string) => `${key}:${pubkey}`;
  function pending(rows: readonly RemoteAgent[]) {
    const identity = scope();
    if (!identity) return [];
    return rows
      .filter((row) => {
        if (deleting(row)) return false;
        const value = localStorage.getItem(
          storageKey(identity.key, row.pubkey),
        );
        if (value !== null && value !== "pending")
          throw new Error("Saved community setup is invalid.");
        return value === "pending";
      })
      .map((row) => row.pubkey);
  }
  function remember(context: Enrollment, agent: RemoteAgent) {
    if (deleting(agent))
      throw new Error("Agent deletion is pending. Retry Delete agent.");
    if (context)
      localStorage.setItem(storageKey(context.key, agent.pubkey), "pending");
  }
  async function publish(
    context: Enrollment,
    agent: RemoteAgent,
    signal: AbortSignal,
    active: () => boolean,
  ) {
    if (!context) return;
    const allowed = () =>
      !signal.aborted && active() && current(context) && !deleting(agent);
    const check = () => {
      signal.throwIfAborted();
      if (!allowed())
        throw new DOMException("Community or account changed.", "AbortError");
    };
    check();
    if (agent.status !== "Active")
      throw new Error("Finish agent activation before community setup.");
    const { session } = context.connection;
    const { outbox } = context;
    await outbox.ready();
    check();
    const recoveryKey = `builderlab:register:${agent.pubkey}`;
    const matches = (event: EventData) => {
      const coordinates = event.tags.filter(([key]) => key === "d");
      return (
        event.kind === 30177 &&
        event.pubkey === context.viewer &&
        coordinates.length === 1 &&
        coordinates[0]?.[1] === agent.pubkey
      );
    };
    const receipt = outbox
      .snapshot()
      .find(
        (item) =>
          item.recovery?.key === recoveryKey ||
          (item.acknowledged && matches(item.event)),
      );
    let id = receipt?.event.id;
    if (receipt && !matches(receipt.event))
      throw new Error("Saved community registration is invalid.");
    // A crash after receipt acknowledgment may leave only the earlier intent.
    const existing = receipt
      ? undefined
      : (
          await session.read(
            [
              {
                kinds: [30177],
                authors: [context.viewer],
                "#d": [agent.pubkey],
                limit: 1,
                consistency: "strong",
              },
            ],
            { fresh: true, signal },
          )
        ).some(matches);
    check();
    if (!existing && !receipt?.acknowledged) {
      // TODO: Recover expired registration receipts. After 15 minutes, an event
      // absent from the relay cannot be retried; an existing event can still be
      // confirmed by readback. The absent case leaves the Active agent stuck
      // with community setup pending. Requires a wider shared-outbox fix to
      // reconcile relay evidence, safely retire expired receipts (including
      // unknown delivery), and publish a fresh registration while preserving
      // the saved enrollment intent across crashes.
      if (receipt && ["failed", "unknown"].includes(receipt.delivery))
        outbox.retry(receipt.event.id, allowed);
      id =
        receipt?.event.id ??
        outbox.send(
          {
            kind: 30177,
            tags: [["d", agent.pubkey]],
            content: JSON.stringify({
              name: agent.name,
              parallelism: 1,
              respond_to: "owner-only",
            }),
          },
          { key: recoveryKey, value: agent.pubkey },
          allowed,
        );
      await delivered(outbox, id, signal);
      check();
    }
    // Drain an inventory read started before publication, then demand fresh discovery.
    if (session.agentLibrary.snapshot().status === "loading")
      await session.agentLibrary.refresh();
    check();
    await session.agentChoices.refresh();
    check();
    if (
      !session.agentChoices
        .snapshot()
        .identities.some((row) => row.pubkey === agent.pubkey)
    )
      throw new Error(
        "Agent is Active; community discovery is pending. Retry community setup.",
      );
    if (id) {
      await outbox.acknowledge(id);
      check();
      await outbox.dismiss(id);
    }
    check();
    localStorage.removeItem(storageKey(context.key, agent.pubkey));
  }
  return {
    snapshot: relay.snapshot,
    subscribe: relay.subscribe,
    deleting,
    capture,
    current,
    pending,
    remember,
    publish,
    async remove(
      agent: RemoteAgent,
      client: Pick<AgentClient, "delete">,
      signal: AbortSignal,
      active: () => boolean,
    ) {
      const credential = login.credential();
      const context = capture(5);
      const allowed = () =>
        !signal.aborted &&
        active() &&
        login.snapshot().status === "signed-in" &&
        login.credential() === credential &&
        current(context);
      const check = () => {
        signal.throwIfAborted();
        if (!allowed())
          throw new DOMException("Community or account changed.", "AbortError");
      };
      check();
      if (context) {
        await context.outbox.ready();
        check();
      }
      // Keep this account-scoped tombstone after success too: stale enrollment
      // intent in any community/window must never re-register the deleted key.
      localStorage.setItem(deletionKey(agent.pubkey), "deleting");
      if (context) {
        const { session } = context.connection;
        const { outbox } = context;
        // Coordinate deletion is repeatable. Each manual attempt gets a fresh
        // event rather than reusing a possibly expired registration-style receipt.
        const id = outbox.send(
          {
            kind: 5,
            content: "",
            tags: [["a", `30177:${context.viewer}:${agent.pubkey}`]],
          },
          undefined,
          allowed,
        );
        try {
          await delivered(
            outbox,
            id,
            signal,
            "Record deletion is not confirmed. Retry Delete agent.",
          );
        } finally {
          if (
            outbox.snapshot().find((item) => item.event.id === id)?.delivery !==
            "sending"
          )
            await outbox.dismiss(id);
        }
        check();
        if (session.agentLibrary.snapshot().status === "loading")
          await session.agentLibrary.refresh();
        check();
        await session.agentChoices.refresh();
        check();
      }
      await client.delete(agent, signal);
      check();
      if (context)
        localStorage.removeItem(storageKey(context.key, agent.pubkey));
    },
    async recover(
      rows: readonly RemoteAgent[],
      signal: AbortSignal,
      active: () => boolean,
    ) {
      const intended = pending(rows);
      if (!intended.length || relay.snapshot().status !== "ready") return;
      const context = capture();
      for (const agent of rows) {
        if (agent.status === "Active" && intended.includes(agent.pubkey))
          await publish(context, agent, signal, active);
      }
    },
  };
}
export type AgentEnrollment = ReturnType<typeof createEnrollment>;

function delivered(
  outbox: Outbox,
  id: string,
  signal: AbortSignal,
  failure = "Community registration is not confirmed. Retry community setup.",
) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: unknown) => {
      stop();
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(signal.reason);
    const inspect = () => {
      const item = outbox.snapshot().find((item) => item.event.id === id);
      if (item?.delivery === "accepted" || item?.delivery === "seen") finish();
      else if (item?.delivery !== "sending")
        finish(new Error(item?.error ?? failure));
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else inspect();
  });
}
