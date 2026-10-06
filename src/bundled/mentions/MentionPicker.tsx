import { TeamMentionAvatars } from "./TeamMentionAvatars";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AtIcon } from "../../shared/design-system/icons/index";
import { useEffect, useId, useRef, useState } from "react";
import { useTeamMentions } from "./use-team-mentions";
import { useMentionChoices } from "./use-mention-choices";
import type { RelaySession } from "../../features/relay/session";
import { outsideMentionDetail } from "../../features/messages/mention-candidates";
import { matchName } from "../../features/search/match";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import "../../shared/design-system/styles/scrollbars.css";
import styles from "./Mentions.module.css";

import type { ComposerToolProps } from "../../features/conversation/contracts";

/** Select identities from the shared relay roster, never from display-name matching. */
export function MentionPicker({
  session,
  channelId,
  disabled,
  inviteAgents,
  select,
  selectTeam,
}: {
  session: RelaySession;
  scope: string;
  channelId: string;
  disabled: boolean;
  inviteAgents?: boolean | undefined;
  select: ComposerToolProps["insertMention"];
  selectTeam?: ComposerToolProps["insertMentions"];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const accepted = useRef(false);
  const searchInput = useRef<HTMLElement>(null);
  // The picker stays mounted while closed; each opening is its own lifetime.
  const [opening, setOpening] = useState(0);
  const lifetime = `picker:${useId()}:${opening}`;
  const model = useMentionChoices(
    session,
    channelId,
    inviteAgents,
    search,
    lifetime,
    open && !disabled,
  );
  const {
    profiles,
    agents,
    list,
    channel,
    roster: draftRoster,
    choices: candidates,
  } = model;
  const teams = useTeamMentions(
    session,
    channelId,
    inviteAgents,
    search,
    model,
    open && !disabled && !!selectTeam,
  );
  const parentAdmission =
    !!channel &&
    (channel.channelType !== "session" || !!channel.parentChannelId);
  const members =
    draftRoster?.map((person) => person.pubkey) ?? channel?.members;
  const memberKey = members?.join(":") ?? "";
  useEffect(() => {
    if (draftRoster || !open || !memberKey) return;
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "background")
      .catch(() => {
        if (current)
          setError(
            "Names unavailable. Exact public keys still identify recipients.",
          );
      });
    return () => {
      current = false;
    };
  }, [session, open, memberKey, draftRoster]);
  const chooseRecipient = (
    recipient: (typeof candidates)[number]["recipient"],
  ) => {
    if (model.canSelect(recipient.pubkey) && select(recipient)) {
      accepted.current = true;
      setOpen(false);
    }
  };
  const chooseTeam = (team: (typeof teams.choices)[number]) => {
    if (team.canSelect() && selectTeam?.(team.recipients)) {
      accepted.current = true;
      setOpen(false);
    }
  };
  const personKey = (pubkey: string) => `person:${pubkey}`;
  const teamKey = (id: string) => `team:${id}`;
  // Order stays rankMentions', shared with inline @ completion and mobile.
  // The highlight skips rows that cannot be chosen, as the arrow keys did.
  const highlight = useSearchHighlight({
    query: search,
    keys: disabled
      ? []
      : [
          ...candidates
            .filter((choice) => !choice.disabled)
            .map((choice) => personKey(choice.recipient.pubkey)),
          ...teams.choices
            .filter((team) => !team.disabled)
            .map((team) => teamKey(team.id)),
        ],
    onChoose: (key) => {
      const person = candidates.find(
        (choice) => personKey(choice.recipient.pubkey) === key,
      );
      if (person) return chooseRecipient(person.recipient);
      const team = teams.choices.find((choice) => teamKey(choice.id) === key);
      if (team) chooseTeam(team);
    },
    open: open && !disabled,
    // Enter chose the first row before anything was typed; keep that, and
    // show which row it is.
    highlightEmpty: true,
    wrap: true,
  });
  const highlightedLabel =
    candidates.find(
      (choice) => personKey(choice.recipient.pubkey) === highlight.active,
    )?.label ??
    teams.choices.find((team) => teamKey(team.id) === highlight.active)?.name;
  // Mentions rank names by word starts, so underline only word-start
  // matches. matchName also splits words at punctuation, rankMentions only
  // at spaces; the underline can mark a little more than the rank used.
  const needle = search.trim().toLowerCase();
  const matched = (label: string) => {
    const match = needle ? matchName(label, needle) : undefined;
    return match && match.rank <= 2 ? match.positions : undefined;
  };
  return (
    <PopoverRoot
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setOpening((value) => value + 1);
          accepted.current = false;
          if (!draftRoster) session.channels.ensureList();
        }
      }}
    >
      <fieldset
        ref={controls}
        disabled={disabled}
        className={styles.pickerControls}
        aria-label="Mention controls"
      >
        <PopoverTrigger
          disabled={disabled}
          render={
            <IconButton
              disabled={disabled}
              size="toolbar"
              ref={trigger}
              type="button"
              aria-label="Mention a member"
              title="Mention a member"
              icon={<AtIcon size={20} aria-hidden="true" />}
            />
          }
        />
        <PopoverPopup
          side="top"
          sideOffset={4}
          anchor={() => controls.current?.closest("form") ?? trigger.current}
          padding="none"
          initialFocus={searchInput}
          style={{
            width: 380,
            height: "min(360px, var(--available-height))",
            overflow: "hidden",
            display: "flex",
          }}
          aria-label="Mention a member or agent"
          finalFocus={!accepted.current}
        >
          <div className={styles.mentionContent}>
            <SearchField
              variant="capsule"
              inputRef={searchInput}
              label={
                draftRoster
                  ? "Search recipients"
                  : inviteAgents
                    ? "Search members and agents"
                    : "Search community people and agents"
              }
              value={search}
              onValueChange={setSearch}
              disabled={disabled}
              aria-controls={highlight.listId}
              {...highlight.fieldProps}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
                // Shift+Enter and Shift+arrows stay text keys, as before.
                const handled = !event.shiftKey && highlight.keyDown(event);
                // Keep these keys from the composer behind the popup.
                if (handled || event.key === "Enter") event.stopPropagation();
              }}
            />
            {!draftRoster && inviteAgents && (
              <p>
                {parentAdmission
                  ? "Agents you mention join this session and its parent channel when you send, with access to their history."
                  : "Agents you mention join this session when you send, with access to its history."}
              </p>
            )}
            {model.directory.loading && (
              <p role="status">Searching community…</p>
            )}
            {model.directory.error && (
              <>
                <p role="status">{model.directory.error}</p>
                <Button type="button" onClick={model.directory.retry}>
                  Retry community search
                </Button>
              </>
            )}
            {agents.status === "loading" && !candidates.length && (
              <p role="status">Loading agents…</p>
            )}
            {(agents.status === "error" || !!agents.error) && (
              <Button
                type="button"
                onClick={() =>
                  void session.agentChoices.refresh(
                    !!inviteAgents || teams.includeLegacy,
                  )
                }
              >
                Retry agent list
              </Button>
            )}
            {model.archives.status === "error" && (
              <Button
                type="button"
                onClick={() => void session.archives?.refresh()}
              >
                Retry archive information
              </Button>
            )}
            {teams.status && (
              <p role="status">
                {teams.status}{" "}
                {teams.canRetry && (
                  <Button onClick={teams.retry}>Retry teams</Button>
                )}
              </p>
            )}
            {error && <p role="status">{error}</p>}
            {!draftRoster && list.error && (
              <>
                <p role="alert">Could not refresh channel membership.</p>
                <Button
                  disabled={disabled}
                  type="button"
                  onClick={() => session.channels.refreshList?.()}
                >
                  Retry channel membership
                </Button>
              </>
            )}
            {!draftRoster && (!inviteAgents || !!channel) && !members && (
              <p role="status">Channel membership unavailable.</p>
            )}
            <div
              className={`${styles.mentionChoices} buzz-thin-scrollbar`}
              id={highlight.listId}
              {...highlight.listProps}
            >
              {candidates.map(
                ({ recipient, label, agent, disabled: reason }) => (
                  <NavigationItem
                    variant="option"
                    data-mention-choice=""
                    type="button"
                    key={recipient.pubkey}
                    {...highlight.rowProps(personKey(recipient.pubkey))}
                    selected={highlight.active === personKey(recipient.pubkey)}
                    aria-current={false}
                    aria-label={`${label} ${recipient.pubkey}`}
                    disabled={disabled || !!reason}
                    onClick={() => chooseRecipient(recipient)}
                    label={
                      <span className="flex flex-col whitespace-normal">
                        <MatchedLabel
                          label={label}
                          positions={matched(label)}
                        />
                        {reason && <small>{reason}</small>}
                        {!members?.includes(recipient.pubkey) && (
                          <small className="text-caption text-subtle">
                            {inviteAgents
                              ? parentAdmission
                                ? "Adds to session and parent channel when you send"
                                : "Adds to session when you send"
                              : outsideMentionDetail(channel)}
                          </small>
                        )}
                      </span>
                    }
                    title={recipient.pubkey}
                    trailing={<code>{recipient.pubkey.slice(0, 12)}</code>}
                    icon={
                      <Avatar
                        alt=""
                        fallback={label}
                        src={session.media(
                          profiles.get(recipient.pubkey)?.picture ??
                            model.directory.people.find(
                              (person) => person.pubkey === recipient.pubkey,
                            )?.picture ??
                            "",
                          "small",
                        )}
                        size="large"
                        shape={
                          agent || !members?.includes(recipient.pubkey)
                            ? "squircle"
                            : "circle"
                        }
                      />
                    }
                  />
                ),
              )}
              {teams.choices.map((team) => (
                <NavigationItem
                  key={team.id}
                  variant="option"
                  data-mention-choice=""
                  type="button"
                  {...highlight.rowProps(teamKey(team.id))}
                  selected={highlight.active === teamKey(team.id)}
                  aria-current={false}
                  disabled={disabled || !!team.disabled}
                  label={
                    <MatchedLabel
                      label={team.name}
                      positions={matched(team.name)}
                    />
                  }
                  icon={
                    <TeamMentionAvatars
                      session={session}
                      recipients={team.recipients}
                    />
                  }
                  trailing={
                    <span className="text-caption text-subtle">
                      {team.detail}
                    </span>
                  }
                  aria-label={`${team.name} · ${team.detail}`}
                  onClick={() => chooseTeam(team)}
                />
              ))}
              {model.truncated && (
                <p>Narrow your search to see more members.</p>
              )}
              {members && !candidates.length && !teams.choices.length && (
                <p>No matching channel members.</p>
              )}
              <p role="status" className="sr-only">
                {highlightedLabel
                  ? `${highlightedLabel}. Press Enter to mention.`
                  : ""}
              </p>
            </div>
          </div>
        </PopoverPopup>
      </fieldset>
    </PopoverRoot>
  );
}
