import { Popover } from "@base-ui/react/popover";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAgentChoices } from "../agents/use-choices";
import type { RelaySession } from "../relay/session";
import { matchFolded } from "../search/match";
import { MatchedLabel } from "../search/MatchedLabel";
import { pickerText, readSearchUsage, recordChoice } from "../search/usage";
import { useSearchHighlight } from "../search/use-search-highlight";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { XIcon } from "../../shared/design-system/icons/index";
import { usePeople, type Recipient } from "./usePeople";
import { useChipRemoval } from "./useChipRemoval";
import styles from "./NewMessage.module.css";

const personKey = (pubkey: string) => `person:${pubkey}`;

export function RecipientPicker({
  session,
  scope,
  selected,
  disabled,
  onChange,
}: {
  session: RelaySession;
  /** View-state partition whose DM visits and earlier choices rank people. */
  scope: string;
  selected: Recipient[];
  disabled: boolean;
  onChange(people: Recipient[]): void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLFieldSetElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const selection = useRef(selected);
  selection.current = selected;
  const id = useId();
  const directory = usePeople(session, query);
  const agents = useAgentChoices(session, false);
  const controlled = new Set(
    agents.identities
      .filter((agent) => agent.managed)
      .map((agent) => agent.pubkey),
  );
  const removal = useChipRemoval();
  const atLimit = selected.length >= 8;
  const existing = new Set<string>();
  const dms = new Map<string, string>();
  const interacted = new Set<string>();
  const shared = new Set<string>();
  for (const channel of session.channels.list().channels) {
    for (const pubkey of channel.members ?? []) shared.add(pubkey);
    if (channel.channelType !== "dm") continue;
    for (const pubkey of channel.participants ?? []) interacted.add(pubkey);
    if (channel.participants?.length === 1) {
      const pubkey = channel.participants[0];
      if (pubkey) {
        existing.add(pubkey);
        dms.set(pubkey, channel.id);
      }
    }
  }
  const relationshipRank = (person: Recipient) =>
    existing.has(person.pubkey)
      ? 0
      : interacted.has(person.pubkey)
        ? 1
        : controlled.has(person.pubkey)
          ? 2
          : shared.has(person.pubkey)
            ? 3
            : 4;
  const needle = query.trim().toLowerCase();
  const typed = pickerText("dm", needle);
  // The directory matches name prefixes on the relay, so fuzzy matches would
  // depend on which people happen to be loaded. Underline only real substrings.
  // Match without accents, as the directory does: "jose" is José exactly.
  const matchOf = (person: Recipient) => {
    const match = needle ? matchFolded(person.name, needle) : undefined;
    return match && match.rank <= 3 ? match : undefined;
  };
  // Read again when the selection changes, so a person chosen earlier in this
  // message counts. Rows already showing keep their order either way.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a choice or removal makes the stored usage newer.
  const usage = useMemo(() => readSearchUsage(scope), [scope, selected.length]);
  const eligible = directory.people.filter(
    (person) =>
      person.pubkey !== session.viewer &&
      (!person.isAgent || controlled.has(person.pubkey)) &&
      !selected.some((item) => item.pubkey === person.pubkey),
  );
  const picked = usage.pick(
    typed,
    new Set(eligible.map((person) => personKey(person.pubkey))),
  );
  // Typed text puts an exact name first, then the person chosen before for
  // this text, then relationship, then match quality lifted by how often you
  // choose this person or visit your DM with them. The directory's own order
  // breaks ties. Match ranks are whole numbers from 1 to 3 and the boost is
  // below 2, so each relationship keeps its own band of ten.
  const order = (person: Recipient) => {
    if (!needle) return 0;
    const rank = matchOf(person)?.rank ?? 3;
    if (rank === 0) return -2;
    if (personKey(person.pubkey) === picked) return -1;
    const dm = dms.get(person.pubkey);
    return (
      relationshipRank(person) * 10 +
      rank -
      usage.boost(personKey(person.pubkey), ...(dm ? [`channel:${dm}`] : []))
    );
  };
  const ordered = useRef<{ query: string; pubkeys: string[] }>({
    query,
    pubkeys: [],
  });
  if (ordered.current.query !== query) ordered.current = { query, pubkeys: [] };
  const knownOrder = new Set(ordered.current.pubkeys);
  ordered.current.pubkeys.push(
    ...eligible
      .filter((person) => !knownOrder.has(person.pubkey))
      .sort((left, right) => order(left) - order(right))
      .map((person) => person.pubkey),
  );
  const byPubkey = new Map(eligible.map((person) => [person.pubkey, person]));
  const candidates = ordered.current.pubkeys.flatMap((pubkey) => {
    const person = byPubkey.get(pubkey);
    return person ? [person] : [];
  });
  // Remember eligible namesakes while search text and selection change.
  const known = useRef(new Map<string, Recipient>());
  for (const person of [...candidates, ...selected])
    known.current.set(person.pubkey, person);
  const groups = new Map<string, string[]>();
  for (const person of known.current.values()) {
    const keys = groups.get(person.name) ?? [];
    keys.push(person.pubkey);
    groups.set(person.name, keys);
  }
  const identities = new Map<string, string>();
  for (const keys of groups.values()) {
    if (keys.length > 1)
      for (const [key, value] of publicKeyLabels(keys))
        identities.set(key, value);
  }
  const discriminator = (person: Recipient) => identities.get(person.pubkey);
  const label = (person: Recipient) =>
    [person.name, discriminator(person)].filter(Boolean).join(" ");
  const listed = open && !disabled && !atLimit;
  const highlight = useSearchHighlight({
    query,
    keys: candidates.map((person) => person.pubkey),
    onChoose: (pubkey) => {
      const person = byPubkey.get(pubkey);
      if (person) choose(person);
    },
    open: listed,
    onOpen: () => setOpen(true),
  });
  const loadingRows = useRef(10);
  useEffect(() => {
    if (!directory.loading && !directory.error)
      loadingRows.current = Math.max(1, Math.min(10, candidates.length));
  }, [directory.loading, directory.error, candidates.length]);
  const initiallyFocused = useRef(false);
  useEffect(() => {
    if (!disabled && !initiallyFocused.current) {
      initiallyFocused.current = true;
      input.current?.focus();
    }
  }, [disabled]);
  function focus() {
    if (!disabled) {
      input.current?.focus();
      setOpen(true);
    }
  }
  function choose(person: Recipient) {
    if (
      disabled ||
      selection.current.length >= 8 ||
      person.pubkey === session.viewer ||
      (person.isAgent && !controlled.has(person.pubkey)) ||
      selection.current.some((item) => item.pubkey === person.pubkey)
    )
      return;
    recordChoice(scope, typed, personKey(person.pubkey));
    selection.current = [...selection.current, person];
    onChange(selection.current);
    setQuery("");
    focus();
  }
  function remove(pubkey: string, point?: { x: number; y: number }) {
    if (
      disabled ||
      !selection.current.some((person) => person.pubkey === pubkey)
    )
      return;
    const control = controls.current.get(pubkey);
    if (control) removal.play(control, point);
    selection.current = selection.current.filter(
      (person) => person.pubkey !== pubkey,
    );
    onChange(selection.current);
    focus();
  }
  const avatar = (person: Recipient, small = false) => (
    <Avatar
      alt=""
      fallback={person.name}
      src={session.media(person.picture ?? "", "small")}
      size={small ? "small" : "default"}
      shape={person.isAgent ? "squircle" : "circle"}
    />
  );
  return (
    <Popover.Root
      modal={false}
      open={open && !disabled}
      onOpenChange={(next, details) => {
        // The editable To field is the anchor, rather than a toggle button.
        const target =
          details.reason === "focus-out"
            ? (details.event as FocusEvent).relatedTarget
            : details.event.target;
        if (
          !next &&
          target instanceof Node &&
          field.current?.contains(target)
        ) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <fieldset
        aria-label="Recipients"
        className={styles.recipientHeader}
        ref={field}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget) &&
            !popup.current?.contains(event.relatedTarget)
          )
            setOpen(false);
        }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the composite field delegates clicks to its labelled input. */}
        <div
          ref={anchor}
          className={styles.toField}
          onClick={focus}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <label htmlFor={id}>To:</label>
          {selected.map((person) => (
            <span className={styles.chip} key={person.pubkey}>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${label(person)}`}
                disabled={disabled}
                ref={(element) => {
                  if (element) controls.current.set(person.pubkey, element);
                  else controls.current.delete(person.pubkey);
                }}
                onPointerDown={(event) => {
                  if (event.button === 0) event.preventDefault();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  remove(
                    person.pubkey,
                    event.detail > 0
                      ? { x: event.clientX, y: event.clientY }
                      : undefined,
                  );
                }}
              >
                {avatar(person, true)}
                <span className={styles.removeIcon}>
                  <XIcon size={12} aria-hidden="true" />
                </span>
              </button>
              <span className={styles.chipName}>{person.name}</span>
              {discriminator(person) && (
                <span className={styles.agent}>{discriminator(person)}</span>
              )}
              {person.isAgent && <span className={styles.agent}>Agent</span>}
            </span>
          ))}
          <input
            id={id}
            ref={input}
            className={styles.toInput}
            aria-label="Message recipients"
            role="combobox"
            aria-expanded={open && !disabled}
            aria-controls={listed ? highlight.listId : undefined}
            aria-autocomplete="list"
            {...highlight.fieldProps}
            placeholder={
              selected.length
                ? atLimit
                  ? "8 people selected"
                  : "Add another person…"
                : "Find a person…"
            }
            value={query}
            disabled={disabled}
            readOnly={atLimit}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={100}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              // The picker's own keys, Backspace and Escape, skip these too.
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
              )
                return;
              if (event.key === "Backspace" && !query && selected.length) {
                event.preventDefault();
                const last = selected.at(-1);
                if (last) remove(last.pubkey);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              } else if (atLimit) {
                if (event.key === "Enter" && open) event.preventDefault();
              } else if (
                !highlight.keyDown(event) &&
                open &&
                event.key === "Enter"
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        <Popover.Portal>
          <Popover.Positioner
            anchor={anchor}
            side="bottom"
            align="start"
            sideOffset={12}
            collisionPadding={12}
            className={styles.pickerPositioner}
          >
            <Popover.Popup
              ref={popup}
              role="presentation"
              initialFocus={false}
              finalFocus={false}
              className={styles.picker}
            >
              {atLimit ? (
                <p role="status">You can message up to 8 people at once.</p>
              ) : (
                <div
                  className={styles.people}
                  id={highlight.listId}
                  role="listbox"
                  aria-label="People"
                  {...highlight.listProps}
                  onScroll={(event) => {
                    const list = event.currentTarget;
                    if (
                      list.scrollHeight - list.scrollTop - list.clientHeight <
                        80 &&
                      !directory.loading &&
                      !directory.error
                    )
                      directory.loadMore();
                  }}
                >
                  {candidates.map((person) => (
                    <NavigationItem
                      key={person.pubkey}
                      {...highlight.rowProps(person.pubkey)}
                      role="option"
                      aria-label={`${label(person)}${person.isAgent ? ", Agent" : ""}`}
                      tabIndex={-1}
                      selected={person.pubkey === highlight.active}
                      aria-selected={person.pubkey === highlight.active}
                      aria-current={false}
                      icon={avatar(person)}
                      label={
                        <MatchedLabel
                          label={person.name}
                          positions={matchOf(person)?.positions}
                        />
                      }
                      trailing={
                        discriminator(person) || person.isAgent ? (
                          <span className={styles.agent}>
                            {[
                              discriminator(person),
                              person.isAgent ? "Agent" : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        ) : undefined
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(person)}
                    />
                  ))}
                  {!directory.loading &&
                    !directory.error &&
                    !candidates.length && <p>No matching people.</p>}
                  {directory.loading &&
                    (!query.trim() || !candidates.length) && (
                      <div role="status" aria-label="Loading people">
                        <div aria-hidden="true">
                          {Array.from(
                            {
                              length: candidates.length
                                ? 2
                                : loadingRows.current,
                            },
                            (_, row) => row,
                          ).map((row) => (
                            <div className={styles.loadingRow} key={row}>
                              <span className={styles.loadingAvatar} />
                              <span className={styles.loadingName} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  {directory.error && (
                    <p role="alert">Could not load people.</p>
                  )}
                  {!directory.loading && directory.hasMore && (
                    <Button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={directory.loadMore}
                    >
                      {directory.error
                        ? "Retry loading people"
                        : "Load more people"}
                    </Button>
                  )}
                </div>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </fieldset>
      {removal.layer}
    </Popover.Root>
  );
}
