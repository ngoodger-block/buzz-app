import { motion } from "motion/react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type FocusEvent,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import {
  canManageMember,
  canRemoveMember,
  editableMemberRoles,
  type MemberChange,
} from "../../features/channel-members/administration-protocol";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import styles from "./ChannelMembersDialog.module.css";

/** Row-wide hover includes the separate action; focus includes both profile links. */
function useMemberReveal() {
  const [focused, setFocused] = useState(false);
  return {
    initial: false as const,
    animate: focused ? "focused" : "rest",
    whileHover: focused ? "focused" : "revealed",
    // React focus bubbles through portals; only physical row controls reveal it.
    onFocusCapture: (event: FocusEvent<HTMLElement>) =>
      setFocused(event.currentTarget.contains(event.target)),
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    },
  };
}

export function useMemberAdministration(
  session: RelaySession,
  channelId: string,
  memberKey: string,
  readable: boolean,
) {
  const capability = session.memberAdministration;
  const state = useSyncExternalStore(
    capability.subscribe,
    () => capability.snapshot(channelId),
    () => capability.snapshot(channelId),
  );
  // Membership changes (including ordinary invitations) invalidate role presentation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: memberKey refreshes the current roster's roles.
  useEffect(() => {
    if (readable) void capability.refresh(channelId).catch(() => {});
  }, [capability, channelId, memberKey, readable]);
  // Session access invalidation can clear roles without changing this roster.
  // Recover only an idle, readable snapshot; failed reads still need explicit retry.
  const idle = state.status === "idle";
  useEffect(() => {
    if (readable && idle && capability.snapshot(channelId).status === "idle")
      void capability.refresh(channelId).catch(() => {});
  }, [capability, channelId, idle, readable]);
  return state;
}

