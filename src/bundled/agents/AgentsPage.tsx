import { UnifiedInventory } from "./UnifiedInventory";
import type { CommunityReader } from "../../features/communities/service";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PageProps } from "../../features/pages/service";
import type { OpenTarget } from "../../features/navigation/targets";
import type { OpenResult } from "../../features/navigation/controller";
import type {
  PanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { profileTarget } from "../../features/profiles/target";
import { editAgentRoute } from "./edit-route";
import type {
  AgentControl,
  AgentControlState,
  AgentView,
} from "../../features/agents/control";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { relayOrigin } from "../../features/communities/destination";
import { useRelayConnection } from "../../features/relay/react";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { sameCommunityAgents } from "../../features/agents/choices";
import { AgentLibrary } from "./AgentLibrary";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentCard, type ProfileResolver } from "./AgentCard";
import { AgentControlPanel } from "./AgentControlPanel";
import { ManagedAgentActions } from "./ManagedAgentActions";
import { PanelCard } from "../../features/panels/PanelCard";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { AgentSessionSettings } from "./AgentSessionSettings";

const noPanels = Object.freeze([]) as readonly RegisteredPanel[];
const noPanelSnapshot = () => noPanels;
const noPanelSubscribe = () => () => {};
const noCommunities = { subscribe: () => () => {}, snapshot: () => undefined };

