import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { InboxItem } from "../../features/relay/inbox";
import { InboxDetail } from "./InboxDetail";
import { DraftsView } from "./DraftsView";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useIdentityNames } from "../../features/identity-names/react";
import { messagePreview } from "../../features/notifications/content";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { QuestionIcon, BellIcon } from "../../shared/design-system/icons";
import { Select } from "../../shared/design-system/ui/Select";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import styles from "./Inbox.module.css";
import { dmLabel } from "./dm-label";
import { subscribeView, viewRevision } from "../../shared/view-state";
import {
  archiveKey,
  archiveIndex,
  isArchived,
  readArchives,
  reopenArchives,
  updateArchive,
} from "./archive";

type ActivityFilter = "all" | "dms" | "threads" | "mentions";
type SenderFilter = "everyone" | "humans" | "agents";
const activities = [
  { value: "all", label: "All activity" },
  { value: "dms", label: "DMs" },
  { value: "threads", label: "Threads" },
  { value: "mentions", label: "Mentions" },
] as const;
const senders = [
  { value: "everyone", label: "Everyone" },
  { value: "humans", label: "Humans" },
  { value: "agents", label: "Agents" },
] as const;
const matchesActivity = (
  item: InboxItem,
  filter: ActivityFilter,
  isDm: boolean,
) => {
  switch (filter) {
    case "all":
      return true;
    case "dms":
      return isDm;
    case "mentions":
      return item.mentioned;
    case "threads":
      return item.thread;
  }
};
const hasUnread = (item: InboxItem) => item.unreadCount > 0 || item.manual;

export function InboxPage({
  relay,
  navigator,
  extensions,
}: {
  relay: RelayData;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
}) {
  const connection = useRelayConnection(relay);
  const { viewer, scope } = connection;
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Inbox">
        {connection.status === "ready" &&
        viewer &&
        scope?.endsWith(`:${viewer}`) ? (
          <InboxView
            key={`${scope}:${connection.generation}`}
            session={connection.session}
            scope={{
              viewer,
              communityOrigin: scope.slice(0, -(viewer.length + 1)),
            }}
            navigator={navigator}
            extensions={extensions}
          />
        ) : (
          <div data-buzz-ui="" className={styles.page}>
            <PanelHeader
              title={
                <PanelHeaderLabel
                  title="Inbox"
                  icon={<BellIcon size="1rem" />}
                />
              }
            />
            <div className={styles.notice} role="status">
              <p className="text-body text-subtle">
                {connection.status === "connecting"
                  ? "Connecting to your inbox…"
                  : (connection.error ??
                    "Choose a community to see your inbox.")}
              </p>
              {connection.status === "error" && (
                <Button onClick={relay.retry}>Retry connection</Button>
              )}
            </div>
          </div>
        )}
      </FullPageSurface>
    </div>
  );
}

