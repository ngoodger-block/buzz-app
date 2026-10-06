import { npubEncode } from "nostr-tools/nip19";
import { AvatarEditor } from "../../features/profiles/AvatarEditor";
import { useAvatarPreview } from "../../features/profiles/use-avatar-preview";
import { avatarPictureError } from "../../features/profiles/avatar-upload";
import { XIcon } from "../../shared/design-system/icons";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  canStopAgent,
  agentLaunchBlock,
  savedMessage,
  type AgentControl,
  type AgentControlState,
  type AgentView,
} from "../../features/agents/control";
import { Button } from "../../shared/design-system/ui/Button";
import { AgentSettingsFields } from "./AgentSettingsFields";
import {
  agentDraft,
  agentEdit,
  agentProcessLabel,
  type AgentDraft,
} from "./agent-edit";

export function AgentEditor({
  agent,
  displayName = agent.name,
  control,
  state,
  avatar,
  onClose,
  onOpenHarnesses,
  initialDraft,
  notice: initialNotice,
  disabled = false,
  children,
  details,
}: {
  agent: AgentView;
  onOpenHarnesses?: (() => void) | undefined;
  displayName?: string;
  control: AgentControl;
  state: AgentControlState;
  avatar?: string | undefined;
  onClose(): void;
  initialDraft?: AgentDraft;
  notice?: string;
  disabled?: boolean;
  children?: ReactNode;
  details?: ReactNode;
}) {
  const notify = useToastNotification();
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const saveRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      saveRequest.current?.abort();
    };
  }, []);
  const [draft, setDraft] = useState<AgentDraft | null>(initialDraft ?? null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const current = draft ?? agentDraft(agent);
  const dirty = draft !== null;
  const stale = current.revision !== agent.revision;
  const blocked =
    disabled || saving || state.busy || uploading || state.status !== "ready";
  const picture = current.picture ?? agent.picture ?? avatar ?? "";
  const preview = useAvatarPreview(
    state.data?.avatarEditingAvailable ? "" : picture,
    agent.relayUrl,
  );
  const canClose =
    saving ||
    !state.busy ||
    !!(state.pendingLaunch || state.pendingCredentialWrite);
  const launchBlocked = disabled || !!agentLaunchBlock(state, agent) || dirty;
  const unapplied =
    agent.runningRevision !== null && agent.runningRevision !== agent.revision;
  const change = (patch: Partial<AgentDraft>) => {
    setDraft({ ...current, ...patch });
    setNotice(null);
    setError(null);
  };
  const act = (action: "start" | "stop" | "restart") => {
    if (disabled) return;
    setNotice(null);
    void control.action(agent.id, action).catch(() => {});
  };
  const discard = () => {
    setDraft(null);
    setError(null);
    setNotice(null);
  };
  const close = () => {
    saveRequest.current?.abort();
    onClose();
  };
  const cancelValidation = () => saveRequest.current?.abort();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !dirty && !uploading && canClose) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-buzz-ui="" className="buzz-dialog-backdrop" />
        <Dialog.Popup
          aria-modal="true"
          data-buzz-ui=""
          className="buzz-dialog agent-dialog agent-editor text-body"
        >
          <header className="buzz-dialog-header">
            <Dialog.Title className="text-heading">Edit agent</Dialog.Title>
            <IconButton
              size="compact"
              icon={<XIcon size={16} aria-hidden="true" />}
              aria-label="Close editor"
              disabled={!canClose}
              onClick={close}
            />
          </header>
          <Dialog.Description className="sr-only">
            Edit {displayName}. Save restarts the agent if it is running and its
            effective settings changed.
          </Dialog.Description>
          <form
            className="buzz-dialog-body space-y-section-gap"
            onSubmit={(event) => {
              event.preventDefault();
              if (blocked || !dirty || stale) return;
              const pictureError = avatarPictureError(current.picture ?? "");
              if (pictureError) {
                setError(pictureError);
                return;
              }
              let edit: ReturnType<typeof agentEdit>;
              try {
                edit = agentEdit(current);
              } catch (problem) {
                setError((problem as Error).message);
                return;
              }
              if (saveRequest.current) return;
              const request = new AbortController();
              saveRequest.current = request;
              setSaving(true);
              setValidating(current.integration === "codex");
              void control
                .save(agent.id, current.revision, edit, request.signal, () => {
                  if (mounted.current) setValidating(false);
                })
                .then(async (saved) => {
                  if (!mounted.current) return;
                  setDraft(null);
                  setError(null);
                  const pending = saved.agents.find(
                    (item) => item.id === agent.id,
                  )?.profilePending;
                  if (pending && control.publishProfile) {
                    setNotice("Settings saved. Publishing avatar…");
                    try {
                      await control.publishProfile(agent.id);
                    } catch {
                      if (mounted.current)
                        setNotice(
                          "Settings saved; profile publication is unconfirmed. Refresh status, then retry publication below or on the agent card.",
                        );
                      return;
                    }
                  }
                  if (!mounted.current) return;
                  const message = savedMessage(
                    saved.restarted,
                    saved.restartFailures,
                  );
                  if (saved.restartFailures) {
                    setNotice(message);
                    return;
                  }
                  notify(message, "success");
                  onClose();
                })
                .catch((problem: Error) => {
                  if (mounted.current) setError(problem.message);
                })
                .finally(() => {
                  if (saveRequest.current === request)
                    saveRequest.current = null;
                  if (mounted.current) {
                    setSaving(false);
                    setValidating(false);
                  }
                });
            }}
          >
            {children}
            <div className="min-w-0 space-y-4">
              <div className="space-y-3 text-center">
                {state.data?.avatarEditingAvailable ? (
                  <AvatarEditor
                    value={picture}
                    name={current.name}
                    community={agent.relayUrl}
                    shape="squircle"
                    disabled={disabled || state.busy}
                    onBusyChange={setUploading}
                    onChange={(picture) => change({ picture })}
                  />
                ) : (
                  <Avatar
                    src={preview}
                    alt=""
                    fallback={displayName}
                    size="large"
                    shape="squircle"
                  />
                )}
                <p className="text-label">{displayName}</p>
                <p className="text-body-sm text-subtle break-all">
                  {agent.relayUrl}
                </p>
              </div>
              <AgentSettingsFields
                id={agent.id}
                savedRevision={agent.revision}
                draft={current}
                control={control}
                state={state}
                disabled={disabled || state.busy}
                environmentKeys={agent.harness.environmentKeys}
                onChange={change}
                onOpenHarnesses={onOpenHarnesses}
                discardEdits={dirty}
              />
              {details}
              <div className="-mx-2">
                <Accordion
                  variant="form"
                  items={[
                    {
                      value: "runtime",
                      title: "Runtime",
                      content: (
                        <div className="space-y-4">
                          <div className="space-y-1">
                            <p className="text-body-sm">
                              {state.status === "error" && "Last known: "}
                              {agentProcessLabel(agent)}
                            </p>
                            <p className="text-body-sm text-subtle">
                              {agent.configured === false
                                ? "Imported · close the editor and choose Use here before starting"
                                : agent.enabled
                                  ? !state.data?.runtimeAvailable
                                    ? "Enabled intent saved · execution unavailable"
                                    : agent.startOnAppLaunch
                                      ? "Enabled · starts with buzz-app"
                                      : "Enabled · manual-start only"
                                  : agent.startOnAppLaunch
                                    ? "Start on launch enabled"
                                    : "Manual start · a later sent mention can start this agent"}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {(agent.status === "stopped" ||
                              agent.status === "failed") && (
                              <Button
                                disabled={launchBlocked}
                                onClick={() => act("start")}
                              >
                                {agent.status === "failed"
                                  ? "Retry start"
                                  : "Start"}
                              </Button>
                            )}
                            <Button
                              disabled={
                                disabled || !canStopAgent(state, agent.id)
                              }
                              onClick={() => act("stop")}
                            >
                              Stop
                            </Button>
                            <Button
                              disabled={launchBlocked}
                              onClick={() => act("restart")}
                            >
                              {unapplied ? "Restart to apply" : "Restart"}
                            </Button>
                          </div>
                          <p className="text-body-sm text-subtle">
                            Saved revision {agent.revision} · Running revision{" "}
                            {agent.runningRevision ?? "none"}.
                            {unapplied && " Saved changes are not running yet."}{" "}
                            Stop ends current work. After setup, a later sent
                            mention can start it again.
                          </p>
                        </div>
                      ),
                    },
                    {
                      value: "technical",
                      title: "Technical details",
                      content: (
                        <div className="space-y-4">
                          <dl className="space-y-4">
                            <div className="space-y-1">
                              <dt className="text-body-sm text-subtle">
                                Public key (npub)
                              </dt>
                              <dd className="break-all text-mono select-all">
                                {npubEncode(agent.pubkey)}
                              </dd>
                            </div>
                            <div className="space-y-1">
                              <dt className="text-body-sm text-subtle">
                                Relay
                              </dt>
                              <dd className="break-all text-mono select-all">
                                {agent.relayUrl}
                              </dd>
                            </div>
                          </dl>
                          {!!agent.diagnostics.length && (
                            <div className="space-y-2">
                              <h4 className="text-label">Host diagnostics</h4>
                              <pre className="whitespace-pre-wrap break-words text-mono">
                                {agent.diagnostics.join("\n")}
                              </pre>
                            </div>
                          )}
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            </div>
            {agent.error && (
              <p role="alert" className="text-danger">
                {agent.error}
              </p>
            )}
            {(state.error || error) && (
              <p role="alert" className="text-danger">
                {state.error ?? error}
              </p>
            )}
            {saving && (
              <p role="status" className="text-secondary">
                {validating ? "Testing Codex connection…" : "Saving changes…"}
              </p>
            )}
            {agent.profilePending && (
              <Button
                disabled={
                  disabled ||
                  state.busy ||
                  state.status !== "ready" ||
                  !control.publishProfile
                }
                onClick={() => {
                  if (disabled) return;
                  setNotice(null);
                  void control
                    .publishProfile?.(agent.id)
                    .then(() => {
                      if (mounted.current)
                        setNotice(
                          "Profile published. Running work was not restarted.",
                        );
                    })
                    .catch(() => {});
                }}
              >
                Retry profile publication
              </Button>
            )}
            {state.status === "error" && (
              <Button onClick={() => void control.refresh()}>
                Retry status
              </Button>
            )}
            {stale && (
              <p role="alert" className="text-danger">
                The host has a newer saved revision. Your edits are still here;
                copy anything you need, then discard to load the latest
                settings.
              </p>
            )}
            {notice && (
              <p role="status" className="text-secondary">
                {notice}
              </p>
            )}
            <div className="buzz-dialog-actions">
              <Button
                type="button"
                disabled={!canClose}
                onClick={validating ? cancelValidation : close}
              >
                {validating ? "Cancel validation" : "Cancel"}
              </Button>
              {stale && (
                <Button disabled={state.busy} onClick={discard}>
                  Discard changes
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={blocked || !dirty || stale}
              >
                Save changes
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
