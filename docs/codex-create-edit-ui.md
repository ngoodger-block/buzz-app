# Codex Create and Edit UI acceptance

This record covers PR 5 of the Codex harness stack. The implementation commit is
`97a6621b` on `codex/codex-create-edit-ui`, based on PR 4 commit
`ac1cb02acd3070417c7e5ca9845b8d9df21d1889`. Checks below were run on October 6,
2026. The feature remains draft pending the live human workflow listed below.

## Product behavior

Codex is selected through its native integration ID. The form does not infer
Codex from an executable basename. It exposes Default and Advanced modes without
provider, API-key, Databricks, or custom-argument fields. Default stores no model
or effort override. Advanced requires an advertised model and its model-specific
effort, or explicit acceptance that the model reports no effort control.

Capability lookup preserves saved values when a catalog is unknown, empty,
failed, or has retired a saved choice. A user model change clears only an effort
that the new model's metadata proves invalid. Refresh and unrelated renders do
not erase selections or restart discovery. Late results are fenced by their
request context.

Create checks completed receipts before running another inference. A fresh Codex
request performs native validation before identity preparation. While inference
is active, the modal says `Testing Codex connection…` and supports in-place
cancellation. Once native identity preparation begins, the modal says
`Creating agent…` and no longer presents validation cancellation. Failed or
cancelled validation retains the draft and creates no durable identity.

Edit uses native change detection. Name-only changes return a nullable validation
result and proceed directly to native Save. Execution changes validate before
Save; the UI changes from `Testing Codex connection…` to `Saving changes…` at
that boundary. Failure and cancellation retain the draft and leave the saved and
running revision unchanged. Successful Save keeps the existing native restart
behavior.

The Create modal reads the native recovery journal. A matching destination and
owner can resume using the original inputs and fresh owner authorization. Any
pending request can be explicitly discarded. Secure relay targets are compared
through the existing canonical origin function, so native `wss://` records match
the form's `https://` destination. The UI stores no key, authorization payload,
or plaintext execution settings.

Duplicate carries the Codex integration, mode, model, and effort while the
existing duplicate boundary omits identity credentials and write-only
environment values. Device-wide Agent defaults remain limited to Buzz Agent,
Goose, and Pi. Their UI explains that Codex is configured per agent and that
Codex Default delegates model and effort to the CLI.

## Automated evidence

The focused frontend matrix passed:

```text
pnpm typecheck
  passed

pnpm exec vitest run \
  src/features/agents/control.test.ts \
  src/bundled/agents/agent-edit.test.ts \
  src/bundled/agents/AgentCreateDialog.test.tsx \
  src/bundled/agents/AgentEditor.test.tsx \
  src/bundled/agents/CodexConfigurationFields.test.tsx \
  src/app/AgentDefaultsCard.test.tsx --reporter dot
  6 files, 146 tests passed

pnpm exec playwright test --config tests/browser/playwright.config.mjs \
  tests/browser/agent-control.spec.mjs --grep "Codex Create" \
  --project chromium --project webkit --no-deps
  2 tests passed
```

The browser journey uses the production React components and
`createAgentControl` service with a synthetic host boundary. It uses keyboard
selection for Codex, Advanced, model, and effort; verifies hidden provider
controls; cancels a held validation; retries; creates exactly one identity; then
reopens and edits that identity without changing the original fixture agent.

The focused native seams passed:

```text
cargo test --manifest-path src-tauri/Cargo.toml \
  agents::tests::real_ipc_snapshot_save_cas_stop_and_launch_gate -- --exact
  1 passed

cargo test --manifest-path src-tauri/Cargo.toml \
  agents::tests::creation::codex_native_admission_and_recovery_survive_a_fresh_host \
  -- --exact
  1 passed
```

These native tests use controlled executables and synthetic credential custody.
They prove that fresh Create returns `validationRequired` before identity
generation, successful proofs survive until native consumption, name-only Edit
retires its unused ticket without inference, failed validation preserves the
record, and journal recovery reuses one identity across a fresh host.

Independent review runs reported 138 passing existing Agent page/editor/defaults
tests and 137 passing control/orchestration tests. PR 4's hosted run
`37513686030` passed every required Rust, JavaScript, Chromium, and WebKit Linux
job; Windows native validation was intentionally skipped because the current
native support is Unix-only.

Independent interactive QA used the isolated `agent-control.html?codex` fixture.
Keyboard selection reached Codex Default and Advanced while provider, API-key,
and Databricks controls stayed absent. A held validation cancelled in place and
retained the editable name and configuration. The quota mode retained its draft
and displayed the synthetic quota category. The recovery mode matched a native-
style `wss://relay.example.test` journal to the form's
`https://relay.example.test` destination; after the reviewer re-entered Codex
Default and the original name, Resume produced one recovered card while the
original Fixture agent stayed unchanged. These are simulated UI outcomes, not
live account, relay, or credential-store acceptance.

## Evidence boundary

The machine's ordinary `/opt/homebrew/bin/codex` reports `0.151.0`. The ordinary
`/opt/homebrew/bin/codex-acp` is the Zed adapter and does not provide the required
version contract. Earlier controlled discovery used an isolated
`@agentclientprotocol/codex-acp` `1.10.0`; no tool was installed or replaced for
this PR. The Hermit checks used Node `v24.18.0` and Rust `1.98.1`.

No successful live Default or Advanced inference is claimed. CLI `0.151.0` with
the isolated adapter failed because the configured model required a newer CLI.
The desktop-bundled CLI `0.154.0-alpha.6.2` was also incompatible with adapter
`1.10.0`; the cause remains unresolved. Browser tests do not prove a real Codex
account, OS credential storage, signed relay authorization, actual child-process
restart, or a signed reply in a disposable channel.

## Human acceptance still required

Use disposable identities and a disposable channel. Do not change the user's
global Codex configuration for this check.

1. Record `command -v codex`, `codex --version`, the selected adapter path and
   its version, and the app build. Confirm native readiness reports the same
   binding and existing CLI sign-in.
2. Create one Default Codex agent. Confirm the quota/configured-tools disclosure,
   `Testing Codex connection…`, one saved Buzz identity, a signed reply in the
   intended channel, Stop, start, app reopen, and identity continuity.
3. Create one Advanced agent after refreshing models. Select a reported model
   and supported effort, then confirm the same lifecycle. Record requested
   values as requested settings only; do not claim they were observed at runtime.
4. Edit only the name and confirm no inference request. Then edit an execution
   setting, exercise one safe validation failure, correct it, Save, and confirm
   only the successful Save restarts a running agent.
5. Duplicate the Codex agent and confirm the mode/model/effort carry over while
   identity and write-only environment values do not.
6. If an interrupted Create journal is available, resume it with the original
   inputs and confirm the identity is reused. Also exercise explicit discard for
   a draft that cannot be reconstructed.
7. Confirm a runtime failure remains visible through existing Agent controls and
   that Stop/retry remains available. This PR does not add runtime observation or
   change fallback policy.

## Stack notes

The stack remains based on PR 4. Readiness command ACL registration currently
lives in PR 4 and must move to PR 2 before bottom-up merge; this PR does not
rewrite its parents. Main has since added Hermes Tier 2 fields in the shared
agent editors. Rebase integration should preserve native harness policy as the
single configuration authority and reconcile those shared form changes without
adding a second Codex defaults owner.
