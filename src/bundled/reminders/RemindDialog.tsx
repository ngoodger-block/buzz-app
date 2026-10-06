import { useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { messagePreview } from "../../features/notifications/content";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  TIME_PRESETS,
  formatDue,
  parseCustomDateTime,
  shiftedFrom,
  todayDateString,
} from "./model";
import styles from "./Reminders.module.css";

/** "Remind me" for one message: a preset or custom time, plus an optional note. */
export function RemindDialog({
  message,
  session,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  close(): void;
}) {
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayDateString);
  const [time, setTime] = useState("09:00");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const custom = parseCustomDateTime(date, time);
  const submit = async (notBefore: number) => {
    const reminders = session.reminders;
    if (!reminders || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await reminders.create(
        {
          eventId: message.id,
          channelId: message.channelId,
          preview: messagePreview(message.content).slice(0, 280),
          authorPubkey: message.authorId,
        },
        notBefore,
        note,
      );
      close();
    } catch {
      setError("The reminder could not be saved. Try again.");
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      title="Remind me"
      description="Choose when to be reminded about this message."
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            disabled={pending || custom === null}
            onClick={() => custom !== null && void submit(custom)}
          >
            Set reminder
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        {TIME_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            disabled={pending}
            onClick={() => void submit(preset.at())}
          >
            {preset.label}
          </Button>
        ))}
        <div className={styles.custom}>
          <Input
            aria-label="Reminder date"
            type="date"
            min={todayDateString()}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <Input
            aria-label="Reminder time"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>
        {custom !== null && shiftedFrom(time, custom) && (
          <p role="status" className="text-body text-subtle">
            That time is skipped by daylight saving. The reminder will be set
            for {formatDue(custom)}.
          </p>
        )}
        <Textarea
          aria-label="Note"
          placeholder="Add a note (optional)"
          rows={2}
          maxLength={4096}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-body text-subtle">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
