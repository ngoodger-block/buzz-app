import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import { PageIcon } from "./PageIcon";
import "./SearchChoices.css";

export type SearchDestination = {
  key: string;
  label: string;
  detail?: string;
  /** Code points of `label` that match the typed text. */
  matches?: readonly number[];
  icon: typeof ChatCircleIcon;
  image?: string | undefined;
  avatar?:
    | { src?: string | undefined; shape: "circle" | "squircle" }
    | undefined;
  run: () => void;
};

const isWordChar = (char: string | undefined) =>
  /[\p{L}\p{N}]/u.test(char ?? "");

/** How well a label matches typed text: exact, then prefix, then word start,
 * then any substring, then a fuzzy match whose letters each continue a run
 * that began at a word start ("bgp" in "buzz-github-prs"), then any fuzzy
 * match (the letters appear in order). Lower is better; undefined means no
 * match. Ranks are whole numbers, so callers can add fractional tie-breaks.
 * `positions` are the matched code points of the label, for underlining. */
export function matchName(
  label: string,
  needle: string,
): { rank: number; positions: number[] } | undefined {
  const text = label.toLowerCase();
  const chars = [...text];
  // Lowercasing can change a label's length (İ → i̇). Rank it, but do not
  // underline positions that would land on the wrong letters.
  const aligned = chars.length === [...label].length;
  const found = (rank: number, positions: number[]) => ({
    rank,
    positions: aligned ? positions : [],
  });
  const run = (at: number) => {
    const from = [...text.slice(0, at)].length;
    return Array.from({ length: [...needle].length }, (_, n) => from + n);
  };
  if (text === needle) return found(0, run(0));
  let substring: number | undefined;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + 1)
  ) {
    if (at === 0) return found(1, run(0));
    if (!isWordChar(text[at - 1])) return found(2, run(at));
    substring ??= at;
  }
  if (substring !== undefined) return found(3, run(substring));
  // Spaces in typed text only separate words; they need not match.
  const letters = [...needle.replace(/\s+/g, "")];
  if (!letters.length) return undefined;
  // Can letters[i..] match chars[j..] with every run starting at a word start?
  // `inRun` means the previous letter matched chars[j - 1].
  const memo = new Map<number, boolean>();
  const takes = (i: number, j: number, inRun: boolean) =>
    chars[j] === letters[i] &&
    (inRun || !isWordChar(chars[j - 1])) &&
    wordRuns(i + 1, j + 1, true);
  const wordRuns = (i: number, j: number, inRun: boolean): boolean => {
    if (i === letters.length) return true;
    if (j === chars.length) return false;
    const key = (i * (chars.length + 1) + j) * 2 + (inRun ? 1 : 0);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result = takes(i, j, inRun) || wordRuns(i, j + 1, false);
    memo.set(key, result);
    return result;
  };
  if (wordRuns(0, 0, false)) {
    // Replay the same choices the search made: take a letter when it leads
    // to a full match, otherwise skip the character.
    const positions: number[] = [];
    for (let i = 0, j = 0, inRun = false; i < letters.length; j += 1) {
      inRun = takes(i, j, inRun);
      if (inRun) {
        positions.push(j);
        i += 1;
      }
    }
    return found(4, positions);
  }
  const positions: number[] = [];
  chars.forEach((char, j) => {
    if (char === letters[positions.length]) positions.push(j);
  });
  return positions.length === letters.length ? found(5, positions) : undefined;
}

export const matchRank = (label: string, needle: string) =>
  matchName(label, needle)?.rank;

/** A label with its matched letters underlined. The text stays whole, so the
 * row's accessible name does not change. */
function MatchedLabel({
  label,
  positions,
}: {
  label: string;
  positions: readonly number[] | undefined;
}) {
  if (!positions?.length) return label;
  const marked = new Set(positions);
  const runs: { text: string; match: boolean }[] = [];
  [...label].forEach((char, index) => {
    const match = marked.has(index);
    const last = runs.at(-1);
    if (last?.match === match) last.text += char;
    else runs.push({ text: char, match });
  });
  return runs.map(({ text, match }, index) =>
    match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
      <mark key={index} className="search-palette-match">
        {text}
      </mark>
    ) : (
      text
    ),
  );
}

export type SearchInputProps = {
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  placeholder?: string | undefined;
  scope?: { label: string; onRemove: () => void } | undefined;
  authorChip?:
    | { label: string; title: string; onRemove: () => void }
    | undefined;
  displayQuery?: string | undefined;
  onDisplayQueryChange?: ((value: string) => void) | undefined;
};

