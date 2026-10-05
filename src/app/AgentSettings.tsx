import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentControl } from "../features/agents/control";
import {
  setRememberAgentsPreference,
  useRememberAgentsPreference,
} from "../features/messages/mention-preferences";
import {
  ArrowsClockwiseIcon,
  CopyIcon,
  QuestionIcon,
} from "../shared/design-system/icons";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { Button } from "../shared/design-system/ui/Button";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { PreferenceRow } from "../shared/design-system/ui/PreferenceRow";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import type { ReactNode } from "react";
import { AgentDefaultsCard } from "./AgentDefaultsCard";
import styles from "./AgentSettings.module.css";

const acpHint =
  "Buzz talks to harnesses through the Agent Client Protocol (ACP). Goose ships with Buzz and supports ACP natively. Pi needs a small adapter, `buzz-pi-acp`. Your existing CLI setup and sign-in are left untouched.";
const piCommand = "npm install -g '@earendil-works/pi-coding-agent@>=0.99.0'";
const adapterCommand =
  "npm install -g --install-links=true 'git+https://github.com/salman1993/buzz-pi-acp.git#72015de'";
const labels = {
  ready: "Ready",
  "cli-needed": "CLI needed",
  "adapter-needed": "Adapter needed",
  "not-enabled": "Not enabled",
} as const;
const commands = [
  ["Pi", "Install Pi", piCommand],
  ["Adapter", "Install the ACP adapter", adapterCommand],
] as const;

