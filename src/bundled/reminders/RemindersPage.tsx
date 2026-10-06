import { useState, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import type { Reminder, Reminders } from "../../features/relay/reminders";
import type { Navigation } from "../../features/navigation/controller";
import { AlarmIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import {
  TIME_PRESETS,
  endOfToday,
  formatDue,
  groupReminders,
  navigableTarget,
} from "./model";
import { scopeOf, useReminders } from "./react";
import styles from "./Reminders.module.css";

type Clock = { subscribe(listener: () => void): () => void; read(): number };

export function RemindersPage({
  relay,
  navigator,
  clock,
}: {
  relay: RelayData;
  navigator: Navigation;
  clock: Clock;
}) {
  const { connection, reminders, state } = useReminders(relay);
  const now = useSyncExternalStore(clock.subscribe, clock.read, clock.read);
  const [error, setError] = useState<string>();
  const scope = scopeOf(connection);
  const groups = groupReminders(state.reminders, now, endOfToday());
  const run = (action: Promise<unknown>) => {
    setError(undefined);
    action.catch(() =>
      setError("The reminder could not be updated. Try again."),
    );
  };
  const open = (reminder: Reminder) => {
    const target = navigableTarget(reminder);
    if (!target || !scope) return;
    void navigator
      .open({
        version: 1,
        kind: "conversation",
        scope,
        channelId: target.channelId,
        messageId: target.eventId,
      })
      .then((result) => {
        if (result.status === "failed")
          setError("This message could not be opened.");
      });
  };
  const status = !reminders
    ? connection.status === "error"
      ? (connection.error ?? "Could not connect.")
      : "Connect to a community to see your reminders."
    : state.status === "loading"
      ? "Loading reminders…"
      : undefined;
  // Live arrivals can fill the list after a failed read; history stays
  // incomplete, and due notifications held, until a read succeeds.
  const incomplete = reminders && !state.hydrated && state.status !== "loading";
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Reminders">
        <div data-buzz-ui="" className={styles.page}>
          <PanelHeader
            title={
              <PanelHeaderLabel
                title="Reminders"
                icon={<AlarmIcon size="1rem" />}
              />
            }
          />
          {error && (
            <p role="alert" className={styles.notice}>
              {error}
            </p>
          )}
          {incomplete && (
            <div role="alert" className={styles.notice}>
              <p>Some reminders could not be loaded.</p>
              <Button onClick={() => void reminders.refresh()}>
                Retry reminders
              </Button>
            </div>
          )}
          {status || !reminders ? (
            <p role="status" className={styles.notice}>
              {status}
            </p>
          ) : incomplete && !state.reminders.length ? null : !groups.length ? (
            <EmptyState
              icon={<AlarmIcon size="1.5rem" aria-hidden="true" />}
              title="No reminders"
              description="Use Remind me in a message's menu to get reminded later."
            />
          ) : (
            groups.map((group) => (
              <section
                key={group.label}
                aria-label={group.label}
                className={styles.group}
              >
                <h2 className="text-label text-subtle">{group.label}</h2>
                <ul className={styles.list}>
                  {group.reminders.map((reminder) => (
                    <ReminderRow
                      key={reminder.id}
                      reminder={reminder}
                      reminders={reminders}
                      open={
                        navigableTarget(reminder) && scope
                          ? () => open(reminder)
                          : undefined
                      }
                      run={run}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </FullPageSurface>
    </div>
  );
}

function ReminderRow({
  reminder,
  reminders,
  open,
  run,
}: {
  reminder: Reminder;
  reminders: Reminders;
  open: (() => void) | undefined;
  run(action: Promise<unknown>): void;
}) {
  return (
    <li className={styles.row}>
      <div className={styles.text}>
        <p className="text-body">{reminder.target?.preview || reminder.note}</p>
        {reminder.target && reminder.note && (
          <p className="text-body text-subtle">{reminder.note}</p>
        )}
        {reminder.notBefore !== undefined && (
          <p className="text-label text-subtle">
            {formatDue(reminder.notBefore)}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {open && <Button onClick={open}>Open</Button>}
        {reminder.status === "pending" && (
          <>
            <MenuRoot>
              <MenuTrigger render={<Button>Snooze</Button>} />
              <MenuPopup>
                {TIME_PRESETS.map((preset) => (
                  <MenuItem
                    key={preset.label}
                    onClick={() =>
                      run(reminders.snooze(reminder.id, preset.at()))
                    }
                  >
                    {preset.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </MenuRoot>
            <Button onClick={() => run(reminders.complete(reminder.id))}>
              Done
            </Button>
            <Button
              variant="ghost"
              onClick={() => run(reminders.cancel(reminder.id))}
            >
              Cancel
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