export function SearchChoices({
  groups,
  query,
  onQueryChange,
  authorChip,
  displayQuery,
  onDisplayQueryChange,
  input,
  label = "Search Buzz",
  placeholder = "Search pages, conversations and messages…",
  scope,
  children,
}: SearchInputProps & {
  groups: readonly {
    label: string;
    destinations: readonly SearchDestination[];
    empty?: ReactNode;
  }[];
  children?: ReactNode;
}) {
  const id = useId();
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  // Typed text selects its first result, so Enter opens it without a pointer.
  // Follow a destination's identity, not its index, as relay results arrive:
  // a later row inserted above cannot redirect Enter. When the selected row
  // leaves, fall back to the first result rather than reviving the old one.
  const [selection, setSelection] = useState({ query, key: "" });
  const valid =
    selection.query === query &&
    destinations.some(({ key }) => key === selection.key);
  const fallback = query.trim() ? (destinations[0]?.key ?? "") : "";
  if (!valid && (selection.query !== query || selection.key !== fallback))
    setSelection({ query, key: fallback });
  const selected = valid ? selection.key : fallback;
  const optionId = (key: string) => `${id}-${key}`;
  // WebKit replays a pointer event when rows move under a resting cursor.
  // Only a real move may select a row, or new results would steal Enter.
  // Compare viewport coordinates: Linux WebKit reports screen coordinates
  // that do not change as the pointer moves.
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const pointerMoved = (event: PointerEvent) => {
    const last = pointer.current;
    pointer.current = { x: event.clientX, y: event.clientY };
    return !!last && (last.x !== event.clientX || last.y !== event.clientY);
  };
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  useEffect(() => {
    if (selected)
      document
        .getElementById(`${id}-${selected}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected, id]);
  return (
    <div
      className="search-palette"
      data-search-palette=""
      onPointerMove={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY };
      }}
    >
      {scope && (
        <button
          type="button"
          className="search-palette-scope"
          aria-label={`Remove ${scope.label} search scope`}
          onClick={scope.onRemove}
        >
          {scope.label} <span aria-hidden="true">×</span>
        </button>
      )}
      <SearchField
        prefix={
          authorChip ? (
            <span className="search-palette-author-prefix">
              <button
                type="button"
                className="search-palette-author-chip"
                aria-label={`Remove author ${authorChip.label}`}
                title={authorChip.title}
                onClick={authorChip.onRemove}
              >
                <span aria-hidden="true">×</span> from:@{authorChip.label}
              </button>
            </span>
          ) : undefined
        }
        inputRef={input}
        role="combobox"
        aria-controls={id}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-activedescendant={selected ? optionId(selected) : undefined}
        label={label}
        placeholder={placeholder}
        value={displayQuery ?? query}
        onValueChange={onDisplayQueryChange ?? onQueryChange}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        maxLength={256}
        onKeyDown={(event) => {
          const shortcutNumber = /^Digit([1-9])$/.exec(event.code)?.[1];
          if (
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !event.altKey &&
            event.shiftKey &&
            event.metaKey === apple &&
            event.ctrlKey !== apple &&
            shortcutNumber
          ) {
            const destination = destinations[Number(shortcutNumber) - 1];
            if (destination) {
              event.preventDefault();
              if (!event.repeat) destination.run();
            }
            return;
          }
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey
          )
            return;
          const index = destinations.findIndex(({ key }) => key === selected);
          if (event.key === "Enter" && index >= 0) {
            event.preventDefault();
            destinations[index]?.run();
          } else if (
            (event.key === "ArrowDown" || event.key === "ArrowUp") &&
            destinations.length
          ) {
            event.preventDefault();
            const next =
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : destinations.length - 1
                : Math.max(
                    0,
                    Math.min(
                      destinations.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
            setSelection({ query, key: destinations[next]?.key ?? "" });
          }
        }}
      />
      <div className="search-palette-scroll">
        <div
          id={id}
          role="listbox"
          aria-label="Search results"
          className="search-palette-results"
        >
          {groups
            .filter(
              ({ destinations, empty }) =>
                destinations.length || empty !== undefined,
            )
            .map(({ label, destinations, empty }) => (
              // biome-ignore lint/a11y/useSemanticElements: A listbox option group is not a form fieldset.
              <div
                key={label}
                role="group"
                aria-label={label}
                className="search-palette-group"
              >
                <NavigationSection label={label}>
                  {destinations.map(
                    ({
                      key,
                      label,
                      detail,
                      matches,
                      icon,
                      image,
                      avatar,
                      run,
                    }) => (
                      <NavigationItem
                        key={key}
                        id={optionId(key)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected === key}
                        aria-current={false}
                        selected={selected === key}
                        data-search-result=""
                        aria-keyshortcuts={
                          shortcutNumbers.has(key)
                            ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                            : undefined
                        }
                        icon={
                          <span className="grid size-6 shrink-0 place-items-center">
                            {avatar ? (
                              <Avatar
                                alt=""
                                fallback={label}
                                src={avatar.src}
                                size="small"
                                shape={avatar.shape}
                              />
                            ) : (
                              <PageIcon icon={icon} image={image} size={17} />
                            )}
                          </span>
                        }
                        label={
                          <>
                            <span className="block truncate text-body-sm">
                              <MatchedLabel label={label} positions={matches} />
                            </span>
                            {detail && (
                              <span className="block truncate text-caption text-subtle">
                                {detail}
                              </span>
                            )}
                          </>
                        }
                        onClick={run}
                        onPointerMove={(event) => {
                          if (
                            event.pointerType !== "touch" &&
                            pointerMoved(event) &&
                            selected !== key
                          )
                            setSelection({ query, key });
                        }}
                      />
                    ),
                  )}
                  {!destinations.length && (
                    <p className="search-palette-group-empty">
                      {empty ?? "No matching results."}
                    </p>
                  )}
                </NavigationSection>
              </div>
            ))}
        </div>
        {children && <div className="search-palette-status">{children}</div>}
      </div>
    </div>
  );
}
