# Codex validation compatibility decisions

PR 4 of the [Codex harness plan](https://github.com/block/buzz-app/blob/codex/codex-harness-plan/docs/codex-harness-plan.md) requires real inference before identity creation or execution-setting edits. Advanced validation must confirm the requested model and effort. The product decisions on October 6, 2026 remove the earlier tool-free inference and strict runtime fallback prerequisites. PR 4 can proceed with the selected installed tools and current Buzz runtime behavior.

## Validation uses ordinary Codex capabilities

Validation uses the selected CLI and adapter in the same effective workspace and Codex configuration context. It runs one bounded minimal inference prompt. It need not enforce tool-free execution and must not require a new deny-all capability, an upstream Codex/adapter release, or a substitute engine for that purpose.

Buzz passes no Buzz identity, relay, or authorization credentials and supplies no Buzz MCP servers to the validator. It does not publish a channel message. Codex's configured tools, including built-in tools and user-configured MCP servers, may remain available. The Create/Edit flow must describe this as a real Codex request that may consume quota and use configured tools, not as a guaranteed tool-free or side-effect-free check. A minimal prompt can ask for a short response without tools, but that is a request rather than enforcement.

The tested pair is Codex CLI 0.151.0 and `@agentclientprotocol/codex-acp` 1.10.0. PR 3 records initialize and discovery evidence; this does not establish successful inference. The [adapter client](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/CodexAcpClient.ts) retains user-configured MCP servers when `session/new` receives an empty MCP list. That behavior is accepted under the revised contract. The [selected CLI launcher](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/CodexJsonRpcConnection.ts) must continue to honor the selected `CODEX_PATH` rather than use a bundled engine.

PR 4 must still verify:

- Advanced validation applies and confirms the exact requested model and effort; Default sends no model/effort overrides.
- Failed or cancelled validation produces no Buzz identity or agent-record write, and a failed Edit leaves the saved/running revision unchanged.
- Admission is single-use and bound to the checked request, input, context, and saved revision where applicable.
- Inference, output, cancellation, and process-tree retirement remain bounded through the shared native session owner.
- Create/Edit does not misrepresent discovery evidence or prompt instructions as proof of successful or tool-free inference.

## Runtime fallback: preserve existing behavior

The pinned [Buzz pool at 4f51b9e](https://github.com/block/buzz/blob/4f51b9e1010e086a16c099cd8d8218ca974a5e18/crates/buzz-acp/src/pool.rs) treats application-level model or startup-effort rejection as nonfatal and may continue with defaults. It also proceeds when a desired model cannot be resolved or configured effort has no matching option. This behavior remains present in the upstream main source inspected during this work.

The product decision on October 6, 2026 is to retain this existing behavior. This stack must not change runtime model/effort fallback policy or require an upstream fix or runtime-pin update for that purpose. Runtime fallback is no longer an enablement blocker.

The separate Create/Edit validation contract remains: Advanced validation must confirm the requested settings before admitting a save. PR 6 must distinguish requested settings from settings actually reported by the runtime, including any fallback; it must not present a requested setting as observed evidence.

Neither tool-free inference nor strict runtime fallback is an external prerequisite for PR 4 under these decisions. PR 4 still must implement and verify validation, persistence, recovery, and execution before enabling creation. No inference was run as part of this source investigation, and no ordinary CLI configuration, credentials, or global installation was modified.
