import { useEffect, useSyncExternalStore } from "react";
import type { AgentView } from "../../features/agents/control";
import { observedSessionSettings } from "../../features/agents/session-settings";
import type { RelaySession } from "../../features/relay/session";

const formatTime = (value: number) => new Date(value).toLocaleString();

/** Read-only retained conversation evidence; it never certifies saved settings. */
export function AgentSessionSettings({
  agent,
  activity,
}: {
  agent: AgentView;
  activity: RelaySession["agentActivity"];
}) {
  useEffect(() => activity.activate(), [activity]);
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const reports = observedSessionSettings(snapshot.records, agent.pubkey);
  const configuration = agent.harness.configuration;
  const delegated = configuration?.mode !== "advanced";
  const requestedEffort =
    configuration?.mode === "advanced"
      ? configuration.effort.kind === "value"
        ? configuration.effort.value
        : "Not supported by this adapter"
      : "Default (delegated to Codex CLI)";
  return (
    <section aria-label="Observed session settings" className="space-y-3">
      <h3 className="text-label">Observed session settings</h3>
      <p className="text-label">Saved requested settings</p>
      <dl
        aria-label="Saved requested settings"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm"
      >
        <dt className="text-subtle">Requested model</dt>
        <dd className="break-all font-mono text-mono">
          {delegated ? "Default (delegated to Codex CLI)" : agent.harness.model}
        </dd>
        <dt className="text-subtle">Requested effort</dt>
        <dd className="break-all font-mono text-mono">{requestedEffort}</dd>
      </dl>
      <p className="text-body-sm text-subtle">
        Observations are historical conversation evidence. They do not confirm
        this saved revision or the current launch.
      </p>
      {!reports.length && (
        <p role="status" className="text-body-sm">
          {snapshot.status === "unavailable"
            ? "Observation is unavailable in this connection."
            : "Not reported. No retained conversation turn includes applied settings."}
        </p>
      )}
      {reports.map((report) => {
        const at = report.sessionObservedAt ?? report.failedAt;
        return (
          <article
            key={`${report.turnId}:${report.workerIndex}:${report.channelId}:${at}`}
            className="space-y-2 rounded-lg border border-border-subtle p-3 text-body-sm"
          >
            <div>
              <p className="break-all font-mono text-mono">
                Session {report.sessionId ?? "not reported"}
              </p>
              <p className="text-subtle">
                Turn {report.turnId} · worker {report.workerIndex}
                {at && (
                  <>
                    {" "}
                    ·{" "}
                    <time dateTime={new Date(at).toISOString()}>
                      {formatTime(at)}
                    </time>
                  </>
                )}
              </p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {(["model", "effort"] as const).map((kind) => {
                const observed = report[kind];
                return (
                  <div className="contents" key={kind}>
                    <dt className="capitalize text-subtle">Observed {kind}</dt>
                    <dd className="break-all font-mono text-mono">
                      {observed ? (
                        <>
                          {observed.value} ·{" "}
                          <time
                            dateTime={new Date(
                              observed.observedAt,
                            ).toISOString()}
                          >
                            {formatTime(observed.observedAt)}
                          </time>
                        </>
                      ) : (
                        "Not reported"
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {report.modelRejection && (
              <p role="status">
                Requested model {report.requestedModel} was{" "}
                {report.modelRejection}.
                {report.model
                  ? ` Reported fallback: ${report.model.value}.`
                  : " No fallback was reported."}
              </p>
            )}
            {report.effortRejected && (
              <p role="status">
                Requested effort {report.requestedEffort} was rejected.
                {report.effort
                  ? ` Reported fallback: ${report.effort.value}.`
                  : " No fallback was reported."}
              </p>
            )}
            {report.failedAt && (
              <p role="status">
                This turn failed ·{" "}
                <time dateTime={new Date(report.failedAt).toISOString()}>
                  {formatTime(report.failedAt)}
                </time>
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
