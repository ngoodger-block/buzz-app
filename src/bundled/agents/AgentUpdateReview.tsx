import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { messageViewKey } from "../../features/messages/view-key";
import { agentDraft, harnessKind, type AgentDraft } from "./agent-edit";
import { AgentEditor } from "./AgentEditor";
import type {
  AgentControl,
  AgentView,
  ControlSnapshot,
} from "../../features/agents/control";
import type { ChannelList } from "../../features/relay/contracts";
import type { AgentManagementRequest } from "../../features/agents/management-request";
import { relayOrigin } from "../../features/communities/destination";
import { sameCommunityAgents } from "../../features/agents/choices";
import { AgentSessionSettings } from "./AgentSessionSettings";

export type PendingManagementRequest = {
  agent: string;
  value: AgentManagementRequest;
};
const MANAGEMENT_QUEUE_LIMIT = 200;

export function AgentUpdateReview({
  relay,
  control,
}: {
  relay: RelayData;
  control: AgentControl;
}) {
  const connection = useSyncExternalStore(
    relay.subscribe,
    relay.snapshot,
    relay.snapshot,
  );
  return (
    <SessionAgentUpdateReview
      key={messageViewKey(connection.session, connection.scope)}
      connection={connection}
      control={control}
    />
  );
}

function SessionAgentUpdateReview({
  connection,
  control,
}: {
  connection: RelaySnapshot;
  control: AgentControl;
}) {
  const controlState = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  const channelList = useSyncExternalStore(
    connection.session.channels.subscribeList,
    connection.session.channels.list,
    connection.session.channels.list,
  );
  const [requests, setRequests] = useState<PendingManagementRequest[]>([]);
  const [refreshedRequestId, setRefreshedRequestId] = useState<string | null>(
    null,
  );
  const [authorizedRequest, setAuthorizedRequest] =
    useState<PendingManagementRequest | null>(null);
  const [rosterError, setRosterError] =
    useState<PendingManagementRequest | null>(null);
  const [selection, setSelection] = useState<{
    value: AgentManagementRequest;
    id: string;
  } | null>(null);
  const request = requests[0] ?? null;
  useEffect(() => {
    if (connection.status !== "ready") return;
    const release = connection.session.agentManagement.activate();
    const unsubscribe = connection.session.agentManagement.subscribe(
      (agent, value) => {
        setRequests((pending) =>
          enqueueManagementRequest(pending, { agent, value }),
        );
      },
    );
    return () => {
      unsubscribe();
      release();
    };
  }, [connection]);
  useEffect(() => {
    setAuthorizedRequest(null);
    setRosterError(null);
    if (
      !request ||
      connection.status !== "ready" ||
      channelList.status !== "ready"
    )
      return;
    let current = true;
    const channels = connection.session.channels;
    const channelId = request.value.request.channelId;
    void (async () => {
      const listed = channels
        .list()
        .channels.some((channel) => channel.id === channelId);
      const fresh = listed
        ? await channels.refreshRoster?.(channelId)
        : channels.resolve
          ? await channels.resolve([channelId]).then(() => true)
          : false;
      if (!current) return;
      const membership = managementRequesterAuthorized(
        request,
        channels.list(),
      );
      if (fresh === true && membership === true) setAuthorizedRequest(request);
      else if (membership === false) setRequests((pending) => pending.slice(1));
      else setRosterError(request);
    })().catch(() => {
      if (current) setRosterError(request);
    });
    return () => {
      current = false;
    };
  }, [
    channelList.status,
    connection.session.channels,
    connection.status,
    request,
  ]);
  useEffect(() => {
    if (
      request &&
      authorizedRequest === request &&
      managementRequesterAuthorized(request, channelList) === false
    )
      setRequests((pending) => pending.slice(1));
  }, [authorizedRequest, channelList, request]);
  useEffect(() => {
    if (request?.value.action !== "update") {
      setRefreshedRequestId(null);
      return;
    }
    const requestId = request.value.requestId;
    if (controlState.busy || refreshedRequestId === requestId) return;
    let current = true;
    void refreshManagementInventory(control).then((ready) => {
      if (current && ready) setRefreshedRequestId(requestId);
    });
    return () => {
      current = false;
    };
  }, [control, controlState.busy, refreshedRequestId, request]);
  const selectedId =
    selection?.value === request?.value ? selection?.id : undefined;
  const membership = request
    ? managementRequesterAuthorized(request, channelList)
    : null;
  const confirmed =
    connection.status === "ready" &&
    authorizedRequest === request &&
    membership === true;
  const matches = useMemo(() => {
    if (request?.value.action !== "update" || !connection.scope) return [];
    const community = connection.scope.split(":").slice(0, -1).join(":");
    return matchingManagementAgents(
      controlState.data?.agents ?? [],
      request,
      community,
      selectedId,
    );
  }, [connection.scope, controlState.data?.agents, request, selectedId]);
  useEffect(() => {
    const match = matches.length === 1 ? matches[0] : undefined;
    if (
      request &&
      confirmed &&
      refreshedRequestId === request.value.requestId &&
      !selectedId &&
      match
    )
      setSelection({ value: request.value, id: match.id });
  }, [confirmed, matches, refreshedRequestId, request, selectedId]);
  if (!request) return null;
  const dismiss = () => setRequests((pending) => pending.slice(1));
  const retryMembership = () =>
    setRequests((pending) =>
      pending[0] === request ? [{ ...request }, ...pending.slice(1)] : pending,
    );
  if (rosterError === request && !selectedId) {
    return (
      <ToastNotice
        title="Could not verify request membership"
        description="Retry the channel roster read before reviewing this request."
        onDismiss={dismiss}
      >
        <Button type="button" onClick={retryMembership}>
          Retry
        </Button>
      </ToastNotice>
    );
  }
  if ((!confirmed && !selectedId) || membership === false) return null;
  if (request.value.action === "create") {
    return (
      <ToastNotice
        title="Agent creation needs attention"
        description="Agent-requested creation is not supported yet. Create the agent yourself from Agents."
        onDismiss={dismiss}
      />
    );
  }
  if (
    controlState.status === "error" &&
    refreshedRequestId !== request.value.requestId
  ) {
    return (
      <ToastNotice
        title="Could not load personal agents"
        description="Refresh local agents before reviewing this request."
      >
        <Button
          type="button"
          onClick={() => {
            void refreshManagementInventory(control).then((ready) => {
              if (ready) setRefreshedRequestId(request.value.requestId);
            });
          }}
        >
          Retry
        </Button>
      </ToastNotice>
    );
  }
  if (
    (controlState.status !== "ready" && controlState.status !== "error") ||
    refreshedRequestId !== request.value.requestId
  )
    return null;
  const agent = matches.length === 1 ? matches[0] : undefined;
  if (agent && !selectedId) return null;
  if (!agent) {
    return (
      <ToastNotice
        title="Agent update needs attention"
        description={
          matches.length > 1
            ? "More than one personal agent has that name. Rename one, then ask again."
            : `No personal agent named ${request.value.request.agentName} was found.`
        }
        onDismiss={dismiss}
      />
    );
  }
  const initial = requestedDraft(
    agent,
    request.value,
    controlState.data?.harnessOptions ?? [],
  );
  return (
    <AgentEditor
      key={request.value.requestId}
      agent={agent}
      control={control}
      state={controlState}
      initialDraft={initial}
      disabled={!confirmed}
      notice="Requested by an agent. Review every field before saving."
      onClose={dismiss}
      details={
        agent.harness.integration === "codex" &&
        sameCommunityAgents([agent], connection.scope ?? "").length === 1 ? (
          <AgentSessionSettings
            agent={agent}
            activity={connection.session.agentActivity}
          />
        ) : undefined
      }
    >
      {!confirmed && (
        <div>
          <p role="alert" className="text-body-sm text-subtle">
            Request membership is unconfirmed. Your edits are retained; writes
            are paused until it is verified.
          </p>
          {rosterError === request && (
            <Button type="button" onClick={retryMembership}>
              Retry
            </Button>
          )}
        </div>
      )}
    </AgentEditor>
  );
}