export function MemberRow({
  session,
  channelId,
  pubkey,
  name,
  verifiedOwner,
  onChange,
  returnFocus,
  scrollport,
  onViewProfile,
  onViewOwnerProfile,
  onSendMessage,
  messagePending,
  invitationAction,
  highlight,
  children,
}: {
  session: RelaySession;
  channelId: string;
  pubkey: string;
  name: string;
  verifiedOwner?: string | undefined;
  onChange(change: MemberChange): void;
  returnFocus: React.RefObject<HTMLElement | null>;
  scrollport: React.RefObject<HTMLElement | null>;
  onViewProfile?: (() => boolean) | undefined;
  onViewOwnerProfile?: (() => boolean) | undefined;
  onSendMessage?: (() => void) | undefined;
  messagePending?: boolean | undefined;
  invitationAction?: ReactNode;
  /** The search highlight, for rows a picker can choose with Enter. */
  highlight?:
    | {
        id: string;
        active: boolean;
        onPointerMove(event: React.PointerEvent): void;
      }
    | undefined;
  children: ReactNode;
}) {
  const reveal = useMemberReveal();
  const capability = session.memberAdministration;
  const state = useSyncExternalStore(
    capability.subscribe,
    () => capability.snapshot(channelId),
    () => capability.snapshot(channelId),
  );
  const openingConfirmation = useRef(false);
  const [menuOpen, setMenuOpen] = useState<"button" | "context">();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement>();
  useEffect(() => {
    const viewport = scrollport.current;
    if (!menuOpen || !viewport) return;
    const dismiss = () => setMenuOpen(undefined);
    viewport.addEventListener("scroll", dismiss, { passive: true });
    return () => viewport.removeEventListener("scroll", dismiss);
  }, [menuOpen, scrollport]);
  const menuReturnFocus = useRef<HTMLElement | null>(null);
  const openingProfile = useRef(false);
  const role = state.authority.roles[pubkey] ?? "unknown";
  const permitted =
    !invitationAction && capability.available && state.status === "ready";
  const canEdit =
    permitted && canManageMember(state.authority, session.viewer ?? "", pubkey);
  const canRemove =
    permitted &&
    canRemoveMember(
      state.authority,
      session.viewer ?? "",
      pubkey,
      verifiedOwner,
    );
  const locked =
    state.operation?.status === "pending" ||
    state.operation?.status === "uncertain";
  const choose = (next: MemberChange["role"]) => {
    openingConfirmation.current = true;
    onChange({ pubkey, expectedRole: role, role: next });
  };
  const finalFocus = () =>
    openingConfirmation.current || openingProfile.current
      ? false
      : (menuReturnFocus.current ?? returnFocus.current);
  const menuItems = (
    <>
      <MenuItem
        disabled={!onViewProfile}
        onClick={() => {
          // The destination panel takes focus; neither closing layer may
          // restore focus to a row in the dialog that is being unmounted.
          openingProfile.current = onViewProfile?.() ?? false;
        }}
      >
        View profile
      </MenuItem>
      {onViewOwnerProfile && (
        <MenuItem
          onClick={() => {
            openingProfile.current = onViewOwnerProfile();
          }}
        >
          View owner profile
        </MenuItem>
      )}
      {onSendMessage && (
        <MenuItem disabled={messagePending} onClick={onSendMessage}>
          Send message
        </MenuItem>
      )}
      {(canEdit || canRemove) && !locked && (
        <>
          <MenuSeparator />
          {canEdit &&
            editableMemberRoles
              // Guest assignment is hidden until its permission contract is settled.
              .filter((next) => next !== role && next !== "guest")
              .map((next) => (
                <MenuItem key={next} onClick={() => choose(next)}>
                  Make {next}
                </MenuItem>
              ))}
          {canEdit && <MenuSeparator />}
          {canRemove && (
            <MenuItem tone="danger" onClick={() => choose("remove")}>
              Remove from channel
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  return (
    <ContextMenuRoot
      open={menuOpen === "context"}
      onOpenChange={(open) => {
        if (open) {
          openingProfile.current = false;
          openingConfirmation.current = false;
        }
        setMenuOpen((current) =>
          open ? "context" : current === "context" ? undefined : current,
        );
      }}
    >
      <ContextMenuTrigger
        render={
          invitationAction ? (
            <motion.div {...reveal} />
          ) : (
            <motion.li {...reveal} />
          )
        }
        className={styles.member}
        id={highlight?.id}
        data-highlighted={highlight?.active || undefined}
        onPointerMove={highlight?.onPointerMove}
        data-menu-open={menuOpen || undefined}
        onContextMenu={(event) => {
          setMenuAnchor(undefined);
          menuReturnFocus.current = event.currentTarget.querySelector("button");
        }}
        onTouchStart={(event) => {
          setMenuAnchor(undefined);
          menuReturnFocus.current = event.currentTarget.querySelector("button");
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            menuReturnFocus.current = event.target as HTMLElement;
            setMenuAnchor(event.currentTarget);
            openingProfile.current = false;
            openingConfirmation.current = false;
            setMenuOpen("context");
          }
        }}
      >
        <div className={styles.profile}>{children}</div>
        {invitationAction}
        {!invitationAction && (
          <span className={styles.memberActions}>
            {/* A regular trigger needs its own root: registering it on the
                  context root replaces Base UI's context-menu interaction owner. */}
            <MenuRoot
              open={menuOpen === "button"}
              onOpenChange={(open, details) => {
                if (open) {
                  openingProfile.current = false;
                  openingConfirmation.current = false;
                  menuReturnFocus.current =
                    details.trigger instanceof HTMLElement
                      ? details.trigger
                      : null;
                }
                setMenuOpen((current) =>
                  open ? "button" : current === "button" ? undefined : current,
                );
              }}
            >
              <MenuTrigger
                render={
                  <IconButton
                    variant="ghost"
                    size="sm"
                    shape="row-end"
                    aria-label={`Actions for ${name}`}
                    icon={<DotsThreeIcon size={18} aria-hidden="true" />}
                  />
                }
              />
              <MenuPopup
                aria-label={`Actions for ${name}`}
                align="end"
                finalFocus={finalFocus}
              >
                {menuItems}
              </MenuPopup>
            </MenuRoot>
          </span>
        )}
      </ContextMenuTrigger>
      <MenuPopup
        aria-label={`Actions for ${name}`}
        anchor={menuAnchor}
        align={menuAnchor ? "end" : "start"}
        finalFocus={finalFocus}
      >
        {menuItems}
      </MenuPopup>
    </ContextMenuRoot>
  );
}
