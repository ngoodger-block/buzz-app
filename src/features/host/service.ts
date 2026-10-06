import { invoke, isTauri } from "@tauri-apps/api/core";
import { Service, type Context } from "@deepseek-ai/cordis";
import type {} from "../../plugins/api";
import { nativeIdentityEnabled } from "../identity/service";
import type { PluginManager } from "../../plugins/manager";
import type { ImportPreview, StorageResult } from "../../plugins/types";

export type HostRequest = Readonly<{
  url: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}>;
export type HostResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
/** Reusable NIP-OA proof for one agent key; preparing it does not submit it. */
export type NipOaAuthorization = readonly [
  "auth",
  ownerPubkey: string,
  conditions: string,
  signature: string,
];
export type HostPluginAction = "enable" | "disable" | "remove";
/**
 * Plugin management for a plugin whose manifest declares `host.plugins`.
 * These are the operations Settings › Plugins uses. Writes run one at a time,
 * shared with Settings; each resolves after the app catalog shows its result.
 */
export interface HostPlugins {
  /** The ready app catalog, with every plugin (bundled ones too). */
  snapshot(): Extract<StorageResult, { status: "ready" }>;
  subscribe(listener: () => void): () => void;
  /** Fetches a Git repository and lists its plugins. Desktop only. */
  importGit(
    repository: string,
    reference?: string,
    /** A NIP-98 token signed for exactly `repository`. */
    authorization?: string,
  ): Promise<ImportPreview>;
  discardImport(token: string): Promise<void>;
  /** Installs one plugin from a preview. New plugins stay turned off. */
  install(token: string, path: string): Promise<void>;
  change(action: HostPluginAction, id: string): Promise<void>;
}
export interface Host {
  runCommand(id: string): Promise<string | null>;
  request(input: HostRequest): Promise<HostResponse>;
  /** Absent on hosts older than the `host.plugins` declaration. */
  readonly plugins?: HostPlugins;
  prepareRemoteAgentAuthorization?: (
    agentPubkey: string,
    signal?: AbortSignal,
  ) => Promise<NipOaAuthorization>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    host: Host;
  }
}

/** Native commands and storage reject with strings; callers expect errors. */
const asError = (reason: unknown) =>
  reason instanceof Error ? reason : new Error(String(reason));

export class HostService extends Service implements Host {
  constructor(
    context: Context,
    private readonly manager?: PluginManager,
  ) {
    super(context, "host");
  }

  /** Read through the calling plugin's context, so the grant is its own. */
  get plugins(): HostPlugins {
    const manager = this.manager;
    const owner = this.ctx.pluginOwner;
    const management = () => {
      if (!manager || !owner)
        throw new Error("Plugin management needs an installed plugin");
      // A plugin runs only from a ready catalog, which also holds its grant.
      const configuration = manager.snapshot().configuration;
      if (configuration.status !== "ready")
        throw new Error("Plugin settings are not ready");
      const plugin = configuration.catalog.plugins.find(
        (entry) =>
          entry.manifest.id === owner.id && entry.revision === owner.revision,
      );
      if (!plugin?.enabled || plugin.manifest.host?.plugins !== true)
        throw new Error("This plugin does not declare host.plugins");
      return { manager, configuration };
    };
    const write = async (
      operation: (manager: PluginManager) => Promise<void>,
    ) => {
      const { manager } = management();
      await operation(manager).catch((reason: unknown) => {
        throw asError(reason);
      });
    };
    return Object.freeze({
      snapshot: () => management().configuration,
      subscribe: (listener: () => void) =>
        management().manager.subscribe(listener),
      async importGit(repository, reference = "", authorization) {
        const { manager } = management();
        if (!manager.imports)
          throw new Error("Plugin imports require the desktop app");
        const preview = await manager.imports
          .git(repository, reference, authorization)
          .catch((reason: unknown) => {
            throw asError(reason);
          });
        if (!preview) throw new Error("No plugin was found in this repository");
        return preview;
      },
      async discardImport(token) {
        const { manager } = management();
        await manager.imports?.discard(token).catch((reason: unknown) => {
          throw asError(reason);
        });
      },
      install: (token, path) =>
        write((manager) =>
          manager.perform(() => {
            if (!manager.imports)
              throw new Error("Plugin imports require the desktop app");
            return manager.imports.install(token, path);
          }),
        ),
      change: (action, id) => {
        if (action !== "enable" && action !== "disable" && action !== "remove")
          return Promise.reject(new Error("Unknown plugin action"));
        return write((manager) =>
          manager.perform(() => manager.changePlugin(action, id)),
        );
      },
    } satisfies HostPlugins);
  }

  async prepareRemoteAgentAuthorization(
    agentPubkey: string,
    signal?: AbortSignal,
  ): Promise<NipOaAuthorization> {
    signal?.throwIfAborted();
    if (!/^[0-9a-f]{64}$/.test(agentPubkey))
      throw new Error("Agent pubkey must be 64 lowercase hex characters");
    const native = nativeIdentityEnabled();
    const owner = native
      ? await invoke<string | null>("identity_restore")
      : (
          await (
            await fetch("/api/relay/identity", { signal: signal ?? null })
          ).json()
        ).viewer;
    signal?.throwIfAborted();
    if (typeof owner !== "string" || !/^[0-9a-f]{64}$/.test(owner))
      throw new Error("Set up your identity first");
    if (owner === agentPubkey)
      throw new Error("Owner and agent pubkeys must differ");
    let tag: NipOaAuthorization;
    if (native) {
      try {
        tag = await invoke<NipOaAuthorization>(
          "identity_prepare_remote_agent_authorization",
          { owner, agentPubkey },
        );
      } catch (error) {
        throw typeof error === "string" ? new Error(error) : error;
      }
    } else {
      const response = await fetch(
        "/api/relay/prepare-remote-agent-authorization",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ owner, agentPubkey }),
          signal: signal ?? null,
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Owner authorization failed");
      tag = result;
    }
    signal?.throwIfAborted();
    if (
      !Array.isArray(tag) ||
      tag.length !== 4 ||
      tag[0] !== "auth" ||
      tag[1] !== owner ||
      tag[2] !== "" ||
      typeof tag[3] !== "string" ||
      !/^[0-9a-f]{128}$/.test(tag[3])
    )
      throw new Error("Invalid remote agent authorization");
    return tag;
  }

  async runCommand(id: string): Promise<string | null> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri()) return null;
    try {
      return await invoke<string | null>("plugin_host_run_command", {
        id: owner.id,
        revision: owner.revision,
        commandId: id,
      });
    } catch {
      return null;
    }
  }

  async request(input: HostRequest): Promise<HostResponse> {
    const owner = this.ctx.pluginOwner;
    if (!owner || !isTauri())
      throw new Error("Host requests require an installed desktop plugin");
    return invoke<HostResponse>("plugin_host_request", {
      id: owner.id,
      revision: owner.revision,
      request: input,
    });
  }
}
