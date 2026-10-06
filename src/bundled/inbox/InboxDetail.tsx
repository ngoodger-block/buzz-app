import { ConversationPresentation } from "../../features/conversation/ConversationPresentation";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { NavigationScope } from "../../features/navigation/targets";
import type { Navigation } from "../../features/navigation/controller";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { InboxItem } from "../../features/relay/inbox";
import { ThreadPanel } from "../../features/messages/ThreadPanel";
import { ChannelPreview } from "./ChannelPreview";
import { useIdentityNames } from "../../features/identity-names/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import {
  ArrowSquareOutIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Inbox.module.css";
import { dmLabel } from "./dm-label";

export function InboxDetail({
  item,
  target,
  session,
  scope,
  navigator,
  extensions,
  channelName,
  previewIncomplete,
  archiveAction,
  onBack,
}: {
  item: InboxItem;
  target: { channelId: string; messageId: string; rootId?: string };
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
  extensions?: ConversationExtensions | undefined;
  channelName: string;
  previewIncomplete?: "loading" | "error" | undefined;
  archiveAction?:
    | { archived: boolean; disabled: boolean; run(): void }
    | undefined;
  onBack(): void;
}) {
  const [error, setError] = useState<string>();
  const placeholderClose = useRef<HTMLButtonElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const readerFocus = useRef<HTMLElement | null>(null);
  const withheldFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Only the initial placeholder visit needs this; readers own exact reveal.
    placeholderClose.current?.focus({ preventScroll: true });
  }, []);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channel = list.channels.find(
    (candidate) => candidate.id === item.channelId,
  );
  const available =
    !!channel &&
    !channel.cached &&
    !channel.archived &&
    !channel.readOnly &&
    !!channel.members?.includes(scope.viewer);
  // Inbox keys this component by the captured visit. Revalidation withholds an
  // admitted reader, but must not recreate its reveal request or editor.
  const [admitted, setAdmitted] = useState(false);
  useEffect(() => {
    if (!available) setAdmitted(false);
    else if (!previewIncomplete) setAdmitted(true);
  }, [available, previewIncomplete]);
  useLayoutEffect(() => {
    if (!available) {
      readerFocus.current = withheldFocus.current = null;
    } else if (previewIncomplete) {
      // Capture events retain ownership across the host's hidden/inert mutation,
      // which can already have blurred the reader before layout effects run.
      if (
        readerFocus.current &&
        (document.activeElement === readerFocus.current ||
          document.activeElement === document.body)
      ) {
        withheldFocus.current = readerFocus.current;
        readerFocus.current = null;
        placeholderClose.current?.focus({ preventScroll: true });
      }
    } else {
      const prior = withheldFocus.current;
      withheldFocus.current = null;
      // Close's blur cancels the handoff, including an intentional blur to body.
      // Its removal on recovery is not a user move; still respect another owner.
      if (
        prior?.isConnected &&
        reader.current?.contains(prior) &&
        document.activeElement === document.body &&
        !prior.closest('[hidden], [inert], [aria-hidden="true"]') &&
        !prior.matches(':disabled, [aria-disabled="true"]') &&
        prior.getClientRects().length
      )
        prior.focus({ preventScroll: true });
    }
  }, [available, previewIncomplete]);
  useEffect(() => {
    // A retired portal releases its modal inert boundary in passive cleanup.
    if (
      previewIncomplete &&
      withheldFocus.current &&
      !withheldFocus.current.isConnected &&
      document.activeElement === document.body
    )
      placeholderClose.current?.focus({ preventScroll: true });
  }, [previewIncomplete]);
  const participantKey =
    channel?.channelType === "dm"
      ? (channel.participants ?? []).slice(0, 3).join(":")
      : "";
  const participantIds = useMemo(
    () => (participantKey ? participantKey.split(":") : []),
    [participantKey],
  );
  const selection = useMemo(
    () => selectProfiles(session.profiles, participantIds),
    [session, participantIds],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const name = useIdentityNames(session.names);
  useEffect(() => {
    void list.asOf;
    if (available && participantIds.length)
      void session.profiles
        .ensure(participantIds, "background")
        .catch(() => {});
  }, [session, participantIds, available, list.asOf]);
  const dmName = dmLabel(channel?.participants, profiles, name);
  const open = async () => {
    const destination = {
      version: 1 as const,
      kind: "conversation" as const,
      scope,
      channelId: target.channelId,
      messageId: target.messageId,
      ...(target.rootId ? { threadRootId: target.rootId } : {}),
    };
    const result = await navigator.open(destination);
    if (result.status === "failed")
      setError("This conversation could not be opened. Try again.");
  };
  const openAction = (
    <IconButton
      size="toolbar"
      aria-label="Open in channel"
      onClick={() => void open()}
      icon={<ArrowSquareOutIcon size={18} aria-hidden="true" />}
    />
  );
  return (
    <section
      className={styles.detail}
      aria-label="Inbox detail"
      onKeyDown={(event) => {
        // Detail owns dismissal regardless of reader/placeholder. Children may
        // consume Escape; ThreadPanel already stops its own close event.
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className={styles.detailHeading}>
        <h2 className="text-label text-primary">
          {channel?.channelType === "dm"
            ? `DM with ${dmName}`
            : `#${channelName}`}
        </h2>
        {archiveAction && (
          <Button
            size="sm"
            variant="ghost"
            disabled={
              archiveAction.disabled || !available || !!previewIncomplete
            }
            onClick={archiveAction.run}
            aria-label={
              archiveAction.archived
                ? "Restore conversation"
                : "Archive conversation"
            }
          >
            {archiveAction.archived ? "Restore" : "Archive"}
          </Button>
        )}
        {(!available || previewIncomplete) && (
          <div className={styles.detailActions}>
            {openAction}
            <IconButton
              ref={placeholderClose}
              onBlur={() => {
                withheldFocus.current = null;
              }}
              size="toolbar"
              aria-label="Close detail"
              onClick={onBack}
              icon={<XIcon size={18} aria-hidden="true" />}
            />
          </div>
        )}
      </div>
      <div className={styles.detailBody}>
        {error && (
          <p role="alert" className={styles.notice}>
            {error}
          </p>
        )}
        {previewIncomplete ? (
          <p
            role={previewIncomplete === "error" ? "alert" : "status"}
            className={styles.notice}
          >
            {previewIncomplete === "error"
              ? "Preview unavailable. Retry inbox."
              : "Preview updating…"}
          </p>
        ) : !available ? (
          <p role="status" className={styles.notice}>
            This conversation is unavailable. Open it in Channels to check
            access.
          </p>
        ) : null}
        {available && (admitted || !previewIncomplete) && (
          <ConversationPresentation value={!previewIncomplete}>
            <div
              className={styles.detailBody}
              ref={reader}
              onFocusCapture={(event) => {
                readerFocus.current = event.target;
              }}
              onBlurCapture={(event) => {
                // Ignore loss caused by withholding/removing an owned portal,
                // not deliberate moves or blur while the reader is visible.
                if (
                  event.relatedTarget ||
                  (event.target.isConnected && !event.currentTarget.hidden)
                )
                  readerFocus.current = null;
              }}
              hidden={!!previewIncomplete}
              inert={!!previewIncomplete}
              // The flex class must not override native hidden presentation.
              style={previewIncomplete ? { display: "none" } : undefined}
            >
              {item.target.kind === "channel" ? (
                <ChannelPreview
                  session={session}
                  extensions={extensions}
                  channelId={item.channelId}
                  channelName={
                    channel?.channelType === "dm"
                      ? `DM with ${dmName}`
                      : channelName
                  }
                  anchor={target.messageId}
                  onClose={onBack}
                  exactActions={openAction}
                  actions={
                    <>
                      {openAction}
                      <IconButton
                        size="toolbar"
                        aria-label="Close detail"
                        onClick={onBack}
                        icon={<XIcon size={18} aria-hidden="true" />}
                      />
                    </>
                  }
                />
              ) : (
                <ThreadPanel
                  session={session}
                  scope={session.scope}
                  extensions={extensions}
                  channelId={item.channelId}
                  channelName={channelName}
                  messageId={target.messageId}
                  sessionConversation={channel?.channelType === "session"}
                  revealSelected
                  close={onBack}
                  onOpenLink={() => false}
                  headerActions={openAction}
                />
              )}
            </div>
          </ConversationPresentation>
        )}
      </div>
    </section>
  );
}
