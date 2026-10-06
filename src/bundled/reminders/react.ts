import { useSyncExternalStore } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { RemindersState } from "../../features/relay/reminders";

export const noSubscribe = () => () => {};
const idle: RemindersState = Object.freeze({
  status: "loading",
  hydrated: false,
  reminders: [],
});
export const noState = () => idle;

/** The ready session's reminder list, or an idle one while disconnected. */
export function useReminders(relay: RelayData) {
  const connection = useSyncExternalStore(
    relay.subscribe,
    relay.snapshot,
    relay.snapshot,
  );
  const reminders =
    connection.status === "ready" ? connection.session.reminders : undefined;
  const state = useSyncExternalStore(
    reminders?.subscribe ?? noSubscribe,
    reminders?.snapshot ?? noState,
    reminders?.snapshot ?? noState,
  );
  return { connection, reminders, state };
}

/** Navigation scope for a ready connection whose partition is `<origin>:<viewer>`. */
export function scopeOf(connection: RelaySnapshot) {
  const { viewer, scope } = connection;
  return viewer && scope?.endsWith(`:${viewer}`)
    ? { viewer, communityOrigin: scope.slice(0, -(viewer.length + 1)) }
    : undefined;
}
