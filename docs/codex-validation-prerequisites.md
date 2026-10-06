# Codex validation prerequisites

PR 4 of the [Codex harness plan](https://github.com/block/buzz-app/blob/codex/codex-harness-plan/docs/codex-harness-plan.md) requires real inference before identity creation or execution-setting edits, with no tool execution. Advanced validation must confirm the requested model and effort. Discovery does not establish these properties. Codex creation must remain disabled until tool-free validation is implemented and verified. Runtime fallback behavior remains the same as the current buzz-app runtime.

## Tool-free inference

The tested installed pair is Codex CLI 0.151.0 and `@agentclientprotocol/codex-acp` 1.10.0. ACP initialize has been verified; PR 3 records discovery evidence separately. This pair does not expose an enforceable all-tools-disabled inference mode.

Evidence from the exact CLI release:

- [ThreadStartParams](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server-protocol/schema/json/v2/ThreadStartParams.json) and [TurnStartParams](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/app-server-protocol/schema/json/v2/TurnStartParams.json) do not expose a global tool policy or tool-choice restriction.
- The [tool registry builder](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/src/tools/spec_plan.rs) assembles built-in, MCP, extension, dynamic, and hosted tools through separate paths. Disabling the shell feature does not remove ApplyPatch or the other tool families.
- The [configuration schema](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/core/config.schema.json) provides individual feature and MCP controls, not a global deny-all execution invariant.

The [adapter 1.10.0 client](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/CodexAcpClient.ts) retains user-configured MCP servers when `session/new` receives an empty MCP list. Its prompt path passes model, effort, approval and sandbox settings to app-server, without a global tool restriction. The [selected CLI launcher](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/CodexJsonRpcConnection.ts) must continue to honor the selected `CODEX_PATH` rather than use a bundled engine. The subsequently inspected [adapter 2.1.1 client](https://github.com/agentclientprotocol/codex-acp/blob/v2.1.1/src/CodexAcpClient.ts) retains the same relevant limitation; changing only the adapter version does not resolve it.

A prompt asking for no tools is not enforcement. A read-only sandbox limits effects but still permits tool invocation. An approval policy controls approvals, not all execution. Rejecting ACP tool notifications occurs too late to prevent tools executed within Codex. Enumerating configuration keys and disabling known tools cannot guarantee that other or future tool contributors are absent.

The smallest proposed compatibility contract is:

1. Codex app-server advertises a no-tools session capability and accepts a thread-scoped deny-all policy before MCP/plugin/app tool initialization. The model request has no tools, the executable router is empty, and dispatch rejects any provider-emitted tool call. Existing authentication, provider, configuration layering, workspace, model, and effort resolution remain intact.
2. The ACP adapter advertises an equivalent vendor capability and forwards it to the selected CLI for an ephemeral validation session. Missing CLI support causes rejection before inference; it must never silently downgrade to an ordinary session.
3. Buzz requires both capabilities before issuing its minimal validation prompt. A version floor alone is insufficient. Validation still passes no Buzz identity, relay, or authorization credentials and retires the entire process tree on every exit.

The capability names and wire fields above are a proposed contract, not existing APIs. Implementation and released compatible installations are external prerequisites. A locally patched or bundled replacement CLI would violate the selected-installed-CLI contract, and automatic installation is outside this stack's scope.

Falsifiable acceptance tests for the prerequisite:

- Configure all built-in, MCP, plugin/app, dynamic, and hosted tool families. A no-tools thread exposes no tools and starts no MCP/plugin/app tool process; fixture tripwires remain untouched.
- Capture the provider request and verify the requested model/effort and credential/configuration context while tools are absent and tool choice forbids calls.
- Return adversarial shell, ApplyPatch, web, MCP, and unknown calls from a controlled provider. The turn fails before every handler or side-effect counter changes.
- Reject an unsupported CLI before inference, including when the user's configuration contains MCP servers. Test timeout, cancellation, and complete child retirement through the production adapter path.
- Through Buzz's real validation admission, prove failures produce no identity or agent-record write, and successful admission binds only the exact checked input and saved revision.

## Runtime fallback: preserve existing behavior

The pinned [Buzz pool at 4f51b9e](https://github.com/block/buzz/blob/4f51b9e1010e086a16c099cd8d8218ca974a5e18/crates/buzz-acp/src/pool.rs) treats application-level model or startup-effort rejection as nonfatal and may continue with defaults. It also proceeds when a desired model cannot be resolved or configured effort has no matching option. This behavior remains present in the upstream main source inspected during this work.

The product decision on October 6, 2026 is to retain this existing behavior. This stack must not change runtime model/effort fallback policy or require an upstream fix or runtime-pin update for that purpose. Runtime fallback is no longer an enablement blocker.

The separate Create/Edit validation contract remains: Advanced validation must confirm the requested settings before admitting a save. PR 6 must distinguish requested settings from settings actually reported by the runtime, including any fallback; it must not present a requested setting as observed evidence.

Tool-free inference remains the unresolved prerequisite for PR 4 and its dependent layers. No inference was run as part of this source investigation, and no ordinary CLI configuration, credentials, or global installation was modified.