export async function refreshManagementInventory(
  control: AgentControl,
): Promise<boolean> {
  if (control.snapshot().busy) return false;
  await control.refresh();
  const state = control.snapshot();
  return state.status === "ready" && !state.busy;
}

export function matchingManagementAgents(
  agents: readonly AgentView[],
  request: PendingManagementRequest,
  community: string,
  selectedId?: string,
): AgentView[] {
  if (request.value.action !== "update") return [];
  const target = request.value.request.agentName.trim().toLocaleLowerCase();
  const origin = relayOrigin(community);
  return agents.filter((agent) => {
    if (
      agent.configured === false ||
      !agent.relayUrl ||
      (selectedId
        ? agent.id !== selectedId
        : agent.name.trim().toLocaleLowerCase() !== target) ||
      agent.pubkey !== request.agent
    )
      return false;
    try {
      return relayOrigin(agent.relayUrl) === origin;
    } catch {
      return false;
    }
  });
}

export function enqueueManagementRequest(
  pending: readonly PendingManagementRequest[],
  request: PendingManagementRequest,
): PendingManagementRequest[] {
  const next = [...pending, request];
  if (next.length <= MANAGEMENT_QUEUE_LIMIT) return next;
  const [head] = next;
  if (!head) return [];
  return [head, ...next.slice(-(MANAGEMENT_QUEUE_LIMIT - 1))];
}

export function managementRequesterAuthorized(
  request: PendingManagementRequest,
  channels: ChannelList,
): boolean | null {
  if (channels.status !== "ready") return null;
  const channel = channels.channels.find(
    (candidate) => candidate.id === request.value.request.channelId,
  );
  if (!channel && channels.coverage === "partial") return null;
  return channel?.members?.includes(request.agent) ?? false;
}

export function requestedDraft(
  agent: AgentView,
  request: Extract<AgentManagementRequest, { action: "update" }>,
  harnessOptions: NonNullable<ControlSnapshot["harnessOptions"]>,
): AgentDraft {
  const current = agentDraft(agent);
  const changes = request.request;
  const runtime = changes.runtime
    ? harnessOptions.find((option) => {
        const executable = option.command
          .replaceAll("\\", "/")
          .split("/")
          .at(-1);
        return (
          option.available !== false &&
          (option.command === changes.runtime ||
            executable === changes.runtime ||
            harnessKind(option.command) === changes.runtime)
        );
      })
    : undefined;
  return {
    ...current,
    name: changes.displayName ?? current.name,
    systemPrompt: changes.systemPrompt ?? current.systemPrompt,
    command: runtime?.command ?? changes.runtime ?? current.command,
    args: runtime ? JSON.stringify(runtime.defaultArgs ?? []) : current.args,
    provider: changes.provider ?? current.provider,
    model: changes.model ?? current.model,
  };
}
