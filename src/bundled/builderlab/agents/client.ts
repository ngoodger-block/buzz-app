import type { Host, HostResponse } from "../../../features/host/service";
import { oauthTarget, type Credential } from "../oauth/browser";
import type { OAuthSession } from "../oauth/session";
import { clearRegistration, registrationIntent } from "./registration";

export type RemoteAgent = Readonly<{
  id: string;
  name: string;
  pubkey: string;
  status: "Active" | "Unattested" | "Revoked" | "Unknown";
}>;

function resultStatus(value: unknown) {
  return typeof value === "string"
    ? (value.split("_").at(-1) ?? "")
    : typeof value === "number"
      ? value
      : "";
}

function agentStatus(value: unknown): RemoteAgent["status"] {
  const status = String(value ?? "")
    .split("_")
    .at(-1);
  if (status === "2" || status === "ACTIVE") return "Active";
  if (status === "1" || status === "UNATTESTED") return "Unattested";
  if (status === "3" || status === "REVOKED") return "Revoked";
  return "Unknown";
}

export function createAgentClient(
  host: Host,
  session: OAuthSession,
  communityUrl: () => string | undefined,
) {
  function check(credential: Credential, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      session.snapshot().status !== "signed-in" ||
      session.credential() !== credential
    )
      throw new DOMException("Builderlab session changed.", "AbortError");
  }
  async function request(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const credential = session.credential();
    let response: HostResponse;
    try {
      response = await host.request({
        url: `${oauthTarget()}/v3/beekeeper/${path}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-BB-Session-Credential": credential.value,
        },
        body: JSON.stringify(body),
      });
    } catch {
      check(credential, signal);
      throw new Error("Could not reach Builderlab. Try again.");
    }
    check(credential, signal);
    if (response.status === 401) {
      session.signOut();
      throw Object.assign(
        new Error("Your Builderlab session expired. Sign in again."),
        { status: 401 },
      );
    }
    if (response.status === 403)
      throw Object.assign(
        new Error("This Builderlab account cannot manage remote agents."),
        { status: 403 },
      );
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(
        new Error(`Builderlab request failed (HTTP ${response.status}).`),
        { status: response.status },
      );
    try {
      const result = JSON.parse(response.body);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error();
      return result;
    } catch {
      throw new Error("Builderlab returned an invalid response.");
    }
  }
  return {
    async delete(agent: RemoteAgent, signal: AbortSignal): Promise<void> {
      if (!agent.id.trim()) throw new Error("Agent ID is unavailable.");
      const result = await request(
        "delete-agent",
        { agent_id: agent.id },
        signal,
      );
      const status = resultStatus(result.status);
      // NOT_FOUND also confirms completion after a successful delete lost its response.
      if ([1, "DELETED", 3, "FOUND"].includes(status)) return;
      throw new Error(
        [2, "DISABLED"].includes(status)
          ? "Agent deletion is disabled on this server."
          : "Agent deletion was not confirmed. Retry Delete agent.",
      );
    },
    async register(name: string, signal: AbortSignal): Promise<RemoteAgent> {
      signal.throwIfAborted();
      const agentName = name.trim();
      if (!/^[\w .-]{1,64}$/.test(agentName))
        throw new Error(
          "Use 1–64 letters, numbers, spaces, dots, hyphens or underscores for the agent name.",
        );
      const { account } = session.credential();
      const intent = registrationIntent(
        oauthTarget(),
        account.subject,
        agentName,
      );
      let result: Record<string, unknown>;
      try {
        result = await request(
          "register-agent",
          { agent_name: agentName, idempotency_key: intent.key },
          signal,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "status" in error &&
          [400, 401, 403, 404, 409, 422].includes(Number(error.status))
        ) {
          clearRegistration(intent);
        } else if (error instanceof Error && error.name !== "AbortError") {
          throw new Error(
            `${error.message} Retry the same name to recover the original request.`,
          );
        }
        throw error;
      }
      const status = resultStatus(result.status);
      const rejected = new Map<string | number, string>([
        [2, "Agent creation is disabled on this server."],
        ["DISABLED", "Agent creation is disabled on this server."],
        [3, "Finish setup for an existing agent before creating another."],
        [
          "REGISTRATIONS",
          "Finish setup for an existing agent before creating another.",
        ],
        [4, "Your remote agent limit has been reached."],
        ["AGENTS", "Your remote agent limit has been reached."],
        [5, "This creation request conflicts with another agent name."],
        [
          "CONFLICT",
          "This creation request conflicts with another agent name.",
        ],
      ]).get(status);
      if (rejected) {
        clearRegistration(intent);
        throw new Error(rejected);
      }
      if (
        ![1, "UNATTESTED"].includes(status) ||
        typeof result.agent_id !== "string" ||
        !result.agent_id.trim() ||
        typeof result.agent_pubkey !== "string" ||
        !/^[0-9a-f]{64}$/.test(result.agent_pubkey)
      )
        throw new Error(
          "Creation was not confirmed. Retry the same name to recover the original request.",
        );
      clearRegistration(intent);
      return {
        id: result.agent_id,
        name: agentName,
        pubkey: result.agent_pubkey,
        status: "Unattested",
      };
    },
    async attest(
      agent: RemoteAgent,
      signal: AbortSignal,
      active: () => boolean,
      owner?: string,
    ): Promise<RemoteAgent> {
      signal.throwIfAborted();
      if (!active())
        throw new DOMException("Builderlab card is inactive.", "AbortError");
      const credential = session.credential();
      const community = communityUrl();
      if (!host.prepareRemoteAgentAuthorization)
        throw new Error(
          "Remote agent authorization is unavailable in this Buzz build.",
        );
      const tag = await host.prepareRemoteAgentAuthorization(
        agent.pubkey,
        signal,
      );
      check(credential, signal);
      if (!active())
        throw new DOMException("Builderlab card is inactive.", "AbortError");
      if (communityUrl() !== community)
        throw new Error("Community changed. Use Finish setup to try again.");
      if (owner && tag[1] !== owner)
        throw new Error(
          "Agent authorization and community identities differ. Retry with the same Buzz identity.",
        );
      const result = await request(
        "attest-agent",
        {
          agent_pubkey: agent.pubkey,
          owner_auth_tag_json: JSON.stringify(tag),
          ...(community ? { community_url: community } : {}),
        },
        signal,
      );
      if (![1, "ACTIVE"].includes(resultStatus(result.status)))
        throw new Error(
          "Agent setup was not confirmed. Use Finish setup to try again.",
        );
      return { ...agent, status: "Active" };
    },
    async list(signal: AbortSignal): Promise<readonly RemoteAgent[]> {
      const result = await request("list-agents", {}, signal);
      if (![1, "SUCCESS"].includes(resultStatus(result.status)))
        throw new Error("Builderlab did not return an agent list.");
      // Protobuf JSON can omit an empty repeated field.
      const agents = result.agents ?? [];
      if (
        !Array.isArray(agents) ||
        agents.some(
          (row) =>
            !row ||
            typeof row.agent_id !== "string" ||
            !row.agent_id.trim() ||
            typeof row.agent_name !== "string" ||
            typeof row.agent_pubkey !== "string" ||
            !/^[0-9a-f]{64}$/.test(row.agent_pubkey),
        )
      )
        throw new Error("Builderlab returned an invalid agent list.");
      return agents.map((row) => ({
        id: row.agent_id,
        name: row.agent_name,
        pubkey: row.agent_pubkey,
        status: agentStatus(row.status),
      }));
    },
  };
}
export type AgentClient = ReturnType<typeof createAgentClient>;
