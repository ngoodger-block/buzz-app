// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KnownCommunities } from "../../features/communities/service";
import { HostService } from "../../features/host/service";
import { SettingsCardsService } from "../../features/settings/service";
import * as builderlab from "./index";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import manifest from "./manifest.json";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
/** The device's identity, which the account must be bound to before its
 * community list follows the sign-in. */
const viewer = "cd".repeat(32);
function provideKnownCommunities(root: Context) {
  const knownCommunities: KnownCommunities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
      sync: { known: {}, outbox: [] },
      viewer,
      selected: null,
      memberships: [],
    }),
    subscribe: () => () => {},
    pending: () => [],
    apply: vi.fn(async () => {}),
    status: vi.fn(),
  };
  root.provide("knownCommunities", knownCommunities);
  return knownCommunities;
}
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  native.invoke.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("an unconfigured desktop build shows setup guidance and cannot start login", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => builderlab);
  new HostService(root);
  provideKnownCommunities(root);
  const cards = new SettingsCardsService(root);
  try {
    runtime.reconcile([
      {
        manifest: { ...manifest, apiVersion: 1 },
        source: "bundled",
        revision: "bundled",
        enabled: true,
        previous: null,
        reloadable: false,
        error: null,
      },
    ]);
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    const card = cards.snapshot()[0];
    if (!card) throw new Error("Missing Builderlab card");
    const Card = card.component;
    render(<Card active={() => true} />);
    expect(screen.getByRole("status")).toHaveTextContent("not configured");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(native.invoke).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it("binds login, list, creation and community sync to the plugin host and clears the session on disable/re-enable", async () => {
  native.invoke.mockImplementation(async (command, input) => {
    if (command === "oauth_callback_begin")
      return {
        id: "native-attempt-id",
        callbackUrl: `http://127.0.0.1:12345${input.callbackPath}`,
      };
    if (command === "oauth_callback_wait")
      return { parameters: [["code", "one-time"]] };
    if (command === "oauth_callback_cancel") return;
    if (command === "identity_restore") return "cd".repeat(32);
    if (command === "identity_prepare_remote_agent_authorization")
      return ["auth", "cd".repeat(32), "", "ef".repeat(64)];
    if (command === "plugin_host_request")
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          input.request.url.endsWith("/exchange")
            ? { session_credential: "private-token" }
            : input.request.url.endsWith("/list-agents")
              ? { status: 1, agents: [] }
              : input.request.url.endsWith("/register-agent")
                ? { status: 1, agent_id: "one", agent_pubkey: "ab".repeat(32) }
                : input.request.url.endsWith("/attest-agent")
                  ? { status: 1 }
                  : input.request.url.endsWith("/nostr-identities/current")
                    ? { identity: { pubkey_hex: viewer } }
                    : input.request.url.endsWith("/known-communities/list")
                      ? { communities: [] }
                      : {
                          subject: "user",
                          email: "a@example.com",
                        },
        ),
      };
    throw new Error(`Unexpected command ${command}`);
  });
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => builderlab);
  new HostService(root);
  const knownCommunities = provideKnownCommunities(root);
  const cards = new SettingsCardsService(root);
  const plugin: PluginInfo = {
    manifest: { ...manifest, apiVersion: 1 },
    source: "bundled",
    revision: "bundled",
    enabled: true,
    previous: null,
    reloadable: false,
    error: null,
  };
  try {
    runtime.reconcile([plugin]);
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    const card = cards.snapshot()[0];
    expect(card?.group).toBe("Integrations");
    if (!card) throw new Error("Missing Builderlab login card");
    const Card = card.component;
    const mounted = render(<Card active={() => true} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
    expect(
      await screen.findByText("No remote agents yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Signed in as a@example.com.",
    );
    expect(document.body).not.toHaveTextContent("private-token");
    expect(native.invoke).toHaveBeenCalledWith("oauth_callback_wait", {
      id: "native-attempt-id",
    });
    // The signed-in account's community list follows through the same wiring:
    // the binding is checked, then the complete list is read.
    await waitFor(() =>
      expect(knownCommunities.status).toHaveBeenLastCalledWith({
        phase: "synced",
        pending: 0,
      }),
    );
    const requests = native.invoke.mock.calls
      .filter(([command]) => command === "plugin_host_request")
      .map(([, input]) => input);
    const [account, sync] = [
      requests.filter((input) => !input.request.url.includes("/v1/buzz/")),
      requests.filter((input) => input.request.url.includes("/v1/buzz/")),
    ];
    expect(account).toHaveLength(3);
    expect(
      requests.every(
        (input) =>
          input.id === "block.builderlab" && input.revision === "bundled",
      ),
    ).toBe(true);
    // Prove the account login supplies this consumer's credential through the real plugin wiring.
    expect(account.at(-1).request.headers["X-BB-Session-Credential"]).toBe(
      "private-token",
    );
    expect(sync.map((input) => input.request.url)).toEqual([
      "https://builderlab.example/api/goose/v1/buzz/nostr-identities/current",
      "https://builderlab.example/api/goose/v1/buzz/known-communities/list",
    ]);
    expect(
      sync.every(
        (input) =>
          input.request.headers["X-BB-Session-Credential"] === "private-token",
      ),
    ).toBe(true);
    expect(sync[1].request.body).toBe(JSON.stringify({ pubkey_hex: viewer }));
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "Agent name" }),
      "Helper",
    );
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
    expect(native.invoke).toHaveBeenCalledWith(
      "identity_prepare_remote_agent_authorization",
      { owner: "cd".repeat(32), agentPubkey: "ab".repeat(32) },
    );
    const mutations = native.invoke.mock.calls
      .filter(
        ([command, input]) =>
          command === "plugin_host_request" &&
          /\/(register|attest)-agent$/.test(input.request.url),
      )
      .map(([, input]) => input);
    expect(mutations).toHaveLength(2);
    expect(
      mutations.every(
        (input) =>
          input.id === "block.builderlab" && input.revision === "bundled",
      ),
    ).toBe(true);
    await act(async () => {
      runtime.reconcile([]);
    });
    expect(cards.snapshot()).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    ).toBeEnabled();
    // The disabled plugin's sync owner withdraws its report with it.
    expect(knownCommunities.status).toHaveBeenLastCalledWith(undefined);
    mounted.unmount();
    runtime.reconcile([plugin]);
    await waitFor(() => expect(cards.snapshot()).toHaveLength(1));
    const fresh = cards.snapshot()[0];
    expect(fresh).not.toBe(card);
    if (!fresh) throw new Error("Missing reactivated Builderlab login card");
    const FreshCard = fresh.component;
    render(<FreshCard active={() => true} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sign in securely");
  } finally {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
  }
});