export function AgentsPage({
  relay,
  control,
  navigation,
  open,
  panels,
  companion,
  companionOpening,
  communities,
}: PageProps & {
  relay: RelayData;
  control?: AgentControl;
  panels?: Panels;
  communities?: CommunityReader;
  open?: (
    target: OpenTarget,
    options?: { replace?: boolean },
  ) => Promise<OpenResult>;
}) {
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(
    null,
  );
  const connection = useRelayConnection(relay);
  const pageSurface = useRef<HTMLElement>(null);
  const registeredPanels = useSyncExternalStore(
    panels?.subscribe ?? noPanelSubscribe,
    panels?.snapshot ?? noPanelSnapshot,
    panels?.snapshot ?? noPanelSnapshot,
  );
  const opening = useRef(0);
  const profileCard = useRef<HTMLElement>(null);
  const [profile, setProfile] = useState<{
    panel: RegisteredPanel;
    target: string;
    trigger: HTMLButtonElement;
    opening: number;
  }>();
  const previousProfile = useRef(profile);
  const restoreProfileFocus = useRef(true);
  useEffect(() => {
    const before = previousProfile.current;
    previousProfile.current = profile;
    if (
      profile &&
      before !== profile &&
      !profileCard.current?.contains(document.activeElement)
    )
      profileCard.current?.focus({ preventScroll: true });
    if (before && !profile && restoreProfileFocus.current) {
      const target = before.trigger.isConnected
        ? before.trigger
        : pageSurface.current;
      target?.focus({ preventScroll: true });
    }
    restoreProfileFocus.current = true;
  }, [profile]);
  useEffect(() => {
    if (profile && !registeredPanels.includes(profile.panel)) {
      opening.current++;
      setProfile(undefined);
    }
  }, [profile, registeredPanels]);
  const previousCompanionOpening = useRef(companionOpening);
  useEffect(() => {
    const before = previousCompanionOpening.current;
    previousCompanionOpening.current = companionOpening;
    if (profile && companionOpening && companionOpening !== before) {
      opening.current++;
      restoreProfileFocus.current = false;
      setProfile(undefined);
    }
  }, [companionOpening, profile]);
  const currentOpening = profile?.opening;
  const canOpenProfile = (target: string) =>
    currentOpening !== undefined &&
    opening.current === currentOpening &&
    panels?.resolve(target) !== undefined;
  const panelContext: PanelContext = {
    channelId: "",
    canOpen: canOpenProfile,
    open: (target) => {
      const panel = panels?.resolve(target);
      if (
        !panel ||
        currentOpening === undefined ||
        opening.current !== currentOpening
      )
        return false;
      setProfile((current) =>
        current?.opening === currentOpening
          ? { ...current, panel, target }
          : current,
      );
      return true;
    },
  };
  const closeProfile = () => {
    if (currentOpening === undefined || opening.current !== currentOpening)
      return;
    opening.current++;
    setProfile((current) =>
      current?.opening === currentOpening ? undefined : current,
    );
  };
  const resolveProfile: ProfileResolver = (pubkey) => {
    const target = profileTarget(pubkey, { agent: true });
    const panel = target && panels?.resolve(target);
    return target && panel
      ? (trigger: HTMLButtonElement) =>
          setProfile({ panel, target, trigger, opening: ++opening.current })
      : undefined;
  };
  const resolveName = useIdentityNames(connection.session.names);
  const request = useMemo(
    () => navigation?.forSession(relay, connection),
    [navigation, relay, connection],
  );
  const target = request?.target;
  const editTarget =
    target?.kind === "page" && target.route
      ? editAgentRoute(target.route.params)
      : null;
  useEffect(() => {
    if (!request || request.signal.aborted) return;
    // The routed edit destination must not acknowledge an unrelated page.
    if (target?.kind !== "page") return;
    if (!editTarget && !target.route) request.complete({ status: "opened" });
    else if (!editTarget)
      request.complete({ status: "failed", reason: "unavailable" });
    else if (
      !control ||
      (connection.status !== "ready" && connection.status !== "connecting")
    )
      request.complete({ status: "failed", reason: "unavailable" });
  }, [request, target, editTarget, control, connection.status]);
  const reader = communities ?? noCommunities;
  const client = useSyncExternalStore(
    reader.subscribe,
    reader.snapshot,
    reader.snapshot,
  );
  let importDestination = "";
  if (
    connection.viewer &&
    connection.scope?.endsWith(`:${connection.viewer}`)
  ) {
    try {
      importDestination = relayOrigin(
        connection.scope.slice(0, -(connection.viewer.length + 1)),
      );
    } catch {
      // A non-URL fixture or unavailable connection needs an explicit destination.
    }
  }
  const library =
    connection.status === "ready" ? (
      <AgentLibrary
        key={`${connection.scope}:${connection.generation}`}
        session={connection.session}
        headerActions={headerActions}
      />
    ) : (
      <div>
        <p>Connect to a community to browse the old library.</p>
        {connection.status === "error" && (
          <Button onClick={() => relay.retry()}>Retry connection</Button>
        )}
      </div>
    );
  const pageCompanion =
    profile || companion ? (
      <>
        {companion && <div hidden={profile !== undefined}>{companion}</div>}
        {profile && (
          <PanelCard
            ref={profileCard}
            panel={profile.panel}
            target={profile.target}
            context={panelContext}
            close={closeProfile}
          />
        )}
      </>
    ) : undefined;
  return (
    <div className="h-full min-h-0">
      <PanelFrame companion={pageCompanion}>
        <FullPageSurface aria-label="Agents" ref={pageSurface} tabIndex={-1}>
          <div className="flex h-full min-h-0 flex-col">
            <PanelHeader
              title="Agents"
              actions={<div ref={setHeaderActions} />}
            />
            <div className="min-h-0 flex-1 overflow-auto p-panel-inset text-body">
              <div className="mx-auto flex max-w-6xl flex-col gap-panel-gap">
                {control ? (
                  <AgentControlPanel
                    control={control}
                    editorDetails={(agent) =>
                      connection.status === "ready" &&
                      agent.harness.integration === "codex" &&
                      sameCommunityAgents([agent], connection.scope ?? "")
                        .length === 1 ? (
                        <AgentSessionSettings
                          agent={agent}
                          activity={connection.session.agentActivity}
                        />
                      ) : undefined
                    }
                    editTarget={editTarget}
                    onOpenHarnesses={
                      open
                        ? () => {
                            void open({
                              version: 1,
                              kind: "settings",
                              section: "agents",
                            });
                          }
                        : undefined
                    }
                    {...(editTarget && request && connection.status === "ready"
                      ? { editRequest: request }
                      : {})}
                    onCloseTarget={() => {
                      if (target?.kind === "page" && open)
                        void open(
                          {
                            version: 1,
                            kind: "page",
                            pluginId: target.pluginId,
                            pageId: target.pageId,
                            ...(target.scope !== undefined
                              ? { scope: target.scope }
                              : {}),
                          },
                          { replace: true },
                        );
                    }}
                    resolveName={resolveName}
                    importDestination={importDestination}
                    createOwner={
                      connection.status === "ready"
                        ? connection.viewer
                        : undefined
                    }
                  >
                    {(
                      state,
                      edit,
                      duplicate,
                      remove,
                      importedId,
                      label,
                      onUseHere,
                      onImport,
                    ) =>
                      state.status === "unavailable" ? (
                        library
                      ) : state.data?.parked !== undefined ? (
                        <UnifiedInventory
                          key={connection.viewer ?? "offline"}
                          state={state}
                          edit={edit}
                          duplicate={duplicate}
                          remove={control.delete ? remove : undefined}
                          importedId={importedId}
                          control={control}
                          connection={connection}
                          client={client}
                          resolveProfile={resolveProfile}
                          profileKeys={
                            new Set(
                              sameCommunityAgents(
                                state.data?.agents ?? [],
                                connection.scope ?? "",
                              ).map((agent) => agent.pubkey),
                            )
                          }
                          onUseHere={onUseHere}
                          onImport={onImport}
                        />
                      ) : (
                        <ManagedAgents
                          onUseHere={onUseHere}
                          key={`${connection.scope}:${connection.generation}`}
                          state={state}
                          label={label}
                          edit={edit}
                          duplicate={duplicate}
                          remove={remove}
                          importedId={importedId}
                          control={control}
                          connection={connection}
                          destination={importDestination}
                          resolveProfile={resolveProfile}
                          headerActions={headerActions}
                        />
                      )
                    }
                  </AgentControlPanel>
                ) : (
                  <>
                    <p className="text-secondary">
                      Open the desktop app to import and run agents. You can
                      still mention existing channel members.
                    </p>
                    {library}
                  </>
                )}
              </div>
            </div>
          </div>
        </FullPageSurface>
      </PanelFrame>
    </div>
  );
}
function ManagedAgents({
  state,
  edit,
  duplicate,
  remove,
  importedId,
  control,
  connection,
  label,
  destination,
  resolveProfile,
  headerActions,
  onUseHere,
}: {
  label(agent: AgentView): string;
  state: AgentControlState;
  edit(agent: AgentView, avatar?: string): void;
  duplicate(agent: AgentView): void;
  remove(agent: AgentView): void;
  importedId: string | null;
  control: AgentControl;
  connection: RelaySnapshot;
  destination: string;
  resolveProfile: ProfileResolver;
  headerActions: HTMLElement | null;
  onUseHere(pubkey: string, action: "use" | "clone"): void;
}) {
  const library = connection.session.agentLibrary;
  const snapshot = useSyncExternalStore(
    library.subscribe,
    library.snapshot,
    library.snapshot,
  );
  return (
    <section aria-label="My agents" className="flex flex-col gap-4">
      <h2 className="sr-only">My agents</h2>
      <p className="m-0 text-body-sm text-secondary">
        Set up an imported agent with Use here, then start it separately. Before
        starting the same identity here, stop the old agent and disable its
        automatic startup in the old app.
      </p>
      {state.data?.agents.length === 0 && (
        <p>No agents yet. Create an agent or import one from old Buzz below.</p>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
        {state.data?.agents.map((agent) => {
          const identity = snapshot.identities.find(
            (entry) => entry.pubkey === agent.pubkey,
          );
          return (
            <AgentCard
              key={agent.id}
              name={label(agent)}
              avatar={identity?.avatar}
              identities={[agent]}
              session={connection.session}
              editable={[agent]}
              onEdit={edit}
              onDuplicate={duplicate}
              onDelete={control.delete ? remove : undefined}
              onViewProfile={
                sameCommunityAgents([agent], connection.scope ?? "").length
                  ? resolveProfile(agent.pubkey)
                  : undefined
              }
            >
              <ManagedAgentActions
                agent={agent}
                onUseHere={onUseHere}
                state={state}
                control={control}
                imported={agent.id === importedId}
                destination={destination}
                owner={
                  connection.status === "ready" ? (connection.viewer ?? "") : ""
                }
              />
            </AgentCard>
          );
        })}
      </div>
      {connection.status === "ready" && (
        <AgentLibrary
          session={connection.session}
          headerActions={headerActions}
          managedKeys={state.data?.agents.map((agent) => agent.pubkey) ?? []}
        />
      )}
    </section>
  );
}
