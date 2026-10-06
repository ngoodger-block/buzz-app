import { useIdentityNames } from "../../features/identity-names/react";
import { npubEncode } from "nostr-tools/nip19";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChannelSummary, Profile } from "../../features/relay/contracts";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useMentionArchives } from "../../features/messages/use-mention-archives";
import { archivedMention } from "../../features/messages/mention-candidates";
import { foldProfiles } from "../../features/relay/profiles";
import {
  CalendarIcon,
  ChatCircleIcon,
} from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import type { SearchDestination, SearchInputProps } from "./SearchChoices";
import { matchName, matchRank, SearchChoices } from "./SearchChoices";
import { noSearchUsage, readSearchUsage, recordChoice } from "./search-usage";
import { usePublicChannelSearch } from "./usePublicChannelSearch";
import { useSearchMessages } from "./useSearchMessages";
import {
  isChannelUuid,
  isHexPubkey,
  normalizeInChannel,
  parseSearchOperators,
} from "./parseSearchOperators";

function conversationName(
  channel: ChannelSummary,
  profiles: ReadonlyMap<string, Profile>,
  resolveName: ReturnType<typeof useIdentityNames>,
) {
  if (channel.channelType !== "dm" || !channel.participants)
    return channel.name;
  return (
    channel.participants
      .map((id) =>
        resolveName(
          id,
          profiles.get(id)?.name ?? id.slice(0, 10),
          channel.participants,
        ),
      )
      .join(", ") || "Notes to self"
  );
}

