# Codex observed session settings acceptance

This record covers PR 6 of the Codex harness stack. The implementation commit is
`83f5cc041f257d417be2d95b8d2a1cd138a89285` on
`codex/codex-observed-settings`, based on PR 5 commit
`79ef44a38dd3e5840117aee71b39342d3265473d`. Checks below were run on October 6,
2026. The feature remains draft pending live native acceptance and the human
confirmation workflow listed below.

## Product behavior

The Codex editor labels the persisted Default or Advanced choice as **Saved
requested settings**. It shows independently observed model and effort below
that block. Draft edits, discovery, validation, process status, saved settings,
and a successful setting request do not count as runtime observation.

Each retained row belongs to one exact worker, turn, channel scope, and start
time. It shows the reported session identity, setting-specific observation
times, and failed-turn time. A later turn that reuses a session ID gets a
separate row. Historical rows do not certify the current launch or saved
revision.

Actual values come only from the matching ACP `session/new` response,
setting-response payload, or supported `config_option_update` notification.
The runtime's `session_config_captured` semantic frame is excluded because the
pinned runtime can patch its effort from the requested value. Missing,
ambiguous, malformed, oversized, or control-character values remain **Not
reported**. A successful model change without independently reported values
clears the prior model and effort. Rejections retain a same-turn independently
reported value as an explicit reported fallback; the UI never infers fallback
from a mismatch with saved settings.

Turn failures remain visible even when session creation fails before a session
ID exists. The settings summary does not copy raw ACP errors, prompts, tool
activity, or other private output into labels.

Projection uses the existing bounded agent-activity records and no new cache,
poller, history cursor, or lifecycle owner. It keeps at most five projected
turns, fails closed if a candidate turn exceeds 64 relevant events or the input
exceeds 512 candidate groups, and inherits activity access, generation,
community, clear, and eviction boundaries. Grouping by turn, worker, channel and
start time prevents cross-turn correlation; historical records may persist
across a native process restart. Only an exact Codex agent record in the
connected community can mount the editor summary and acquire an activity lease.

## Transport and privacy boundary

This layer does not change native transport, runtime environment, pins, or
fallback policy. The existing app-managed RuntimeBundle already enables the
owner-encrypted relay observer for every agent. The shared observer carries
broader ACP activity, including prompts and tool activity. The settings UI
filters what it renders; that filtering does not reduce what the observer
publishes or what saved agent activity may retain.

The renderer receives the existing purpose-bound decoded observer DTOs. Native
and development hosts keep their current signature, recipient, freshness,
access, and bounded-storage checks. Turning the Agent Activity plugin display
off does not by itself disable archive capture; use **Settings → Agents → Saved
agent activity** for capture and clear controls.

## Automated evidence

The focused production projection and UI matrix passed:

```text
pnpm exec vitest run \
  src/features/agents/session-settings.test.ts \
  src/features/agents/activity.test.ts \
  src/features/agents/activity-records.test.ts \
  src/features/agents/activity-history.test.ts \
  src/bundled/agents/AgentSessionSettings.test.tsx \
  src/bundled/agents/AgentEditor.test.tsx \
  src/bundled/agents/AgentUpdateReview.component.test.tsx \
  src/bundled/agents/AgentUpdateReview.test.tsx \
  src/bundled/agents/AgentsPage.test.tsx \
  src/bundled/profiles/ProfileAgentRuntime.test.tsx \
  src/bundled/profiles/ProfileRuntime.test.tsx \
  src/bundled/profiles/ProfilePanel.test.tsx
  12 files, 196 tests passed

pnpm typecheck
  passed

pnpm exec biome check <13 affected TypeScript files>
git diff --check
  passed
```

The production projector cases cover applied Default and Advanced results;
missing evidence; rejected model and effort; explicit same-turn fallback;
failed session creation and failed prompts; ordered responses and
notifications; reused session IDs; typed RPC IDs; orphan responses; ambiguous
metadata; semantic-capture exclusion; collision and value sanitization; bounded
overflow; multiple sessions; access revocation; generation replacement;
history clear; and live-record eviction. A focused mounted integration proves
that the wrong-community editor neither renders nor activates observation, the
exact community activates once, and closing the editor releases once.

