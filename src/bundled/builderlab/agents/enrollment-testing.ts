import { vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { keypair, signed } from "../../../features/relay/testing";
import type { RelayEvent, ReadFilter } from "../../../features/relay/events";
import { matchesEvent } from "../../../features/relay/projection";
import { createRelaySession } from "../../../features/relay/session";
import { relayPartition } from "../../../features/relay/partition";
import type { RelaySnapshot } from "../../../features/relay/service";
import type { ClientSnapshot } from "../../../features/communities/service";
import type { OutgoingEvent } from "../../../features/relay/outbox";
import type { OAuthSession } from "../oauth/session";
import { createEnrollment } from "./enrollment";
import { deferred } from "../test-helpers";

/** Real session/outbox/inventory; only the relay wire and device storage are controlled. */
export function enrollmentFixture(
  login: OAuthSession,
  selected: string | null = "https://community.example",
  kinds: readonly number[] = [30177, 5],
) {
  const identity = keypair();
  const viewer = identity.pubkey;
  const events: RelayEvent[] = [];
  let saved: readonly OutgoingEvent[] = [];
  let closed = deferred<void>();
  const save = vi.fn(async (next: readonly OutgoingEvent[]) => {
    saved = structuredClone(next);
  });
  const storage = {
    load: () => structuredClone(saved),
    save,
    close: () => closed.resolve(),
  };
  const sign = vi.fn(async (event: EventTemplate) => signed(identity, event));
  const publish = vi.fn(async (event: RelayEvent) => {
    events.push(event);
  });
  const query = vi.fn(async (filters: readonly ReadFilter[]) =>
    events.filter(
      (event) =>
        filters.some((filter) => matchesEvent(event, filter)) &&
        !events.some(
          (deletion) =>
            deletion.kind === 5 &&
            deletion.pubkey === event.pubkey &&
            deletion.created_at >= event.created_at &&
            deletion.tags.some(
              ([key, value]) =>
                key === "a" &&
                value ===
                  `${event.kind}:${event.pubkey}:${event.tags.find(([name]) => name === "d")?.[1]}`,
            ),
        ),
    ),
  );
  const start = () =>
    createRelaySession(
      {
        viewer,
        relayAuthor: "cd".repeat(32),
        scope: "https://community.example",
        query,
        media: () => undefined,
        writer: { kinds, sign, publish },
      },
      { outboxStorage: storage },
    );
  let owner = start();
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    scope: relayPartition("https://community.example", viewer),
    session: owner.session,
  };
  let community: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer,
    selected,
    memberships: [],
    profile: { name: "", picture: "", about: "" },
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const reader = { snapshot: () => community, subscribe: relay.subscribe };
  const enrollment = createEnrollment(relay, reader, login);
  return {
    relay,
    reader,
    enrollment,
    events,
    sign,
    publish,
    query,
    viewer,
    saved: () => saved,
    save,
    setCommunity(selected: string | null) {
      community = { ...community, selected };
      for (const listener of listeners) listener();
    },
    async restart() {
      await owner.session.outbox?.ready();
      owner.dispose();
      await closed.promise;
      closed = deferred<void>();
      owner = start();
      snapshot = {
        ...snapshot,
        session: owner.session,
        generation: snapshot.generation + 1,
      };
      for (const listener of listeners) listener();
      await owner.session.outbox?.ready();
    },
    async dispose() {
      owner.dispose();
      await closed.promise;
      listeners.clear();
    },
  };
}
