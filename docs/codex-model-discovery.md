# Codex model and effort discovery

Codex remains unavailable for agent creation. This layer adds headless model and
effort discovery for the exact native Codex binding established by
[Codex binding readiness](codex-binding-readiness.md). It does not persist a
selection, create an identity, send a prompt, or establish successful inference.

## Request and context contract

The frontend model request carries the stable native integration ID. Only
`codex` selects this path; an editable command named `codex` or `codex-acp` is
not authority. Native code resolves the effective draft or revision-fenced saved
agent, including its workspace and permitted Codex environment, then uses one
`CodexContext` for CLI probes, ACP initialize, session creation, selection, and
cleanup. Environment defaults owned by Goose, Databricks, or another harness are
excluded instead of entering the Codex process.

After discovery, native code resolves the saved/draft context again before it
returns a catalog. A changed revision, workspace, tool path, or effective
environment rejects the old result. Frontend generation fencing covers replaced
draft requests. Equal context values do not prove that login or configuration
file contents stayed unchanged; a later request must repeat readiness.

The existing model-request host owns the operation until the contained adapter
process and its descendants retire. Cancellation flips the worker's current
token, and shutdown waits only for the owned Codex process cleanup. A dropped IPC
future cannot release admission early. Cleanup failure is sticky: shutdown fails
and later discovery is refused because process retirement was not confirmed.
Existing Databricks, Goose, and Pi behavior is unchanged.

This implementation is enabled on Unix builds. Other platforms return the
existing unsupported result and keep Codex creation disabled.

## ACP projection

Discovery uses the same bounded ACP transport as readiness:

1. Verify the exact CLI version, login status, adapter package identity, and
   adapter version.
2. Initialize ACP protocol version 1 with the exact reported adapter identity.
3. Create one session in the resolved workspace with no prompt.
4. Read the `model` select option from `configOptions`.
5. If the request includes another listed model, send
   `session/set_config_option`, require the response to report that exact model,
   and only then project its effort option.
6. Close the session and retire the entire adapter process tree.

The response distinguishes three outcomes. A present model option with no values
is a known-empty catalog. Absent model metadata is explicit unknown metadata.
Malformed, contradictory, rejected, or stale metadata is an error. Missing
`reasoning_effort` metadata is unknown capability and is never reported as lack
of effort support.

The initial `currentValue` fields are reported as the resolved session model and
effort. After a model switch, the effort `currentValue` is only the observed
selection for that session. The adapter may retain a previously supported effort
or choose the selected model's default, so Buzz does not label that value as a
per-model default.

Model and effort options must be flat selects with unique, nonempty IDs and safe
names. Discovery accepts at most 100 configuration options, 1,000 models, and 20
effort values. IDs are limited to 512 bytes and names to 1,024 bytes; control
characters and grouped options are rejected.

## Resource bounds and protocol failures

The discovery transport has one 15-second deadline across initialize, session
creation, optional selection, and close. It accepts at most 1 MiB across stdout
and stderr, 2,000 newline-delimited messages, and 16 KiB per request. The stdin
writer is owned separately so a blocked adapter read cannot outlive the same
deadline and process retirement. Read errors, write errors, output overflow,
unexpected response IDs, adapter errors, and unsolicited client requests fail
the operation. Buzz never grants a client tool request and never sends raw
adapter output or error text to the frontend.

ACP `session/new` can create CLI-owned session or cache metadata. The tested
adapter closes by unsubscribing from the thread; this layer does not claim that
the CLI session is filesystem-ephemeral. No Buzz identity, relay credential,
authorization, saved agent setting, prompt, or inference request is created.
An empty ACP MCP list also does not disable MCP servers configured by the user.

## Compatibility evidence

Source review used
[`@agentclientprotocol/codex-acp` 1.10.0](https://github.com/agentclientprotocol/codex-acp/blob/v1.10.0/src/CodexAcpClient.ts),
including its model and reasoning configuration options, external `CODEX_PATH`
launch, model-change response, and session close. Adapter 2.1.1 was inspected for
the later validation limitation; this change does not claim that untested pair is
supported.

The production native discovery seam was exercised on macOS with the isolated
adapter 1.10.0 and `/opt/homebrew/bin/codex` 0.151.0. It returned a nonempty known
catalog and an initial selection. One catalog model was selected, the exact model
round trip was confirmed, and nonempty reported effort choices were observed.
A headless refresh and pre-cancel refusal also completed through the production
seam. Controlled worker tests cover cancellation after work has started.
No model IDs, session IDs, private configuration, or catalog contents were
recorded. No prompt or authentication flow ran.

Controlled tests cover exact initialization, catalog and initial-selection
projection, one selected model's effort, known-empty and unknown catalogs,
missing effort metadata, duplicate/grouped/malformed/oversized data, rejected
selection, timeout, cancellation, cumulative output overflow, unexpected client
requests, adapter and descendant retirement, dropped IPC, current-thread
shutdown, sticky cleanup failure, and changed-context fencing. The live test is
ignored by default and names explicit local tool paths.

The controlled suite and live check were run from a macOS development checkout;
the controlled tests are also intended for Linux CI. Windows, packaged-app
discovery, and a visible GUI flow have not been exercised. Codex creation and
persistence remain disabled.

The next layer can proceed under the revised
[Codex validation compatibility decisions](codex-validation-prerequisites.md).
Validation uses ordinary Codex capabilities and preserves existing runtime
fallback behavior. PR 4 still requires real inference and lifecycle acceptance;
this discovery layer does not establish either.
