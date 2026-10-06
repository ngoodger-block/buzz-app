import { useEffect, type RefObject, type ReactNode } from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
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
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  const highlight = useSearchHighlight({
    query,
    keys: destinations.map(({ key }) => key),
    onChoose: (key) => destinations.find((row) => row.key === key)?.run(),
  });
  const selected = highlight.active;
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  return (
    <div
      className="search-palette"
      data-search-palette=""
      {...highlight.listProps}
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
        aria-controls={highlight.listId}
        aria-expanded="true"
        aria-autocomplete="list"
        {...highlight.fieldProps}
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
          highlight.keyDown(event);
        }}
      />
      <div className="search-palette-scroll">
        <div
          id={highlight.listId}
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
                        {...highlight.rowProps(key)}
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
