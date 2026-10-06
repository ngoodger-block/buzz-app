import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RegisteredPanel } from "../../features/panels/service";
import { matchName } from "../../features/search/match";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import {
  noSearchUsage,
  pickerText,
  readSearchUsage,
  recordChoice,
} from "../../features/search/usage";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import {
  TerminalWindowIcon,
  ListChecksIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import styles from "./ChannelTabs.module.css";

// These existing channel tools accept their context from the host; arbitrary
// target-based contributions still open through their own links.
export function channelToolIcon(panel: RegisteredPanel) {
  return panel.pluginId === "buzz.terminal" ? (
    <TerminalWindowIcon size="1rem" />
  ) : (
    <ListChecksIcon size="1rem" />
  );
}
export function isChannelTabTool(panel: RegisteredPanel) {
  return (
    !!panel.channelLauncher &&
    ((panel.pluginId === "buzz.terminal" && panel.id === "terminal") ||
      (panel.pluginId === "buzz.todos" && panel.id === "todos"))
  );
}
const categories = [
  { id: "channels", label: "Channels" },
  { id: "dm", label: "DMs" },
  { id: "tools", label: "Tools" },
] as const;

type Choice = {
  key: string;
  label: string;
  icon: ReactNode;
  run(): void;
};

export function ChannelTabPicker({
  channels,
  tools,
  icon,
  choose,
  chooseTool,
  usageScope,
}: {
  channels: readonly ChannelSummary[];
  tools: readonly RegisteredPanel[];
  icon(channel: ChannelSummary): ReactNode;
  choose(channelId: string): void;
  chooseTool(panel: RegisteredPanel): void;
  /** View-state partition whose visits and earlier choices rank matches. */
  usageScope?: string | undefined;
}) {
  const panelId = useId();
  const input = useRef<HTMLElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const [category, setCategory] = useState<"channels" | "dm" | "tools">(
    "channels",
  );
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  // Read once, so a choice made here cannot reorder the list.
  const usage = useMemo(
    () => (usageScope ? readSearchUsage(usageScope) : noSearchUsage),
    [usageScope],
  );
  const typed = pickerText("tab", needle);
  const all: Choice[] =
    category === "tools"
      ? tools.map((tool) => ({
          key: `tool:${tool.key}`,
          label: tool.title,
          icon: channelToolIcon(tool),
          run: () => chooseTool(tool),
        }))
      : channels
          .filter(
            (channel) => (channel.channelType === "dm") === (category === "dm"),
          )
          .map((channel) => ({
            key: `channel:${channel.id}`,
            label: channel.name,
            icon: icon(channel),
            run: () => choose(channel.id),
          }));
  // Everything here is on this device, so fuzzy matches are stable: "bgp"
  // finds buzz-github-prs. Order as Command-K does: an exact name, then the
  // earlier choice for this text, then match quality lifted by usage.
  const matched = all.flatMap((choice) => {
    const match = needle ? matchName(choice.label, needle) : undefined;
    return !needle || match ? [{ choice, match }] : [];
  });
  const picked = usage.pick(
    typed,
    new Set(matched.map(({ choice }) => choice.key)),
  );
  const rankOf = ({ choice, match }: (typeof matched)[number]) =>
    !match
      ? 0
      : match.rank === 0
        ? -2
        : choice.key === picked
          ? -1
          : match.rank - usage.boost(choice.key);
  const results = matched
    .map((row) => ({ ...row, rank: rankOf(row) }))
    .sort((a, b) => a.rank - b.rank);
  const run = (choice: Choice) => {
    if (usageScope && typed) recordChoice(usageScope, typed, choice.key);
    choice.run();
  };
  const highlight = useSearchHighlight({
    query,
    keys: results.map(({ choice }) => choice.key),
    onChoose: (key) => {
      const row = results.find(({ choice }) => choice.key === key);
      if (row) run(row.choice);
    },
  });
  const highlighted = results.find(
    ({ choice }) => choice.key === highlight.active,
  )?.choice;
  const empty = !results.length;
  return (
    <section className={styles.picker} aria-label="Choose a tab">
      <div className={styles.pickerLayout}>
        <Tabs
          variant="panel"
          label="Tab categories"
          value={category}
          onValueChange={(value) => {
            setCategory(value);
            setQuery("");
          }}
          items={categories.map(({ id, label }) => ({
            value: id,
            label,
            panelId: `${panelId}-${id}`,
          }))}
        />
        <div
          className={styles.choices}
          role="tabpanel"
          id={`${panelId}-${category}`}
          aria-labelledby={`${panelId}-${category}-tab`}
        >
          <SearchField
            inputRef={input}
            label={
              category === "tools"
                ? "Find a channel tool"
                : "Find a channel or person"
            }
            placeholder={
              category === "tools"
                ? "Search tools…"
                : category === "dm"
                  ? "Search direct messages…"
                  : "Search channels…"
            }
            value={query}
            onValueChange={setQuery}
            onKeyDown={(event) => {
              highlight.keyDown(event);
            }}
          />
          <div className={styles.group} {...highlight.listProps}>
            {results.map(({ choice, match }) => (
              <NavigationItem
                key={choice.key}
                {...highlight.rowProps(choice.key)}
                selected={choice.key === highlight.active}
                aria-current={false}
                label={
                  <MatchedLabel
                    label={choice.label}
                    positions={match?.positions}
                  />
                }
                icon={choice.icon}
                onClick={() => run(choice)}
              />
            ))}
            {/* One status line: the empty state, or for screen readers the
                highlighted row that Enter opens. */}
            <p
              role="status"
              className={empty ? "text-body-sm text-subtle" : "sr-only"}
            >
              {!empty
                ? highlighted
                  ? `${highlighted.label}. Press Enter to open.`
                  : ""
                : query.trim()
                  ? "No matches. Try another name."
                  : category === "tools"
                    ? "No channel tools are available. Enable tools in Settings → Plugins. Terminal requires Buzz Desktop."
                    : category === "dm"
                      ? "No direct messages available yet."
                      : "No other channels available yet."}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
