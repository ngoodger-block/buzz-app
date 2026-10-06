# Codex persistence, execution, and connection validation

This is the implementation and acceptance plan for PR 4 of the
[Codex harness stack](https://github.com/block/buzz-app/blob/codex/codex-harness-plan/docs/codex-harness-plan.md).
It builds on [model and effort discovery](codex-model-discovery.md).
The native implementation is ready for draft review. Acceptance gaps are listed
below; this document does not claim a completed GUI or live agent workflow.

## Product contract

Native Codex agents persist an explicit integration identity and either Default
or Advanced configuration. Legacy records keep their existing interpretation.
Default delegates model and effort to Codex and does not inherit Buzz selectors.
Advanced stores an explicit model and either an explicit effort or confirmed
absence of an effort control. Missing effort metadata is not confirmation that
effort is unsupported.

Create validates the exact effective draft with one bounded inference request
before generating a Buzz identity. Execution-setting edits validate before save
and restart; this includes system-prompt changes. A name-only edit may skip
inference when execution settings are unchanged. A failed or cancelled test
leaves the saved and running agent unchanged.

Validation uses ordinary Codex capabilities. It passes no Buzz identity, relay,
or authorization credentials and supplies no Buzz MCP servers. User-configured
tools may remain available. This is a real request that can consume quota and
use configured tools, not an enforced tool-free or side-effect-free operation.
See the [compatibility decisions](codex-validation-prerequisites.md).

Runtime model and effort fallback remain as implemented by the pinned Buzz
engine. Successful Advanced validation must confirm its requested settings;
this does not introduce a new runtime fallback policy. Requested settings are
not evidence of settings observed in a later conversation.

## Implementation sequence

1. Persist typed Codex intent through the existing revision-checked store.
   Isolate Default from Buzz model, effort, and provider defaults. Bind launch to
   the selected adapter, CLI, interpreters, workspace, and permitted environment.
   Recheck complete readiness outside the controller lock and fence launch by
   the current saved revision and binding.
2. Extend the shared ACP transport for bounded inference and sanitized failure
   categories. Apply and confirm Advanced settings in the same session used for
   the test. Default sends no model or effort selection requests. Confirm
   session-matched inference completion and reject failure metadata even when
   the adapter reports an `end_turn` stop reason.
3. Add native admission for Create and execution-setting Edit. A single-use
   proof binds the request, normalized effective draft, destination and owner,
   resolved context, and saved revision where applicable. Generic prepare,
   commit, and save paths must not bypass admission. Replacement, cancellation,
   changed inputs, and consumption invalidate the proof.
4. Recover interrupted creation through the existing atomic store and secure
   credential boundary. Journal public pending-creation metadata before key
   persistence. Insert the final agent and clear its pending record atomically.
   Retry after a durable key write must reuse that identity. If the process died
   before the key became durable, report an incomplete operation and provide an
   explicit recovery/discard path; do not silently substitute a new identity for
   the same request.

Use the existing store, revision checks, authorization, process containment,
readiness owner, and ACP transport. Keep Codex controls and complete form wiring
in PR 5. This layer does not change runtime pins, global Codex configuration,
credential providers, or the accepted runtime fallback policy. Windows support
must not be implied by the initial Unix implementation.

## Review checkpoints

Review the first working persistence/launch slice before adding validation and
recovery. Review necessity as well as correctness, and revise the production
diff estimate before materially expanding it. One source implementation owner
works with an independent parent reviewer.

The first working slice used 712 net production lines. The original 750–950-line
estimate for the whole PR was insufficient for the required lifecycle handling.
The revised estimate is 1,500–1,800 net production lines, plus tests and docs,
for the same planned behavior. The recovery record stays inside the existing
atomic store to avoid introducing another persistence owner.

The first review identified these requirements for the launch slice:

- Native adapter arguments must match validation. Custom arguments are refused;
  native-owned script arguments must survive the pinned runtime's comma splitting
  and whitespace trimming unchanged.
- Execute the bound adapter interpreter while preserving the selected CLI's
  interpreter resolution and availability of Buzz's bundled tools.
- Readiness includes ACP initialization, not only version and login checks.
- Dropping a Start request clears its waiting state but retains ownership until
  native process cleanup settles. A replacement cannot overtake that cleanup.
- Worker retirement must not depend on an async waiter surviving. Cancellation
  between claim and worker start must also retire its reservation.
- Shutdown attempts every owned cleanup and existing listener shutdown before
  returning any failure.
- A saved native record cannot escape validation by dropping its integration
  marker. Native defaults must use integration identity, not executable basename.

## Required acceptance evidence

Automated checks must cover persistence/reopen, legacy compatibility, Default
isolation, exact launch binding, full access, and affected existing harnesses.
Validation tests must bind production paths for settings rejection, quota,
authentication, context limits, timeout, output bounds, cancellation, stale
results, and process cleanup. Use explicit gates for ordering assertions.

Create tests must demonstrate zero identity/record writes after failed
validation; single-use admission; duplicate and changed-input rejection; and
fresh-host recovery across credential/record write boundaries. Edit tests must
show an unchanged saved/running revision after failure and acceptance only of
the checked revision after success.

Until PR 5 exposes the forms, use a native integration driver for Default and
Advanced Create/Edit. Exercise the real adapter and CLI, verify a signed reply
in the intended disposable channel, and verify Stop/start and reopen preserve
identity. Report synthetic credential custody, simulated relay behavior, and
driver-assisted coverage explicitly; these are not GUI or OS credential-store
acceptance. Keep the PR draft pending human workflow acceptance.

The final evidence record must name the checked commit, CLI/adapter and pinned
runtime versions, commands and results, live workflow exercised, simulated
failures, and remaining platform or packaging gaps. Do not include credentials
or raw private session data.

## Working-slice evidence

On October 6, 2026, the first persistence/launch slice on
`codex/codex-validation-execution`, based on `96f669a7`, passed independent code
review after the corrections listed above. This was an uncommitted working-tree
checkpoint, not acceptance of the complete PR.

The implementation agent reported:

- `cargo test -p buzz-agent-controller`: 160 unit tests passed, 2 opt-in tests
  ignored, and 16 integration tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml codex -- --nocapture`:
  25 passed and 2 installed-tool tests intentionally ignored.
- Full Tauri test compilation with `--no-run`, `pnpm typecheck`, changed-file
  Biome checks, and `git diff --check` passed.

Process tests required native process inspection. A restricted run failed when
the sandbox denied `/bin/ps`; the same complete controller suite passed with
that inspection permitted. The Start cancellation regression exercises the
production orchestration with an explicit worker-retirement gate.

Inference validation, proof admission, durable Create recovery, real inference,
and end-to-end native acceptance remain outstanding at this checkpoint.

The next review corrected proof lifetime: only one proof can be issued, it is
bound to its validation generation, and replacement or cancellation invalidates
it. Dropping a validation caller cancels its operation while the native worker
retains process-cleanup ownership. The review also found missing Tauri
permissions for the earlier readiness commands; this layer adds those permissions
alongside validation commands. Verification through the actual invoke boundary
is required before acceptance.

Independent frontend verification of the in-progress second slice passed:
`pnpm exec vitest run src/features/agents/control.test.ts
src/features/agents/control-native.test.ts` — 89 tests in two files. This does
not establish native inference or recovery acceptance.

The first live Default validation used Codex CLI `0.151.0` and the isolated
`@agentclientprotocol/codex-acp` `1.10.0` installation. The account's configured
`gpt-6-astra` model required a newer CLI. The adapter returned `end_turn` with
null usage and terminal service-failure metadata; validation correctly refused
to issue a success proof. This is failure-path evidence, not a successful
connection test. The already-installed desktop-bundled CLI
`0.154.0-alpha.6.2` is available for subsequent explicit-binding acceptance;
neither installation nor global configuration was changed.

## Draft publication evidence

The completed native implementation passed these checks before draft publication:

- Controller: 162 unit tests passed, 2 opt-in tests ignored, and both integration
  suites passed (5 and 11 tests).
- Native validation: 4 focused tests passed. Recovery, actual command permissions,
  dropped-Start retirement, fresh-store reopen, and atomic completion tests passed.
- Controller and Tauri Clippy passed with warnings denied; Tauri test compilation
  and `git diff --check` passed.
- Independent frontend agent-control tests: 89 passed across two files.
- The full Tauri library run had 279 passing tests, 10 ignored tests, and three
  failures in existing host-command timing/output and HEIC decoding fixtures.
  The full local suite is therefore not reported as green.

The opt-in live test accepts `BUZZ_TEST_CODEX_ADAPTER` and `BUZZ_TEST_CODEX_CLI`
paths. The desktop-bundled CLI `0.154.0-alpha.6.2` also returned an incompatible
result through adapter `1.10.0`; its cause remains unresolved. Successful live
Default and Advanced inference, the signed disposable-channel reply, full
Create/Edit/Stop/reopen acceptance, GUI forms, and OS credential-store acceptance
remain unverified. Keep this PR draft until the applicable acceptance is complete.

The durable Codex recovery record contains public identity fields and a hash
commitment, not keys, authorization payloads, or plaintext execution settings.
Resume requires the original execution inputs, fresh valid owner authorization,
and the exact durable key. The signature bytes are not part of the commitment:
signing again after relaunch uses new randomness but authorizes the same identity.
Missing keys require explicit discard and a new validated request. Unknown
credential cleanup outcomes retain the journal for retry. Journals from the
earlier draft that committed the signature bytes require explicit discard.

## PR 4 review corrections

The recovery journal is limited to Codex until PR 5 exposes its recovery controls.
Existing Buzz Agent, Goose, and Pi forms retain their prepared identity after a
credential refusal and can retry through the existing Create flow. Codex remains
disabled in those forms; its native recovery commands allow reauthorization of
the journaled identity after relaunch. The driver must resubmit the original
execution inputs; they are intentionally not exposed by the public recovery view.

Every completed native Create now stores a public request receipt atomically with
the agent. A retry after a lost response or post-save snapshot failure returns that
identity, without another authorization or credential write. Receipts live for
the lifetime of the saved agent and are not projected in the ordinary inventory.
Changed request inputs are rejected. Codex commit and recovery also copy the
configured launch-protection defaults through the same owner used by other new
agents, preserving explicit bindings.

Regression coverage invokes the real native commands with synthetic credentials
and a controlled Codex ACP process. It covers credential denial for the three
existing harnesses; successful persistence followed by a failed response and
fresh-host retry; failed/cancelled inference admission; mismatched and consumed
proofs; interruption after key persistence; fresh randomized owner authorization;
forged authorization; and failed/stale/successful Edit admission. The test destroys
the old native host, retains only the synthetic secure-storage boundary, and
reconstructs the public input for recovery. This is native protocol and persistence
evidence, not OS Keychain or live service acceptance.

The Edit fixture uses a stopped agent; preserving a running agent on failed Edit
and restarting it after successful Edit still require lifecycle acceptance.

Review-fix validation:

- All three new native regression tests fail against the original implementation
  and pass with these fixes. The protection-default regression also fails before
  the fix and passes afterward.
- Controller: 162 unit tests and 16 integration tests passed; 2 opt-in tests ignored.
- Tauri library: 286 passed, 10 ignored, and the previously documented local
  `converts_tiled_heic_without_cropping` fixture failed (512×512 instead of
  1536×1024). The full local native suite is not green.
- Focused agent-control and reading-position tests: 111 passed across 3 files.
- Inbox browser suite: all 16 cases passed across Chromium and WebKit in 35 seconds.
- Hosted Linux confirmation remains pending publication of the fixes.

The Linux Goose fixture now creates its executable using the existing Pi fixture's
single-threaded copy pattern, avoiding inherited write handles during parallel
forks. Test-only diagnostics retain the underlying spawn error. The Inbox browser
test waits for the existing positioning event's exact-reveal completion reason
before moving keyboard focus to Retry. No browser cases were added or removed;
the existing case still tests native focus and layout in Chromium and WebKit.

Readiness permissions remain in PR 4 in this update. Before merging the stack
bottom-up, move their registration, capability entries, and invoke-boundary test
into PR 2. This PR does not rewrite its parent branches. Successful real Default
and Advanced inference, signed channel reply, live lifecycle acceptance, and
human confirmation remain required before enablement.
