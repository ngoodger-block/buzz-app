import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import type { Reminders } from "../../features/relay/reminders";
import type { OpenTarget } from "../../features/navigation/targets";
import { AlarmIcon } from "../../shared/design-system/icons/index";
import {
  countDue,
  dueSince,
  hasPendingReminder,
  navigableTarget,
  nextDelay,
  nowSeconds,
} from "./model";
import { RemindDialog } from "./RemindDialog";
import { RemindersPage } from "./RemindersPage";
import styles from "./Reminders.module.css";
import { noState, noSubscribe, scopeOf, useReminders } from "./react";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "conversation",
  "notifications",
];

export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  // The one due-time timer also advances `now` for the badge and page.
  let now = nowSeconds();
  const clock = new Set<() => void>();
  const subscribeClock = (listener: () => void) => {
    clock.add(listener);
    return () => void clock.delete(listener);
  };
  const readClock = () => now;
  const notify = ctx.notifications.register({
    id: "reminders",
    label: "Reminders",
  });
  const page = { pluginId: "buzz.reminders", pageId: "reminders" };

  ctx.effect(() => {
    // Per community: reminders already due when it is first bound stay on the
    // page; only later arrivals notify.
    const watermarks = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let bound: Reminders | undefined;
    let boundScope = "";
    let unbind: (() => void) | undefined;
    const check = () => {
      clearTimeout(timer);
      now = nowSeconds();
      for (const listener of clock) listener();
      const connection = relay.snapshot();
      // Only the session this window was bound for may advance it.
      if (
        !bound ||
        connection.status !== "ready" ||
        connection.session.reminders !== bound
      )
        return;
      const { status, reminders } = bound.snapshot();
      // Hold the window open until the first read lands, so history that
      // arrives after a live update still notifies.
      if (status !== "ready") return;
      const scope = scopeOf(connection);
      const watermark = watermarks.get(boundScope) ?? now;
      for (const reminder of dueSince(reminders, watermark, now)) {
        const message = navigableTarget(reminder);
        const target: OpenTarget =
          message && scope
            ? {
                version: 1,
                kind: "conversation",
                scope,
                channelId: message.channelId,
                messageId: message.eventId,
              }
            : { version: 1, kind: "page", ...page };
        void notify
          .submit({ sourceKey: `${reminder.id}:${reminder.notBefore}`, target })
          .catch(() => {});
      }
      watermarks.set(boundScope, now);
      // After sleep the timer fires late; the watermark still covers the gap.
      const delay = nextDelay(reminders, now);
      if (delay !== undefined) timer = setTimeout(check, delay);
    };
    const bind = () => {
      const connection = relay.snapshot();
      const next =
        connection.status === "ready"
          ? connection.session.reminders
          : undefined;
      if (next !== bound) {
        unbind?.();
        bound = next;
        boundScope = connection.scope ?? "";
        if (next && !watermarks.has(boundScope))
          watermarks.set(boundScope, nowSeconds());
        unbind = next?.subscribe(check);
        void next?.refresh();
      }
      check();
    };
    const stop = relay.subscribe(bind);
    bind();
    return () => {
      stop();
      unbind?.();
      clearTimeout(timer);
    };
  });

  function Badge() {
    const { state } = useReminders(relay);
    const at = useSyncExternalStore(subscribeClock, readClock, readClock);
    const due = countDue(state.reminders, at);
    return due ? (
      <span className={styles.badge} role="img" aria-label={`${due} due`}>
        {due}
      </span>
    ) : null;
  }

  ctx.pages.register({
    id: "reminders",
    title: "Reminders",
    layout: "workspace",
    primary: true,
    badge: Badge,
    component: () => (
      <RemindersPage
        relay={relay}
        navigator={ctx.navigation}
        clock={{ subscribe: subscribeClock, read: readClock }}
      />
    ),
  });

  function Marker({
    message,
    session,
  }: {
    message: { id: string };
    session: RelaySession;
  }) {
    const reminders = session.reminders;
    const state = useSyncExternalStore(
      reminders?.subscribe ?? noSubscribe,
      reminders?.snapshot ?? noState,
      reminders?.snapshot ?? noState,
    );
    return hasPendingReminder(state.reminders, message.id) ? (
      <span
        className={styles.marker}
        role="img"
        title="Reminder set"
        aria-label="Reminder set"
      >
        <AlarmIcon size={14} aria-hidden="true" />
      </span>
    ) : null;
  }

  ctx.conversation.registerMessageAction({
    id: "remind-me",
    title: "Remind me",
    icon: () => <AlarmIcon size={16} aria-hidden="true" />,
    matches: (_message, session) => !!session.reminders,
    component: RemindDialog,
    marker: Marker,
  });
};