```text
pnpm exec playwright test --config tests/browser/playwright.config.mjs \
  tests/browser/agent-control.spec.mjs \
  --project chromium --project webkit --no-deps
  36 tests passed in 2.6 minutes
```

The first restricted browser attempt never entered a test body: macOS denied
Chromium's Mach rendezvous and WebKit aborted at launch. The same command above
passed with browser-launch permission.

## Simulated interactive evidence

The isolated fixture exposes three query-driven states:

- `agent-control.html?codex&observed=missing`
- `agent-control.html?codex&observed=reported`
- `agent-control.html?codex&observed=failed`

Open **Fixture agent → Actions → Edit**. These states use in-memory synthetic
observer frames and no real account, Keychain, agent process, or relay
publication. They demonstrate saved Advanced values remaining separate from an
unsaved Default draft, honest Not reported behavior, independent session/model/
effort with times, and rejected/fallback/failed presentation. They are UI
evidence only.

Independent CUA review confirmed that the missing state stayed **Not reported**
despite a simulated running PID; changing the unsaved draft from Advanced to
Default left saved `model-b` / `high` explicitly labeled; the reported state
showed `model-a` / `medium` with session, turn, worker and per-field time; and
the failed state showed unsupported `model-b`, reported fallback `model-a`, and
the failed-turn time. Escape closed the editor, and reopening showed a single
report from a fresh synthetic activation frame. The layout remained readable.
This was synthetic fixture evidence.

## Evidence boundary

The machine's ordinary `/opt/homebrew/bin/codex` reports `0.151.0`. The ordinary
`codex-acp` is `@zed-industries/codex-acp` `0.16.0` and does not satisfy this
stack's adapter version contract. The existing isolated
`@agentclientprotocol/codex-acp` `1.10.0` under
`/tmp/buzz-codex-adapter-acceptance` supports discovery but has not completed a
successful inference with the available CLI. The desktop CLI
`0.154.0-alpha.6.2` was also incompatible through that adapter for an unresolved
reason. No tool was installed or replaced, and global Codex configuration,
login, and Keychain were not changed for this PR.

No successful live Default or Advanced conversation is claimed. Automated and
fixture tests do not prove a real Codex account, owner-encrypted relay delivery,
packaged decoder parity, archive persistence across app restart, actual fallback,
or a signed reply in a disposable channel. No raw session log is stored in Git.

## Human acceptance still required

Use disposable identities and a disposable channel. Do not change the user's
global Codex configuration merely to complete this check.

1. Record the app build, selected Codex CLI and adapter paths and versions, and
   confirm native readiness reports that same binding and existing login.
2. Open a saved Default agent. Before a fresh conversation produces observer
   evidence, confirm observed model and effort say **Not reported**. Send a
   short ordinary conversation prompt and confirm the independently reported
   session, model, effort, and times.
3. Repeat with a saved Advanced agent. Confirm the saved requested model and
   effort remain separate from actual reported values.
4. Exercise one rejected selection or known runtime fallback. Confirm rejection
   is explicit and a fallback is named only when the same turn reported it.
   Exercise a failed turn and confirm no model or effort is invented.
5. Save a different configuration without starting a new conversation. Confirm
   older rows stay clearly historical and do not certify the new revision.
6. Quit and reopen the packaged app. Confirm retained observations remain
   historical, then clear saved activity and confirm the summary empties. Also
   confirm changing community or losing channel access cannot expose the prior
   community's observations.
7. Repeat the representative flow through the packaged/native decoder and
   record a signed reply. Preserve the existing full-access execution behavior;
   this acceptance must not alter fallback policy or global Codex settings.

## Stack notes

This branch remains based on PR 5 and does not merge or rebase its parents.
Readiness command ACL registration currently lives in PR 4 and must move to PR 2
before bottom-up merge. Main has since added Hermes Tier 2 fields in the shared
agent editors; eventual stack integration must preserve those fields and the
exact-community observation fence without adding another settings or activity
owner.
