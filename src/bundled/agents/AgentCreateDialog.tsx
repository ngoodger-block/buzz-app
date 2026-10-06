import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  agentFailureReason,
  agentSafeFailure,
  type AgentControl,
  type AgentControlState,
  type CodexCreateRecovery,
  type CloneSettings,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentSettingsFields } from "./AgentSettingsFields";
import { relayOrigin } from "../../features/communities/destination";
import {
  agentDraft,
  agentEdit,
  harnessKind,
  type AgentDraft,
} from "./agent-edit";

/** The Agent defaults harness is copied at creation; the rest is inherited at start. */
function newAgentDraft(state: AgentControlState): AgentDraft {
  const defaults = state.data?.defaultSettings;
  const chosen = state.data?.harnessOptions?.find(
    (option) =>
      option.available !== false &&
      harnessKind(option.command) === (defaults?.harness ?? "buzz-agent"),
  );
  const command = chosen?.command ?? "buzz-agent";
  const inherits = defaults?.harness === "buzz-agent" && !!defaults.provider;
  return {
    revision: 0,
    name: "",
    systemPrompt: "",
    sessionPolicy: null,
    workspace: state.data?.defaultWorkspace ?? "",
    command,
    args: JSON.stringify(chosen?.defaultArgs ?? []),
    model: "",
    provider:
      command !== "buzz-agent" ||
      inherits ||
      state.data?.agentDefaults?.provider
        ? ""
        : (chosen?.providers[0]?.value ?? "databricks_v2"),
    environment: {},
  };
}

type CreatePhase =
  | "testing"
  | "recovering"
  | "discarding"
  | "creating"
  | "starting"
  | "publishing"
  | "checking";