export function InboxView({
  session,
  scope,
  navigator,
  extensions,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
}) {
  const previewId = useId();
  const list = useChannelList(session.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
    session.unread.inbox,
  );
  const feed = useSyncExternalStore(
    session.inboxFeed.subscribe,
    session.inboxFeed.snapshot,
    session.inboxFeed.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const sync = useSyncExternalStore(
    session.unread.subscribeSync,
    session.unread.sync,
    session.unread.sync,
  );
  const [activity, setActivity] = useState<ActivityFilter>("all");
  const [senderFilter, setSenderFilter] = useState<SenderFilter>("everyone");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [drafts, setDrafts] = useState(false);
  const [archivedView, setArchivedView] = useState(false);
  const archiveScope = session.scope;
  const subscribeArchives = useCallback(
    (listener: () => void) => subscribeView(archiveScope, listener),
    [archiveScope],
  );
  const archiveRevision = useSyncExternalStore(subscribeArchives, () =>
    viewRevision(archiveScope, archiveKey),
  );
  const archives = useMemo(
    () => archiveIndex(readArchives(archiveRevision)),
    [archiveRevision],
  );
  const draftsControl = useRef<HTMLButtonElement>(null);
  const [selectedTarget, setSelectedTarget] = useState<{
    channelId: string;
    messageId: string;
    rootId?: string;
  }>();
  const invokingRow = useRef<HTMLButtonElement | null>(null);
  const fallbackRow = useRef<HTMLButtonElement | null>(null);
  const fallbackControl = useRef<HTMLDivElement | null>(null);
  const workspace = useRef<HTMLDivElement | null>(null);
  const retryFocus = useRef(false);
  const retryButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    // Capture ownership before removal, not after focus has fallen to body.
    return () => {
      retryFocus.current = document.activeElement === button;
    };
  }, []);

  const [pending, setPending] = useState(false);
  const [refreshAfterRoster, setRefreshAfterRoster] = useState(false);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; anchor?: HTMLElement }>();
  const active = useRef(false);
  const busy = useRef(false);
  const failedMutation = useRef<
    { work: () => Promise<unknown>; valid: () => boolean } | undefined
  >(undefined);
  const intentRevision = useRef(0);
  function cancelRetry() {
    intentRevision.current++;
    failedMutation.current = undefined;
    setError(undefined);
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    // A completed discovery revision can retire an earlier feed attempt.
    void list.asOf;
    if (list.status !== "ready") return;
    if (refreshAfterRoster) {
      setRefreshAfterRoster(false);
      void Promise.all([session.unread.refresh(), session.inboxFeed.refresh()]);
    } else {
      void session.unread.ensure();
      void session.inboxFeed.ensure();
      session.agentChoices.ensure();
    }
  }, [session, list.status, list.asOf, refreshAfterRoster]);
  const items = inbox.items;
  const archived = (item: InboxItem) => isArchived(archives, item);
  const viewItems = items.filter((item) => archived(item) === archivedView);
  useEffect(() => {
    try {
      reopenArchives(archiveScope, inbox.items, archiveRevision);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save the reopened conversation.",
      );
    }
  }, [archiveScope, archiveRevision, inbox.items]);
  const activityItems = viewItems.filter((item) =>
    matchesActivity(
      item,
      activity,
      list.channels.some(
        (channel) =>
          channel.id === item.channelId && channel.channelType === "dm",
      ),
    ),
  );
  // A late verified root can legitimately regroup channel:reply into
  // channel:root. Keep the captured visit by exact key, never by a namesake.
  const selected = viewItems.find(
    (item) =>
      item.channelId === selectedTarget?.channelId &&
      item.messageIds.includes(selectedTarget.messageId),
  );
  const selectedId = selected?.id;
  const [restoringFocus, setRestoringFocus] = useState(false);
  useEffect(() => {
    if (selectedTarget || !restoringFocus || pending) return;
    const row = invokingRow.current?.isConnected
      ? invokingRow.current
      : fallbackRow.current?.isConnected
        ? fallbackRow.current
        : fallbackControl.current?.querySelector<HTMLElement>(
            '[role="combobox"]',
          );
    row?.focus({ preventScroll: true });
    invokingRow.current = null;
    setRestoringFocus(false);
  }, [selectedTarget, restoringFocus, pending]);
  useEffect(() => {
    if (selectedTarget && !selected && inbox.status !== "loading") {
      setRestoringFocus(true);
      setSelectedTarget(undefined);
    }
  }, [selectedTarget, selected, inbox.status]);
  useEffect(() => {
    if (menu && !items.some((item) => item.id === menu.id)) setMenu(undefined);
  }, [items, menu]);
  // Enrich bounded activity candidates before applying Sender: unknown authors
  // must be able to appear after their profiles arrive, even in an empty view.
  const [limit, setLimit] = useState(50);
  const candidateIds = activityItems
    .slice(0, limit)
    .map((item) => item.authorId);
  const matchingAuthors = [...new Set(candidateIds)].sort().join(":");
  const authorIds = useMemo(
    () => (matchingAuthors ? matchingAuthors.split(":") : []),
    [matchingAuthors],
  );
  const cachedProfiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  // Classification covers every evaluated author, independently of bounded demand.
  // Winning events can change without changing folded display values.
  useSyncExternalStore(session.profiles.subscribe, () =>
    activityItems
      .map(({ authorId }) => session.profiles.event?.(authorId)?.id ?? "")
      .join(":"),
  );
  const agentIds = new Set(choices.identities.map((agent) => agent.pubkey));
  const senderKind = (authorId: string) => {
    if (agentIds.has(authorId) || cachedProfiles.get(authorId)?.isAgent)
      return "agent";
    // foldProfiles supplies a fallback for malformed kind 0; require a valid
    // signed, parsed object before treating absent agent hints as human display evidence.
    const event = session.profiles.event?.(authorId);
    if (event) {
      try {
        const body: unknown = JSON.parse(event.content);
        if (body !== null && typeof body === "object" && !Array.isArray(body))
          return "human";
      } catch {
        /* Missing or malformed profile is unknown. */
      }
    }
    return "unknown";
  };
  const matching = activityItems.filter(
    (item) =>
      (senderFilter === "everyone" ||
        senderKind(item.authorId) ===
          (senderFilter === "agents" ? "agent" : "human")) &&
      (!unreadOnly || hasUnread(item) || item.id === selectedId),
  );
  const visible = matching.slice(0, limit);
  const profileKey = [
    ...new Set([
      ...authorIds,
      ...visible.flatMap((item) => {
        const channel = list.channels.find(
          (entry) => entry.id === item.channelId,
        );
        return channel?.channelType === "dm"
          ? (channel.participants?.slice(0, 3) ?? [])
          : [];
      }),
    ]),
  ]
    .sort()
    .join(":");
  const profileIds = useMemo(
    () => (profileKey ? profileKey.split(":") : []),
    [profileKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, profileIds),
    [session, profileIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  useEffect(() => {
    // A settled discovery revision can retire earlier optional profile reads.
    void list.asOf;
    if (profileIds.length && list.status === "ready")
      void session.profiles.ensure(profileIds, "background").catch(() => {});
  }, [session, profileIds, list.status, list.asOf]);
  async function run(work: () => Promise<unknown>, valid?: () => boolean) {
    if (!active.current || busy.current) return;
    busy.current = true;
    setPending(true);
    failedMutation.current = undefined;
    try {
      if (valid && !valid())
        throw new Error(
          "Inbox action expired. Close and reopen the conversation.",
        );
      await work();
      if (active.current) setError(undefined);
    } catch (cause) {
      if (active.current) {
        if (valid?.()) failedMutation.current = { work, valid };
        setError(
          cause instanceof Error
            ? cause.message
            : "Inbox action failed. Try again.",
        );
      }
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }
  function refresh(retrySync = false) {
    void run(async () => {
      reopenArchives(archiveScope, session.unread.inbox().items);
      if (list.status !== "ready") {
        setRefreshAfterRoster(true);
        session.channels.ensureList();
      } else {
        await Promise.all([
          session.unread.refresh(),
          session.inboxFeed.refresh(),
        ]);
      }
      if (retrySync && active.current) await session.unread.retrySync();
    });
  }
  function archive(item: InboxItem, value: boolean) {
    cancelRetry();
    const valid = () => {
      const channel = session.channels
        .list()
        .channels.find((entry) => entry.id === item.channelId);
      return (
        active.current &&
        !!channel &&
        !channel.cached &&
        !channel.archived &&
        !!channel.members?.includes(scope.viewer) &&
        session.unread.inbox().items.includes(item)
      );
    };
    void run(async () => {
      updateArchive(archiveScope, item, value);
      setMenu(undefined);
      setRestoringFocus(true);
      setSelectedTarget(undefined);
    }, valid);
  }
  function mutate(item: InboxItem, unread: boolean) {
    // An open menu is not authority: recheck the current session at action entry.
    if (
      !active.current ||
      busy.current ||
      session.unread.sync().capability !== "frontier-sync"
    )
      return;
    // Capture the admitted row and access evidence. Retry is explicit and cannot
    // reuse the intent after retargeting, access changes, or newer read/activity intent.
    const intent = ++intentRevision.current;
    const channel = session.channels
      .list()
      .channels.find((entry) => entry.id === item.channelId);
    const generation = session.unread.generation();
    const membership = channel?.members
      ? [...channel.members].sort().join(":")
      : undefined;
    let revision = session.unread.revision();
    const remaining = [...item.readThrough];
    const valid = () => {
      const current = session.channels
        .list()
        .channels.find((entry) => entry.id === item.channelId);
      return (
        active.current &&
        intentRevision.current === intent &&
        session.unread.sync().capability === "frontier-sync" &&
        !!channel &&
        !!current &&
        !current.cached &&
        !current.readOnly &&
        !current.archived &&
        current.channelType === channel.channelType &&
        !!current.members?.includes(scope.viewer) &&
        [...current.members].sort().join(":") === membership &&
        session.unread.generation() === generation &&
        session.unread
          .inbox()
          .items.some(
            (row) =>
              row.channelId === item.channelId &&
              row.messageIds.includes(item.messageId),
          ) &&
        session.unread.revision() === revision
      );
    };
    // Prepare once per click, not once per Retry: later arrivals are a new intent.
    let readChannel: (() => Promise<unknown>) | undefined;
    const work = async () => {
      if (unread) await session.unread.markUnreadLocal(item.target);
      else if (item.target.kind === "channel") {
        readChannel ??= session.unread.prepareChannelRead(item.channelId);
        await readChannel();
      } else
        while (remaining.length) {
          // Close/Escape retires undispatched steps, not the admitted save.
          // Its genuine storage/access rejection still propagates through run.
          if (intentRevision.current !== intent) return;
          if (!valid())
            throw new Error(
              "Inbox action expired. Close and reopen the conversation.",
            );
          const step = remaining[0];
          if (!step) break;
          await session.unread.markThrough(step.target, step.messageId);
          remaining.shift();
          revision = session.unread.revision();
        }
    };
    void run(work, valid);
  }
  function retry() {
    // Keep source errors mounted too while their refresh clears live evidence.
    setError(failure);
    const mutation = failedMutation.current;
    if (mutation) {
      void run(mutation.work, mutation.valid);
      return;
    }
    refresh(true);
  }
  const canRead = sync.capability === "frontier-sync";
  const loading =
    list.status === "idle" ||
    list.status === "loading" ||
    inbox.status === "loading" ||
    feed.status === "loading";
  const failure =
    error ?? list.error ?? inbox.error ?? feed.error ?? sync.error;
  useLayoutEffect(() => {
    if (!retryFocus.current) return;
    retryFocus.current = false;
    if (failure || pending || document.activeElement !== document.body) return;
    const control =
      workspace.current?.querySelector<HTMLElement>(
        '[aria-label="Inbox detail"] button[aria-label^="Close "]',
      ) ??
      fallbackControl.current?.querySelector<HTMLElement>('[role="combobox"]');
    control?.focus({ preventScroll: true });
  }, [failure, pending]);
  return (
    <div data-buzz-ui="" className={styles.page}>
      <PanelHeader
        title={
          <PanelHeaderLabel title="Inbox" icon={<BellIcon size="1rem" />} />
        }
        actions={
          <div className={styles.headerActions}>
            {!drafts && (
              <>
                <fieldset className={styles.scopeSwitch}>
                  <legend className="sr-only">Inbox scope</legend>
                  {[
                    { archived: false, label: "Inbox" },
                    { archived: true, label: "Archived" },
                  ].map(({ archived: value, label }) => (
                    <NavigationItem
                      key={label}
                      label={label}
                      variant="pill"
                      selected={archivedView === value}
                      onClick={() => {
                        if (archivedView === value) return;
                        cancelRetry();
                        setSelectedTarget(undefined);
                        setArchivedView(value);
                        setLimit(50);
                      }}
                    />
                  ))}
                </fieldset>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="About Inbox archive"
                  title="Archive choices are saved on this device for this account and community. They don’t sync to your other devices."
                >
                  <QuestionIcon size="1rem" aria-hidden="true" />
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              ref={draftsControl}
              onClick={() => {
                cancelRetry();
                setDrafts((current) => !current);
              }}
            >
              <span className="text-body">
                {drafts ? "Back to Inbox" : "Drafts"}
              </span>
            </Button>
          </div>
        }
      />
      {!drafts && failure && (
        <div className={styles.notice} role="alert">
          <p className="text-body">{failure}</p>
          <Button ref={retryButton} size="sm" loading={pending} onClick={retry}>
            Retry inbox
          </Button>
        </div>
      )}
      {drafts ? (
        <DraftsView
          onEmptyRetire={() => draftsControl.current?.focus()}
          session={session}
          scope={scope}
          navigator={navigator}
          extensions={extensions}
        />
      ) : (
        <div
          ref={workspace}
          className={styles.workspace}
          data-selected={!!selected || undefined}
        >
          <div className={styles.listPane}>
            <div ref={fallbackControl} className={styles.toolbar}>
              <div className={styles.filterPair}>
                <Select
                  label="Activity type"
                  variant="compact"
                  value={activity}
                  groups={[{ label: "", options: activities }]}
                  onValueChange={(value) => {
                    setActivity(value as ActivityFilter);
                    setLimit(50);
                  }}
                />
                <Select
                  label="Sender"
                  variant="compact"
                  value={senderFilter}
                  groups={[{ label: "", options: senders }]}
                  onValueChange={(value) => {
                    setSenderFilter(value as SenderFilter);
                    setLimit(50);
                  }}
                />
              </div>
              <Checkbox
                label="Unread only"
                checked={unreadOnly}
                onCheckedChange={(checked) => {
                  setUnreadOnly(checked);
                  setLimit(50);
                }}
              />
            </div>
            <div className={styles.scroll}>
              {inbox.freshness === "stale" && !failure && (
                <div className={styles.notice} role="status">
                  <span className="text-body text-subtle">
                    Showing retained activity.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={pending}
                    onClick={() => refresh()}
                  >
                    Refresh
                  </Button>
                </div>
              )}
              {(inbox.status === "idle" || feed.status === "idle") &&
                !loading &&
                !failure && (
                  <div className={styles.notice} role="status">
                    <span className="text-body text-subtle">
                      Check recent activity.
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={pending}
                      onClick={() => refresh()}
                    >
                      Refresh
                    </Button>
                  </div>
                )}
              {loading && (
                <p className={styles.notice} role="status">
                  Checking recent activity…
                </p>
              )}
              {!visible.length &&
                (inbox.status === "ready" || feed.status === "ready") &&
                !loading &&
                !failure && (
                  <div className={styles.empty} role="status">
                    <h3 className="text-label">
                      {archivedView
                        ? "No archived conversations in this view"
                        : unreadOnly
                          ? "No unread activity in this view"
                          : "No recent activity in this view"}
                    </h3>
                    <p className="text-body text-subtle">
                      {archivedView
                        ? "Archived conversations stay here until you restore them or receive a new mention."
                        : "Mentions, direct messages, and replies in threads you participate in appear here."}
                    </p>
                  </div>
                )}
              <ul
                className={styles.list}
                aria-label="Inbox conversations"
                aria-busy={pending}
              >
                {visible.map((item) => {
                  const channel = list.channels.find(
                    (candidate) => candidate.id === item.channelId,
                  );
                  const profile = profiles.get(item.authorId);
                  const sender = name(
                    item.authorId,
                    profile?.name ??
                      formatPublicKey(item.authorId) ??
                      "Unknown sender",
                    channel?.members,
                  );
                  const dmName = dmLabel(
                    channel?.participants,
                    profiles,
                    name,
                    channel?.name ?? "Direct message",
                  );
                  const context =
                    channel?.channelType === "dm"
                      ? `DM · ${dmName}`
                      : channel
                        ? `#${channel.name}`
                        : "Conversation";
                  const unread = hasUnread(item);
                  return (
                    <li
                      key={item.id}
                      className={styles.row}
                      data-unread={unread || undefined}
                      data-selected={selectedId === item.id || undefined}
                    >
                      <ContextMenuRoot
                        open={menu?.id === item.id}
                        onOpenChange={(open) =>
                          setMenu(open ? { id: item.id } : undefined)
                        }
                      >
                        <ContextMenuTrigger
                          render={<div className={styles.rowSurface} />}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ContextMenu" ||
                              (event.shiftKey && event.key === "F10")
                            ) {
                              event.preventDefault();
                              setMenu({
                                id: item.id,
                                anchor: event.target as HTMLElement,
                              });
                            }
                          }}
                        >
                          <NavigationItem
                            aria-label={`Open ${sender} in ${context}`}
                            aria-describedby={`${previewId}-${item.id}`}
                            disabled={pending}
                            selected={selectedId === item.id}
                            ref={
                              item.id === visible[0]?.id
                                ? fallbackRow
                                : undefined
                            }
                            icon={
                              <Avatar
                                size="default"
                                alt=""
                                fallback={sender}
                                src={
                                  profile?.picture
                                    ? session.media(profile.picture)
                                    : undefined
                                }
                                shape={profile?.isAgent ? "squircle" : "circle"}
                              />
                            }
                            label={
                              <span className={styles.content}>
                                <span className={styles.heading}>
                                  <strong
                                    className={`text-label-sm text-standard ${styles.sender}`}
                                  >
                                    {sender}
                                  </strong>
                                  <time
                                    className="text-caption text-subtle"
                                    dateTime={new Date(
                                      item.createdAt * 1000,
                                    ).toISOString()}
                                  >
                                    {relativeTimestamp(item.createdAt)}
                                  </time>
                                </span>
                                <span className={styles.sourceLine}>
                                  <span
                                    className={`text-caption ${styles.source}`}
                                    data-inbox-source=""
                                  >
                                    <span className={styles.sourceName}>
                                      {context}
                                    </span>
                                  </span>
                                </span>
                                <span
                                  id={`${previewId}-${item.id}`}
                                  className={`text-body ${unread ? "text-standard" : "text-subtle"} ${styles.preview}`}
                                >
                                  {item.messageIds.some((id) =>
                                    feed.incomplete.includes(id),
                                  )
                                    ? feed.status === "error"
                                      ? "Preview unavailable. Retry inbox."
                                      : "Preview updating…"
                                    : messagePreview(item.preview)}
                                </span>
                              </span>
                            }
                            onClick={(event) => {
                              // The selected row is the same visit, even when its
                              // current representative changed after reading.
                              if (busy.current || selectedId === item.id)
                                return;
                              cancelRetry();
                              invokingRow.current = event.currentTarget;
                              setSelectedTarget({
                                channelId: item.channelId,
                                messageId: item.messageId,
                                ...(item.rootId ? { rootId: item.rootId } : {}),
                              });
                              if (unread && canRead) mutate(item, false);
                            }}
                          />
                          {unread ? (
                            <span
                              className={styles.unreadSlot}
                              role="img"
                              aria-label="Unread"
                            >
                              <span className={styles.unreadDot} />
                            </span>
                          ) : (
                            <span
                              className={styles.unreadSlot}
                              aria-hidden="true"
                            />
                          )}
                        </ContextMenuTrigger>
                        <MenuPopup
                          size="compact"
                          aria-label={`Actions for ${sender} in ${context}`}
                          anchor={
                            menu?.id === item.id ? menu.anchor : undefined
                          }
                        >
                          <MenuItem
                            disabled={pending}
                            onClick={() => archive(item, !archivedView)}
                          >
                            {archivedView
                              ? "Restore conversation"
                              : "Archive conversation"}
                          </MenuItem>
                          <MenuItem
                            disabled={pending || unread || !canRead}
                            onClick={() => mutate(item, true)}
                          >
                            Mark unread
                          </MenuItem>
                        </MenuPopup>
                      </ContextMenuRoot>
                    </li>
                  );
                })}
              </ul>
              {matching.length > limit && (
                <div className={styles.notice}>
                  <Button onClick={() => setLimit((value) => value + 50)}>
                    Show more
                  </Button>
                </div>
              )}
            </div>
          </div>
          {selected && selectedTarget && (
            <InboxDetail
              key={`${selectedTarget.channelId}:${selectedTarget.messageId}`}
              item={selected}
              target={selectedTarget}
              session={session}
              scope={scope}
              navigator={navigator}
              extensions={extensions}
              channelName={
                list.channels.find(
                  (channel) => channel.id === selected.channelId,
                )?.name ?? "Conversation"
              }
              previewIncomplete={
                selected.messageIds.some((id) => feed.incomplete.includes(id))
                  ? feed.status === "error"
                    ? "error"
                    : "loading"
                  : undefined
              }
              archiveAction={{
                archived: archivedView,
                disabled: pending,
                run: () => archive(selected, !archivedView),
              }}
              onBack={() => {
                setRestoringFocus(true);
                cancelRetry();
                setSelectedTarget(undefined);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