export function SearchResults({
  session,
  query,
  onQueryChange,
  input,
  pages,
  scopedChannelId,
  currentChannelId,
  onScopeChange,
  openConversation,
  usageScope,
}: {
  session: RelaySession;
  pages: readonly SearchDestination[];
  scopedChannelId?: string | undefined;
  currentChannelId?: string | undefined;
  onScopeChange?: ((channelId?: string) => void) | undefined;
  openConversation: (channelId: string, messageId?: string) => void;
  /** View-state partition whose visits and search choices rank results. */
  usageScope?: string | undefined;
} & SearchInputProps) {
  const resolveName = useIdentityNames(session.names);
  const list = useChannelList(session.channels);
  const parsed = useMemo(() => parseSearchOperators(query.trim()), [query]);
  const authorPrompt = /(?:^|\s)from:(@?)([^\s]*)$/i.exec(query);
  const pickerPrompt = !!authorPrompt && !isHexPubkey(authorPrompt[2] ?? "");
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const channels = useMemo(
    () =>
      list.channels.filter(
        (channel) =>
          (!channel.archived ||
            (!channel.readOnly &&
              (channel.channelType === "stream" ||
                channel.channelType === "forum"))) &&
          (!channel.hidden || channel.channelType === "dm") &&
          (!scopedChannelId || channel.id === scopedChannelId),
      ),
    [list.channels, scopedChannelId],
  );
  const [selectedAuthor, setSelectedAuthor] = useState<{
    query: string;
    pubkey: string;
    name: string;
    index: number;
  }>();
  const authorOperand = selectedAuthor ? `from:${selectedAuthor.pubkey}` : "";
  const selectedIndex = selectedAuthor?.index ?? -1;
  const showAuthorChip =
    !!selectedAuthor &&
    query === selectedAuthor.query &&
    query.slice(selectedIndex, selectedIndex + authorOperand.length) ===
      authorOperand;
  const displayQuery = showAuthorChip
    ? `${query.slice(0, selectedIndex)}${query.slice(selectedIndex + authorOperand.length).replace(/^\s/, "")}`
    : undefined;
  const updateDisplayQuery = (value: string) => {
    const nextQuery = showAuthorChip
      ? `from:${selectedAuthor?.pubkey} ${value.trimStart()}`
      : value;
    setSelectedAuthor(
      showAuthorChip && selectedAuthor
        ? { ...selectedAuthor, query: nextQuery, index: 0 }
        : undefined,
    );
    onQueryChange(nextQuery);
  };
  const removeSelectedAuthor = () => {
    if (!selectedAuthor || !showAuthorChip) return;
    onQueryChange(displayQuery ?? "");
    setSelectedAuthor(undefined);
    input.current?.focus();
  };
  const updateDateQuery = (nextQuery: string) => {
    if (showAuthorChip && selectedAuthor) {
      const index = nextQuery.indexOf(authorOperand);
      setSelectedAuthor(
        index < 0 ? undefined : { ...selectedAuthor, query: nextQuery, index },
      );
    }
    onQueryChange(nextQuery);
  };
  const [authorSuggestions, setAuthorSuggestions] = useState<{
    query: string;
    lookupFailed?: boolean;
    remote: readonly EventData[];
  }>();
  // Completing either from:name or from:@name selects an exact signed key.
  const datePrompt = /(?:^|\s)(after|before):([^\s]*)$/i.exec(query);
  const showDateChoices =
    !!datePrompt && !/^\d{4}-\d{2}-\d{2}$/.test(datePrompt[2] ?? "");
  const datePresets = [
    ["Today", 0],
    ["Yesterday", 1],
    ["This week", 2],
    ["Last week", 3],
    ["This month", 4],
  ] as const;
  const dateChoices: SearchDestination[] =
    showDateChoices && datePrompt
      ? datePresets.map(([label, kind]) => {
          const day = new Date();
          day.setHours(0, 0, 0, 0);
          if (kind === 1) day.setDate(day.getDate() - 1);
          if (kind === 2 || kind === 3) {
            day.setDate(
              day.getDate() - ((day.getDay() + 6) % 7) - (kind === 3 ? 7 : 0),
            );
          }
          if (kind === 4) day.setDate(1);
          const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
          return {
            key: `date:${kind}`,
            label,
            detail: date,
            icon: CalendarIcon,
            run: () =>
              updateDateQuery(
                `${query.slice(0, datePrompt.index)} ${datePrompt[1]}:${date} `.trimStart(),
              ),
          };
        })
      : [];
  const names = new Map(
    channels.map((channel) => [
      channel.id,
      conversationName(channel, profiles, resolveName),
    ]),
  );
  const operatorChannel = parsed.in ? normalizeInChannel(parsed.in) : "";
  const localChannel = operatorChannel
    ? list.channels.find(
        (channel) =>
          channel.name.toLowerCase() === operatorChannel.toLowerCase() ||
          names.get(channel.id)?.toLowerCase() ===
            operatorChannel.toLowerCase(),
      )
    : undefined;
  const needsPublicLookup =
    !scopedChannelId &&
    !!operatorChannel &&
    !isChannelUuid(operatorChannel) &&
    !localChannel;
  const operatorPublicChannels = usePublicChannelSearch(
    session,
    needsPublicLookup ? operatorChannel : "",
    list.status === "ready",
    true,
  );
  const operatorChannelId = isChannelUuid(operatorChannel)
    ? operatorChannel
    : (localChannel?.id ?? operatorPublicChannels.channels[0]?.id);
  const search = useSearchMessages(
    session,
    query,
    scopedChannelId,
    operatorChannelId,
  );
  const showAmbiguousPicker = !!search.ambiguousAuthor && !pickerPrompt;
  // Ambiguity is known only after a completed token. Keep its original span so
  // choosing a key does not discard free text or other operators after it.
  const completedAuthor = showAmbiguousPicker
    ? [...query.matchAll(/(?:^|\s)from:(@?)(\S+)/gi)].at(-1)
    : undefined;
  const authorToken = authorPrompt ?? completedAuthor;
  const authorNeedle = (authorPrompt?.[2] ?? parsed.from ?? "")
    .replace(/^@/, "")
    .toLowerCase();
  const showAuthorPicker = pickerPrompt || showAmbiguousPicker;
  const agents = useAgentChoices(session, showAuthorPicker);
  useMentionArchives(session, showAuthorPicker);
  const effectiveChannelId = scopedChannelId ?? operatorChannelId;
  useEffect(() => {
    if (!showAuthorPicker) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const members = effectiveChannelId
          ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
          : [];
        if (members.length) {
          try {
            await session.profiles.ensure(members, "foreground");
          } catch (error) {
            if (controller.signal.aborted) throw error;
            // A partial directory still contains verified member profiles.
          }
        }
        let remote: readonly EventData[] = [];
        let lookupFailed = false;
        if (authorNeedle) {
          try {
            remote = await session.read(
              [
                {
                  kinds: [0],
                  search: authorNeedle,
                  search_mode: "prefix",
                  limit: 40,
                },
              ],
              {
                signal: controller.signal,
                priority: "foreground",
                fresh: true,
              },
            );
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lookupFailed = true;
          }
        }
        controller.signal.throwIfAborted();
        setAuthorSuggestions({ query, lookupFailed, remote });
      })().catch(() => {
        if (!controller.signal.aborted)
          setAuthorSuggestions({ query, remote: [], lookupFailed: true });
      });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [session, effectiveChannelId, query, authorNeedle, showAuthorPicker]);
  const members = effectiveChannelId
    ? (session.channels.get?.(effectiveChannelId)?.members ?? [])
    : [];
  const knownAgents = new Set(agents.identities.map(({ pubkey }) => pubkey));
  const selectableAgents = new Map(
    agents.selectable.map((agent) => [agent.pubkey, agent]),
  );
  const candidates = new Map([
    ...[...profiles].filter(([pubkey]) => members.includes(pubkey)),
    ...agents.selectable.map(
      (agent) =>
        [
          agent.pubkey,
          profiles.get(agent.pubkey) ?? {
            name: agent.name,
            isAgent: true as const,
            ...(agent.avatar ? { picture: agent.avatar } : {}),
          },
        ] as const,
    ),
    ...foldProfiles(
      authorSuggestions?.query === query ? authorSuggestions.remote : [],
    ),
  ]);
  const authorChoices =
    authorToken && showAuthorPicker && authorSuggestions?.query === query
      ? [...candidates]
          .filter(([, profile]) =>
            profile.name.toLowerCase().startsWith(authorNeedle),
          )
          .filter(
            ([pubkey]) =>
              !archivedMention(session, pubkey) &&
              (!knownAgents.has(pubkey) || selectableAgents.has(pubkey)),
          )
          // Exact names survive the cap when the resolver reports ambiguity.
          .sort(
            ([left, leftProfile], [right, rightProfile]) =>
              Number(rightProfile.name.trim().toLowerCase() === authorNeedle) -
                Number(
                  leftProfile.name.trim().toLowerCase() === authorNeedle,
                ) ||
              Number(!!leftProfile.isAgent || knownAgents.has(left)) -
                Number(!!rightProfile.isAgent || knownAgents.has(right)) ||
              Number(members.includes(right)) - Number(members.includes(left)),
          )
          .slice(0, 12)
          .map(([pubkey, profile]) => ({ pubkey, profile }))
          .map(({ pubkey, profile }) => {
            const agent = selectableAgents.get(pubkey);
            const isAgent = !!agent || !!profile.isAgent;
            return {
              key: `author:${pubkey}`,
              label: resolveName(
                pubkey,
                profile.name,
                effectiveChannelId
                  ? session.channels.get?.(effectiveChannelId)?.members
                  : undefined,
              ),
              detail: pubkey.slice(0, 12),
              icon: ChatCircleIcon,
              avatar: {
                src: session.media(
                  profile.picture ?? agent?.avatar ?? "",
                  "small",
                ),
                shape: isAgent ? ("squircle" as const) : ("circle" as const),
              },
              isAgent,
              run: () => {
                // The prompt's leading separator may be the one removed with
                // the old chip. Map the token itself through that removal,
                // rather than subtracting the separator from its start twice.
                const visible = displayQuery ?? query;
                const oldEnd = selectedIndex + authorOperand.length;
                const removedLength = showAuthorChip
                  ? authorOperand.length + (query[oldEnd] === " " ? 1 : 0)
                  : 0;
                const tokenStart =
                  authorToken.index +
                  (authorToken[0].match(/^\s*/)?.[0].length ?? 0);
                const promptStart =
                  showAuthorChip && selectedIndex < tokenStart
                    ? tokenStart - removedLength
                    : tokenStart;
                const promptEnd =
                  promptStart + authorToken[0].trimStart().length;
                const prefix = visible.slice(0, promptStart);
                const nextQuery = `${prefix}from:${pubkey}${visible.slice(promptEnd) || " "}`;
                setSelectedAuthor({
                  query: nextQuery,
                  pubkey,
                  name: profile.name,
                  index: prefix.length,
                });
                onQueryChange(nextQuery);
                input.current?.focus();
              },
            };
          })
      : [];
  const publicChannels = usePublicChannelSearch(
    session,
    scopedChannelId ? "" : parsed.text,
    list.status === "ready",
  );

  const profileKey = [
    ...new Set([
      ...channels.flatMap((channel) =>
        channel.channelType === "dm" ? (channel.participants ?? []) : [],
      ),
      ...search.messages.map((message) => message.authorId),
    ]),
  ]
    .sort()
    .slice(0, 1024)
    .join(":");
  useEffect(() => {
    if (profileKey)
      void session.profiles
        .ensure(profileKey.split(":"), "background")
        .catch(() => {});
  }, [session, profileKey]);
  const needle = parsed.text.toLowerCase().replace(/^#/, "");
  // Read once per opening, so usage recorded while it is open cannot reorder it.
  const usage = useMemo(
    () => (usageScope ? readSearchUsage(usageScope) : noSearchUsage),
    [usageScope],
  );
  const choose = (key: string, run: () => void) => () => {
    if (usageScope) recordChoice(usageScope, needle, key);
    run();
  };
  // What the viewer chose before for this typed text. Only candidates that
  // match count, so a stale choice cannot add a row.
  const picked = usage.pick(
    needle,
    new Set([
      ...channels
        .filter(
          ({ id }) =>
            parsed.text && matchRank(names.get(id) ?? "", needle) !== undefined,
        )
        .map(({ id }) => `channel:${id}`),
      ...publicChannels.channels.map(({ id }) => `channel:${id}`),
      ...pages.map(({ key }) => key),
    ]),
  );
  // Rank before the limit, so an exact name beyond the first eight still shows.
  // The relay matches public channels itself; keep its matches, ranked last.
  // Archived channels follow live ones of the same rank. An exact name leads,
  // then the viewer's earlier choice for this text; otherwise usage lifts a
  // match past a slightly better one, but never past a much better one.
  const rankOf = (label: string, key: string, archived?: boolean) => {
    const rank = matchRank(label, needle);
    if (rank === 0) return archived ? -1.5 : -2;
    if (key === picked) return -1;
    return (rank ?? 6) + (archived ? 0.5 : 0) - usage.boost(key);
  };
  const byMatch = <T,>(rows: readonly T[], rank: (row: T) => number) =>
    rows
      .map((row) => ({ row, rank: rank(row) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ row }) => row);
  const channelRank = (channel: ChannelSummary) =>
    rankOf(
      names.get(channel.id) ?? channel.name,
      `channel:${channel.id}`,
      channel.archived,
    );
  const matchingAll = byMatch(
    channels.filter(
      (channel) =>
        parsed.text &&
        matchRank(names.get(channel.id) ?? "", needle) !== undefined,
    ),
    channelRank,
  );
  const matchingChannels = matchingAll.slice(0, 8);
  const joinedAll = matchingAll.filter(
    (channel) => channel.channelType !== "dm",
  );
  // Joined and public channels share one ranking before the limit, so the row
  // that gives the group its best rank, such as a remembered public channel,
  // is the row shown first. Joined channels win ties.
  const channelResults = byMatch(
    [
      ...joinedAll,
      ...publicChannels.channels.filter(
        (channel) => !joinedAll.some(({ id }) => id === channel.id),
      ),
    ],
    channelRank,
  ).slice(0, 8);
  const conversationDestination = (
    channel: ChannelSummary,
  ): SearchDestination => {
    const label = names.get(channel.id) ?? channel.name;
    const matches = needle ? matchName(label, needle)?.positions : undefined;
    const key = `channel:${channel.id}`;
    return {
      key,
      label,
      ...(matches ? { matches } : {}),
      detail: channel.archived
        ? "Archived channel"
        : channel.readOnly && !channel.cached
          ? "Public channel · not joined"
          : channel.channelType === "dm"
            ? "Direct message"
            : channel.channelType === "session"
              ? "Session"
              : "Conversation",
      icon: ChatCircleIcon,
      run: choose(key, () => openConversation(channel.id)),
    };
  };
  const recent: SearchDestination[] = channels
    .filter((channel) => !channel.readOnly && !channel.archived)
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.updatedAt ?? 0) -
        (a.lastActivityAt ?? a.updatedAt ?? 0),
    )
    .slice(0, 4)
    .map((channel) => ({
      ...conversationDestination(channel),
      ...(channel.preview ? { detail: channel.preview } : {}),
    }));
  const currentChannel = currentChannelId
    ? channels.find((channel) => channel.id === currentChannelId)
    : undefined;
  const scopeAction: SearchDestination[] =
    !scopedChannelId && currentChannel && onScopeChange
      ? [
          {
            key: `scope:${currentChannel.id}`,
            label: `Search ${currentChannel.channelType === "dm" ? "conversation with" : "in"} ${names.get(currentChannel.id) ?? currentChannel.name}`,
            detail: "Search messages in this conversation",
            icon: ChatCircleIcon,
            run: () => onScopeChange(currentChannel.id),
          },
        ]
      : [];
  const messages: SearchDestination[] = search.messages.map((message) => ({
    key: message.id,
    label: message.preview,
    detail: `${names.get(message.channelId) ?? session.channels.get?.(message.channelId)?.name ?? "Conversation"} · ${resolveName(message.authorId, profiles.get(message.authorId)?.name ?? message.authorId.slice(0, 10), list.channels.find((channel) => channel.id === message.channelId)?.members ?? [])} · ${new Date(message.createdAt * 1000).toLocaleDateString()}`,
    icon: ChatCircleIcon,
    run: () => openConversation(message.channelId, message.id),
  }));
  const operatorLookupPending =
    needsPublicLookup &&
    (list.status !== "ready" || operatorPublicChannels.loading);
  const operatorLookupError = needsPublicLookup
    ? operatorPublicChannels.error
    : undefined;
  const messageEmpty =
    operatorLookupPending || search.loading
      ? "Searching messages…"
      : operatorLookupError || search.error
        ? "Message search is unavailable."
        : query.trim()
          ? "No matching messages in accessible conversations."
          : scopedChannelId
            ? "Type to search messages in this conversation."
            : "Type to search messages in this community.";
  // A retry removes its own focused button. Return focus to the combobox,
  // which owns keyboard navigation, before the retry starts.
  const retryFromInput = (retry: () => unknown) => () => {
    input.current?.focus();
    retry();
  };
  const groups =
    pickerPrompt || showAmbiguousPicker
      ? [
          {
            label: "People",
            destinations: authorChoices.filter((choice) => !choice.isAgent),
            empty: authorChoices.length
              ? undefined
              : authorSuggestions?.query !== query
                ? "Searching people…"
                : authorSuggestions.lookupFailed
                  ? "People search is unavailable. Try a longer name."
                  : authorNeedle
                    ? "No matching people. Try a different name."
                    : "Type a name to search people.",
          },
          {
            label: "Agents",
            destinations: authorChoices.filter((choice) => choice.isAgent),
          },
        ]
      : showDateChoices
        ? [{ label: "Dates", destinations: dateChoices }]
        : scopedChannelId
          ? [
              {
                label: "Most relevant",
                destinations: messages,
                empty: messageEmpty,
              },
            ]
          : !query.trim()
            ? [
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: "Recent activity",
                  destinations: recent,
                  empty:
                    list.status === "loading"
                      ? "Loading recent conversations…"
                      : "No recent activity yet.",
                },
                {
                  label: "Actions",
                  destinations: pages.map((page) => ({
                    ...page,
                    run: choose(page.key, page.run),
                  })),
                },
              ]
            : [
                // Named destinations lead, so typed text selects one first.
                // The group with the best match leads them, so Enter opens
                // the "Work" page before a channel that merely contains it.
                ...[
                  {
                    label: "Channels",
                    destinations: channelResults.map(conversationDestination),
                    best: Math.min(...channelResults.map(channelRank)),
                  },
                  {
                    label: "Direct messages",
                    destinations: matchingChannels
                      .filter((channel) => channel.channelType === "dm")
                      .map(conversationDestination),
                    best: Math.min(
                      ...matchingChannels
                        .filter((channel) => channel.channelType === "dm")
                        .map(channelRank),
                    ),
                  },
                  {
                    label: "Pages",
                    // PageSearch already ranked these by text and underlined
                    // them; here usage and earlier choices adjust the order.
                    destinations: byMatch(pages, (page) =>
                      rankOf(page.label, page.key),
                    ).map((page) => ({
                      ...page,
                      run: choose(page.key, page.run),
                    })),
                    best: Math.min(
                      ...pages.map((page) => rankOf(page.label, page.key)),
                    ),
                  },
                ]
                  .sort((a, b) => a.best - b.best)
                  .map(({ best: _, ...group }) => group),
                ...(scopeAction.length
                  ? [{ label: "This conversation", destinations: scopeAction }]
                  : []),
                {
                  label: "Most relevant",
                  destinations: messages,
                  empty:
                    matchingChannels.length ||
                    channelResults.length ||
                    pages.length
                      ? undefined
                      : messageEmpty,
                },
              ];
  return (
    <SearchChoices
      query={query}
      onQueryChange={onQueryChange}
      authorChip={
        showAuthorChip && selectedAuthor
          ? {
              label: selectedAuthor.name,
              title: npubEncode(selectedAuthor.pubkey),
              onRemove: removeSelectedAuthor,
            }
          : undefined
      }
      displayQuery={displayQuery}
      onDisplayQueryChange={updateDisplayQuery}
      input={input}
      label={scopedChannelId ? "Search this conversation" : "Search Buzz"}
      placeholder={
        scopedChannelId
          ? "Search messages…"
          : "Search pages, conversations and messages…"
      }
      scope={
        scopedChannelId && onScopeChange
          ? {
              label:
                names.get(scopedChannelId) ??
                session.channels.get?.(scopedChannelId)?.name ??
                "Conversation",
              onRemove: () => onScopeChange(),
            }
          : undefined
      }
      groups={groups}
    >
      <div
        className="space-y-2 px-3 text-body-sm text-subtle"
        aria-live="polite"
      >
        {list.status === "loading" && query.trim() && !list.channels.length && (
          <p>Loading joined conversations…</p>
        )}
        {list.status === "error" && (
          <div>
            <p>Couldn’t load all joined conversations.</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(() =>
                session.channels.refreshList
                  ? session.channels.refreshList()
                  : session.channels.ensureList(),
              )}
            >
              Retry conversations
            </Button>
          </div>
        )}
        {list.coverage === "partial" && (
          <p>Conversation names include only loaded joined conversations.</p>
        )}
        {query.trim() &&
          !scopedChannelId &&
          (publicChannels.partial || operatorPublicChannels.partial) && (
            <p>
              Public channel results include only the first page of channels.
            </p>
          )}
        {!scopedChannelId && publicChannels.error && (
          <div>
            <p>{publicChannels.error}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(publicChannels.retry)}
            >
              Retry channels
            </Button>
          </div>
        )}
        {operatorLookupError && (
          <div>
            <p>{operatorLookupError}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(operatorPublicChannels.retry)}
            >
              Retry channels
            </Button>
          </div>
        )}
        {search.error && (
          <div>
            <p>{search.error}</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={retryFromInput(search.retry)}
            >
              Retry messages
            </Button>
          </div>
        )}
      </div>
    </SearchChoices>
  );
}