export function AgentSettings({
  control,
  active = true,
  archive,
}: {
  control: AgentControl;
  active?: boolean;
  archive?: ReactNode;
}) {
  const preference = useRememberAgentsPreference();
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const copyAttempt = useRef(0);
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  const {
    installing: installingPi,
    report: piResult,
    error: piError,
  } = state.piInstall ?? { installing: false, report: null, error: null };
  useEffect(() => {
    if (active) {
      void control.refresh().then(() => control.checkCodex?.());
    }
  }, [active, control]);
  const options = state.data?.harnessOptions;
  const existingHarnesses = (["Buzz Agent", "Goose", "Pi"] as const).map(
    (name) => options?.find((option) => option.label === name),
  );
  const codexOption = options?.find((option) => option.id === "codex");
  const harnesses = [
    ...existingHarnesses,
    ...(codexOption ? [codexOption] : []),
  ];
  const available = existingHarnesses.every((option) => !!option?.status);
  const pi = harnesses[2];
  const codex = state.codexReadiness;
  const codexStatus =
    codex?.status === "checking"
      ? "Checking…"
      : codex?.status === "error"
        ? "Check failed"
        : codex?.result
          ? {
              "binding-ready": "Binding verified",
              "cli-needed": "CLI needed",
              "adapter-needed": "Adapter needed",
              "interpreter-needed": "Node needed",
              "adapter-incompatible": "Adapter incompatible",
              "cli-incompatible": "CLI incompatible",
              "signed-out": "Sign-in needed",
              "configuration-error": "Configuration error",
              timeout: "Check timed out",
              "output-limit": "Check failed",
              "cleanup-failed": "Cleanup failed",
              "check-failed": "Check failed",
              unsupported: "Unsupported",
              cancelled: "Check cancelled",
            }[codex.result.status]
          : "Not checked";
  const change = (enabled: boolean) =>
    setError(setRememberAgentsPreference(enabled));
  const copy = async (name: string, command: string) => {
    const attempt = ++copyAttempt.current;
    try {
      await navigator.clipboard.writeText(command);
      if (attempt === copyAttempt.current)
        setCopyMessage(`${name} command copied.`);
    } catch {
      if (attempt === copyAttempt.current)
        setCopyMessage(
          `Couldn’t copy the ${name} command. Select it to copy manually.`,
        );
    }
  };
  return (
    <section aria-labelledby="agent-settings-title">
      <Header id="agent-settings-title" title="Agents" />
      <section aria-labelledby="harnesses-title">
        <InlineHeader
          id="harnesses-title"
          title="Harnesses"
          actions={
            <>
              <Tooltip content={acpHint}>
                <IconButton
                  size="sm"
                  aria-label="About ACP"
                  icon={<QuestionIcon size={16} aria-hidden="true" />}
                />
              </Tooltip>
              <Tooltip content="Check again">
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label="Check again"
                  icon={<ArrowsClockwiseIcon aria-hidden="true" />}
                  disabled={
                    state.status === "unavailable" || state.busy || installingPi
                  }
                  loading={checking}
                  onClick={() => {
                    setChecking(true);
                    void Promise.allSettled([
                      control.refresh(),
                      control.checkCodex?.() ?? Promise.resolve(),
                    ]).finally(() => setChecking(false));
                  }}
                />
              </Tooltip>
            </>
          }
        />
        <SettingsGroup layout="form">
          {state.status === "unavailable" ? (
            <p className="text-body-sm text-secondary">
              Harness detection requires the desktop app.
            </p>
          ) : state.status === "loading" || state.status === "idle" ? (
            <p role="status" className="text-body-sm text-secondary">
              Checking harnesses…
            </p>
          ) : !available ? (
            <p
              role={state.status === "error" ? "alert" : "status"}
              className="text-body-sm text-secondary"
            >
              {state.status === "error"
                ? "Couldn’t check harnesses. Select Check again to retry."
                : "Update the desktop app to check harnesses."}
            </p>
          ) : (
            <>
              {state.status === "error" && (
                <p role="alert">
                  Couldn’t confirm harnesses. Showing the last check; try Check
                  again.
                </p>
              )}
              <ul aria-labelledby="harnesses-title" className={styles.rows}>
                {harnesses.map((option) => (
                  <li
                    key={option?.id ?? option?.label}
                    className="py-3 text-body-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{option?.label}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-secondary">
                          {option?.id === "codex"
                            ? codexStatus
                            : option?.status
                              ? labels[option.status]
                              : "Unknown"}
                        </span>
                        {option?.label === "Pi" &&
                          (option.status !== "ready" ||
                            option.updateSupported) &&
                          option.installSupported &&
                          control.installPi &&
                          !piResult?.ready && (
                            <Button
                              size="sm"
                              type="button"
                              loading={installingPi}
                              disabled={
                                state.status !== "ready" ||
                                state.busy ||
                                installingPi
                              }
                              onClick={() => {
                                void control.installPi?.().catch(() => {});
                              }}
                            >
                              {option.status === "ready"
                                ? "Update Pi"
                                : "Install"}
                            </Button>
                          )}
                      </span>
                    </div>
                    {option?.id === "codex" &&
                      ((codex?.status === "checked" && codex.result?.message) ||
                        codex?.error) && (
                        <p
                          role={codex.error ? "alert" : "status"}
                          className="m-0 mt-2 text-secondary"
                        >
                          {codex.error || codex.result?.message}
                          {codex.status === "checked" &&
                            codex.result?.adapterVersion &&
                            codex.result?.cliVersion &&
                            ` Adapter ${codex.result.adapterVersion}; CLI ${codex.result.cliVersion}.`}
                        </p>
                      )}
                    {option?.label === "Pi" &&
                      (installingPi ||
                        piResult?.ready ||
                        piResult?.error ||
                        piError ||
                        pi?.status !== "ready") && (
                        <div className={`${styles.piSetup} space-y-3`}>
                          {installingPi && (
                            <p role="status">
                              Installing Pi and its ACP adapter…
                            </p>
                          )}
                          {!installingPi &&
                            piResult?.ready &&
                            pi?.status === "ready" && (
                              <p role="status">
                                Pi and its adapter are up to date. Restart
                                running Pi agents to use them. Restarted{" "}
                                {piResult.restarted} waiting agents.
                                {piResult.restartFailures > 0 &&
                                  ` ${piResult.restartFailures} agents could not restart; check Agents.`}
                              </p>
                            )}
                          {!installingPi && (piResult?.error || piError) && (
                            <div role="alert" className="text-body-sm">
                              <p className="whitespace-pre-wrap break-words">
                                {piResult?.error || piError}
                              </p>
                              {piResult && (
                                <details>
                                  <summary>Pi install log</summary>
                                  <p className="break-all">
                                    {piResult.logPath}
                                  </p>
                                  <pre
                                    className={`${styles.command} whitespace-pre-wrap break-all`}
                                  >
                                    {piResult.output ||
                                      "No output was recorded."}
                                  </pre>
                                </details>
                              )}
                            </div>
                          )}
                          {pi?.status !== "ready" && (
                            <div className="space-y-3 text-body-sm">
                              <p className="m-0 text-secondary">
                                {pi?.installSupported && control.installPi
                                  ? "Click Install. Buzz installs Node.js, Pi, and its ACP adapter for you."
                                  : "Use Manual setup on this device, then click Check again."}{" "}
                                Your existing CLI setup and sign-in are left
                                untouched.
                              </p>
                              <details>
                                <summary>Manual setup</summary>
                                <div className="space-y-3 mt-3">
                                  <ol
                                    aria-label="Manual setup steps"
                                    className={styles.rows}
                                  >
                                    <li>
                                      <PreferenceRow
                                        title="Install Node.js"
                                        subtitle="Use version 22.19 or newer. Run the following commands in your terminal."
                                      />
                                    </li>
                                    {commands.map(([name, title, command]) => (
                                      <li key={name}>
                                        <PreferenceRow
                                          title={title}
                                          subtitle={
                                            <code
                                              className={`${styles.command} text-mono`}
                                            >
                                              {command}
                                            </code>
                                          }
                                          trailing={
                                            <Tooltip
                                              content={`Copy ${name} command`}
                                            >
                                              <IconButton
                                                size="sm"
                                                variant="ghost"
                                                aria-label={`Copy ${name} command`}
                                                icon={
                                                  <CopyIcon aria-hidden="true" />
                                                }
                                                onClick={() =>
                                                  void copy(name, command)
                                                }
                                              />
                                            </Tooltip>
                                          }
                                        />
                                      </li>
                                    ))}
                                    <li>
                                      <PreferenceRow
                                        title="Check the installation"
                                        subtitle="Use Check again at the top of Harnesses to refresh the status."
                                      />
                                    </li>
                                  </ol>
                                  {copyMessage && (
                                    <p role="status" className="m-0">
                                      {copyMessage}
                                    </p>
                                  )}
                                </div>
                              </details>
                            </div>
                          )}
                        </div>
                      )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </SettingsGroup>
      </section>
      <AgentDefaultsCard control={control} state={state} />
      {archive}
      <div className="mt-section-gap">
        <InlineHeader title="Messages" />
        <SettingsGroup>
          <SwitchPreferenceRow
            label="Remember mentioned agents"
            description="Keep the same agents selected for your next message in this channel or thread."
            checked={preference}
            onCheckedChange={change}
          />
        </SettingsGroup>
      </div>
      {active && error && (
        <ToastNotice title="Agent preference wasn’t saved" description={error}>
          <Button type="button" size="sm" onClick={() => change(preference)}>
            Retry saving
          </Button>
        </ToastNotice>
      )}
    </section>
  );
}