export function AgentCreateDialog({
  control,
  state,
  destination,
  owner,
  source,
  initialSettings,
  onClose,
  onOpenHarnesses,
}: {
  control: AgentControl;
  onOpenHarnesses?: (() => void) | undefined;
  state: AgentControlState;
  destination: string;
  owner: string;
  source?: AgentView;
  initialSettings?: CloneSettings | undefined;
  onClose(): void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<AgentDraft>(() => {
    const initial = source
      ? {
          ...agentDraft(source),
          name: `${source.name} copy`,
        }
      : {
          ...newAgentDraft(state),
          name: initialSettings?.name ?? "",
          systemPrompt: initialSettings?.systemPrompt ?? "",
        };
    return { ...initial, environment: { BUZZ_ACP_AGENTS: "10" } };
  });
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<AgentView | null>(null);
  const [nextStep, setNextStep] = useState<"start" | "profile">("start");
  const [error, setError] = useState<string>();
  const [phase, setPhase] = useState<CreatePhase | null>(null);
  const [recovery, setRecovery] = useState<CodexCreateRecovery | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(
    !!control.createRecovery,
  );
  const active = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void control
      .createRecovery?.()
      .then((pending) => {
        if (mounted.current) setRecovery(pending);
      })
      .catch((problem) => {
        if (mounted.current)
          setError(
            problem instanceof Error
              ? problem.message
              : "Couldn’t check pending agent creation.",
          );
      })
      .finally(() => {
        if (mounted.current) setRecoveryLoading(false);
      });
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, [control]);
  let resumable = false;
  if (recovery?.owner === owner) {
    try {
      resumable =
        relayOrigin(recovery.destination) === relayOrigin(destination);
    } catch {
      // Native recovery stays visible and discardable when either target is invalid.
    }
  }
  const available = !!(
    destination &&
    owner &&
    state.data?.createAvailable &&
    control.create
  );
  const runtimeBlocked =
    !state.data?.runtimeAvailable && (!saved || nextStep === "start");
  const busy = phase !== null;
  const blocked =
    busy || recoveryLoading || state.busy || state.status !== "ready";
  const create = async () => {
    if (
      submitting.current ||
      blocked ||
      runtimeBlocked ||
      (!saved &&
        (recovery
          ? !resumable || !control.resumeCreate
          : !available || !control.create))
    )
      return;
    submitting.current = true;
    const request = new AbortController();
    active.current = request;
    setError(undefined);
    let step: "creating" | "starting" | "publishing" = "creating";
    let agent = saved;
    let startFailure: string | null = null;
    try {
      if (!agent) {
        let edit: ReturnType<typeof agentEdit>;
        try {
          edit = agentEdit(draft);
        } catch (problem) {
          if (mounted.current)
            setError(
              problem instanceof Error
                ? problem.message
                : "Check the agent settings and try again.",
            );
          return;
        }
        if (recovery && resumable && control.resumeCreate) {
          setPhase("recovering");
          agent = await control.resumeCreate(recovery, edit, request.signal);
        } else {
          setPhase(
            edit.harness.integration === "codex" ? "testing" : "creating",
          );
          if (!control.create) return;
          agent = await control.create(
            requestId,
            destination,
            owner,
            edit,
            request.signal,
            () => {
              if (mounted.current) setPhase("creating");
            },
          );
        }
        if (mounted.current) setRecovery(null);
      }
      const created = agent;
      if (!saved && mounted.current) {
        setDraft((current) => ({ ...current, environment: {} }));
        setSaved(agent);
      }

      if (!saved || nextStep === "start") {
        const current = control
          .snapshot()
          .data?.agents.find((item) => item.id === created.id);
        if (current?.status !== "running") {
          step = "starting";
          if (mounted.current) setPhase(step);
          const result = await control.action(created.id, "start");
          const started = result.agents.find((item) => item.id === created.id);
          if (started?.status !== "running") {
            startFailure = `${created.name} was created, but couldn't start. ${started?.error ?? "Check its settings, then try Start again."}`;
          }
        }
        if (!startFailure && mounted.current) setNextStep("profile");
      }

      const current = control
        .snapshot()
        .data?.agents.find((item) => item.id === created.id);
      if (current?.profilePending !== false) {
        step = "publishing";
        if (mounted.current) setPhase(step);
        if (!control.publishProfile)
          throw new Error(
            "Profile setup is unavailable. Rebuild the desktop app.",
          );
        await control.publishProfile(created.id);
      }
      if (mounted.current) {
        if (startFailure) setError(startFailure);
        else onClose();
      }
    } catch (problem) {
      if (mounted.current) setPhase("checking");
      await control.refresh();
      if (!mounted.current) return;
      const safe = agentSafeFailure(problem);
      if (safe) {
        setError(safe);
        return;
      }
      const detail = agentFailureReason(problem);
      const reason = detail && ` ${detail}`;
      const refreshed = control.snapshot();
      const created = agent;
      const current = created
        ? refreshed.data?.agents.find((item) => item.id === created.id)
        : undefined;
      if (step === "starting" && current?.status === "running") {
        setNextStep("profile");
        setError(undefined);
      } else if (step === "publishing" && current?.profilePending === false) {
        if (startFailure) setError(startFailure);
        else onClose();
      } else if (step === "creating") {
        setError(
          `We couldn't confirm whether the agent was created.${reason} Check the agent list before trying again.`,
        );
      } else if (refreshed.status === "ready" && current) {
        setError(
          step === "starting"
            ? `${agent?.name ?? draft.name} was saved, but couldn't start.${reason} Check its card, then select Start agent to try again.`
            : startFailure
              ? `${startFailure} Profile setup also didn't finish.${reason}`
              : `${agent?.name ?? draft.name} was saved and started, but profile setup didn't finish.${reason} Select Finish profile to try again.`,
        );
      } else {
        setError(
          step === "starting"
            ? `${agent?.name ?? draft.name} was saved, but we couldn't confirm whether it started. Refresh status before trying again.`
            : `${agent?.name ?? draft.name} was saved, but we couldn't confirm its profile setup. Refresh status before trying again.`,
        );
      }
    } finally {
      if (active.current === request) active.current = null;
      submitting.current = false;
      if (mounted.current) {
        setPhase(null);
        if (!agent && control.createRecovery)
          void control
            .createRecovery()
            .then((pending) => {
              if (mounted.current) setRecovery(pending);
            })
            .catch(() => {});
      }
    }
  };
  const close = () => {
    active.current?.abort();
    onClose();
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !dirty && !blocked) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-buzz-ui="" className="buzz-dialog-backdrop" />
        <Dialog.Popup
          aria-modal="true"
          data-buzz-ui=""
          className="buzz-dialog agent-dialog text-body"
        >
          <header className="buzz-dialog-header">
            <Dialog.Title className="text-heading">
              {source
                ? `Duplicate ${source.name}`
                : initialSettings
                  ? "Clone agent"
                  : "Create agent"}
            </Dialog.Title>
          </header>
          <Dialog.Description className="buzz-dialog-description">
            Create and start an agent in{" "}
            {destination || "a connected community"}. It won't join a channel
            automatically.
          </Dialog.Description>
          {initialSettings && (
            <p className="text-body-sm text-secondary">
              Only the name and instructions were copied. Review them for
              embedded secrets. Choose this computer’s workspace and runtime
              settings. Identity keys, environment values, history and community
              membership are not copied. The source stays unchanged.
            </p>
          )}
          <form
            className="buzz-dialog-body space-y-section-gap"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <AgentSettingsFields
              draft={draft}
              control={control}
              state={state}
              disabled={blocked || !!saved}
              onOpenHarnesses={onOpenHarnesses}
              discardEdits={dirty}
              onChange={(patch) => {
                setDraft({ ...draft, ...patch });
                setDirty(true);
                setError(undefined);
              }}
            />
            {source?.harness.environmentKeys.length ? (
              <p role="status" className="text-body-sm text-secondary">
                Re-enter environment values for{" "}
                {source.harness.environmentKeys.join(", ")}. Saved values cannot
                be copied into a new identity.
              </p>
            ) : null}
            {!available && (
              <p role="status">
                Connect to a community and use a rebuilt desktop app to create
                an agent.
              </p>
            )}
            {recovery && (
              <div className="space-y-2">
                <p role="status" className="text-body-sm text-secondary">
                  {resumable
                    ? "A previous agent creation is ready to resume. Re-enter its original settings, or discard it and start again."
                    : "A previous agent creation for another community or owner must be discarded before starting this one."}
                </p>
                <Button
                  type="button"
                  disabled={blocked}
                  onClick={() => {
                    if (!control.discardCreate || blocked) return;
                    setPhase("discarding");
                    setError(undefined);
                    void control
                      .discardCreate(recovery.requestId)
                      .then(() => {
                        if (mounted.current) setRecovery(null);
                      })
                      .catch((problem) => {
                        if (mounted.current)
                          setError(
                            problem instanceof Error
                              ? problem.message
                              : "Couldn’t discard the pending creation.",
                          );
                      })
                      .finally(() => {
                        if (mounted.current) setPhase(null);
                      });
                  }}
                >
                  Discard pending creation
                </Button>
              </div>
            )}
            {runtimeBlocked && (
              <p role="alert">
                This app’s agent runtime is unavailable. Repair or rebuild the
                desktop app before {saved ? "starting" : "creating"} an agent.
                {state.data?.runtimeMessage && ` ${state.data.runtimeMessage}`}
              </p>
            )}
            {busy && (
              <p role="status">
                {phase === "testing" && "Testing Codex connection…"}
                {phase === "recovering" && "Resuming agent creation…"}
                {phase === "discarding" && "Discarding pending creation…"}
                {phase === "creating" && "Creating agent…"}
                {phase === "starting" &&
                  `${saved?.name ?? draft.name} was created. Starting it…`}
                {phase === "publishing" &&
                  `${saved?.name ?? draft.name} was saved. Finishing its profile…`}
                {phase === "checking" && "Checking agent status…"}
              </p>
            )}
            {saved && !busy && !error && (
              <p role="status">
                {nextStep === "start"
                  ? `${saved.name} was saved. Start it to finish setup.`
                  : `${saved.name} was saved and started. Finish its profile setup.`}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            {state.status === "error" && !busy && (
              <Button onClick={() => void control.refresh()}>
                Retry status
              </Button>
            )}
            <div className="buzz-dialog-actions">
              <Button
                type="button"
                onClick={() => {
                  if (
                    active.current &&
                    !saved &&
                    draft.integration === "codex" &&
                    phase === "testing"
                  )
                    active.current.abort();
                  else close();
                }}
              >
                {active.current &&
                !saved &&
                draft.integration === "codex" &&
                phase === "testing"
                  ? "Cancel validation"
                  : busy || saved
                    ? "Close"
                    : "Cancel"}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  blocked ||
                  runtimeBlocked ||
                  (!saved &&
                    (recovery
                      ? !resumable || !control.resumeCreate
                      : !available))
                }
              >
                {busy
                  ? phase === "testing"
                    ? "Testing…"
                    : phase === "recovering"
                      ? "Resuming…"
                      : phase === "discarding"
                        ? "Discarding…"
                        : phase === "starting"
                          ? "Starting…"
                          : phase === "publishing"
                            ? "Finishing…"
                            : phase === "checking"
                              ? "Checking…"
                              : "Creating…"
                  : saved
                    ? nextStep === "start"
                      ? "Start agent"
                      : "Finish profile"
                    : initialSettings
                      ? "Clone agent"
                      : "Create agent"}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
