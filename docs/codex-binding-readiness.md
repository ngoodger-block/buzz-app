# Codex binding readiness

Codex is registered as a native integration, but agent creation remains disabled
until the later persistence, execution, validation, and UI layers are complete.
The Settings check in this layer verifies only that Buzz can bind the selected
installed tools and the user's existing CLI login.

## Binding contract

The native controller resolves one `CodexContext` for each check. It contains
canonical paths for the selected `codex-acp` adapter, `codex` CLI, any script
interpreters, the workspace, and the effective process environment. Adapter
commands receive the selected CLI through `CODEX_PATH`; there is no fallback to
an engine bundled with the adapter. Script interpreters are resolved explicitly,
and both adapter and CLI interpreter directories are included in the isolated
`PATH`. This readiness implementation currently runs on Unix platforms. Other
platforms report unsupported and keep Codex creation disabled.

The process environment starts empty. Buzz passes only the operating-system and
Codex home/configuration roots needed by the selected tools, then adds
`CODEX_PATH`, `INITIAL_AGENT_MODE=agent-full-access`, and a minimal executable
path. Provider credentials are not projected by this layer. Any ambient or
explicit `CODEX_CONFIG` value, including an empty value, is rejected until
readiness can apply and validate those session overrides against the same
configuration used by the adapter.

`HarnessIntegration::Codex` is the policy authority. An editable command basename
does not grant Codex policy or full-access behavior. The Codex policy admits no
persisted Default or Advanced mode yet, and its model and effort capabilities
remain unknown until later layers.

Context equality fences values used within one operation. It does not prove that
configuration files or authentication remained unchanged. Model discovery,
validation, and execution must resolve or revalidate the binding when they are
implemented.

## Readiness check

Settings runs the check once when the page opens and again only when the user
selects **Check again**. Ordinary agent snapshots and lifecycle polling remain
passive. A check performs these bounded steps in order:

1. Resolve the exact adapter, CLI, interpreters, workspace, and environment.
2. Require an exact `@agentclientprotocol/codex-acp` version identity at 1.10.0
   or later.
3. Require an exact `codex-cli` version identity.
4. Run `codex login status` before adapter initialization so logout and malformed
   configuration keep their distinct meanings.
5. Send ACP `initialize` and require protocol version 1 plus the same adapter
   version reported by the version probe.

Each subprocess has a five-second deadline and a 64 KiB output limit. Buzz uses
the existing session or Job Object process owner, stops the complete process
tree on timeout, cancellation, or excess output, joins capture workers, and
reaps the process before returning. Output and transport details are not sent to
the frontend. The UI receives fixed categories and recovery messages for missing
tools, missing interpreters, incompatible tools, logout, configuration failures,
timeout, excessive output, cleanup failure, cancellation, and unknown failures.

Checks use one-shot tickets. A newer request cancels the previous request; late
begin and completion results cannot replace the latest UI state. App shutdown
cancels the owned request and waits for native cleanup before allowing exit.
During a retry, Settings shows **Checking…** instead of presenting the previous
successful result as current.

## Compatibility evidence

The production readiness runner was exercised on macOS with:

- `@agentclientprotocol/codex-acp` 1.10.0, installed in an isolated temporary
  prefix;
- `/opt/homebrew/bin/codex`, reporting `codex-cli 0.151.0`;
- a minimal effective environment and `INITIAL_AGENT_MODE=agent-full-access`.

The real bounded ACP initialize completed with protocol version 1 and exact
adapter identity. The production test reported `binding-ready` with adapter
1.10.0 and CLI 0.151.0. No session, inference, model selection, effort selection,
or tool call was performed. This evidence establishes the PR 2 binding seam; it
does not establish the later execution or model/effort contract.

This acceptance was run from a macOS development checkout. Linux, Windows, a
packaged app, and the visible Settings workflow launched from a GUI with minimal
`PATH` were not exercised. Windows intentionally reports unsupported in this
layer. Those platform and packaging results must not be inferred from the
macOS command-line run.

The globally installed `@zed-industries/codex-acp` 0.16.0 was also inspected. It
embeds an older Codex engine and does not implement the required version
identity, so readiness rejects it. The supported adapter's empty ACP MCP list
does not disable MCP servers from Codex configuration, and the currently pinned
Buzz pool may continue after model or effort rejection. Those are explicit
prerequisites for the validation and execution layer and must be resolved before
Codex creation is enabled.

## Verification

Focused automated coverage binds the production seams for canonical resolution,
exact CLI launch through the adapter, isolated environment, failure categories,
one-shot ticket ownership, stale-result fencing, cancellation, timeout, finite
and continuous output overflow, process-tree retirement, shutdown cleanup, ACP
identity, and Settings recovery. The installed-tool acceptance test is ignored
by default and requires explicit paths:

```sh
BUZZ_TEST_CODEX_ADAPTER=/path/to/codex-acp \
BUZZ_TEST_CODEX_CLI=/path/to/codex \
cargo test --manifest-path src-tauri/Cargo.toml \
  codex_readiness::tests::unix::selected_production_binding \
  -- --ignored --nocapture
```

The check reads existing login and configuration state only. Tests for logout or
malformed configuration must use an isolated `CODEX_HOME`; do not modify the
user's ordinary Codex profile.
