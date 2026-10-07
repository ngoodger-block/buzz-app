import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { Input } from "../../../shared/design-system/ui/Input";
import { AlertDialog } from "../../../shared/design-system/ui/AlertDialog";
import type { LoginSnapshot, OAuthSession } from "../oauth/session";
import type { AgentClient, RemoteAgent } from "./client";
import type { AgentEnrollment } from "./enrollment";

export function RemoteAgents({
  client,
  session,
  active,
  enrollment,
}: {
  client: AgentClient;
  session: OAuthSession;
  active(): boolean;
  enrollment: AgentEnrollment;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  return login.status === "signed-in" ? (
    <AgentList
      client={client}
      account={login.account}
      active={active}
      enrollment={enrollment}
    />
  ) : null;
}

function AgentList({
  client,
  account,
  active,
  enrollment,
}: {
  client: AgentClient;
  account: LoginSnapshot["account"];
  active(): boolean;
  enrollment: AgentEnrollment;
}) {
  const connection = useSyncExternalStore(
    enrollment.subscribe,
    enrollment.snapshot,
  );
  const [revision, setRevision] = useState(0);
  const [agents, setAgents] = useState<readonly RemoteAgent[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<readonly string[]>([]);
  const [confirmed, setConfirmed] = useState<readonly string[]>([]);
  const [deleting, setDeleting] = useState<RemoteAgent>();
  const [removing, setRemoving] = useState<readonly string[]>([]);
  const operation = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Account changes and explicit refreshes must restart the read.
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(false);
    setName("");
    setLoading(true);
    setAgents(undefined);
    setError(undefined);
    setPending([]);
    setConfirmed([]);
    setDeleting(undefined);
    setRemoving([]);
    const current = () => !controller.signal.aborted && active();
    void (async () => {
      try {
        const rows = await client.list(controller.signal);
        if (!current()) return;
        setAgents(rows);
        setRemoving(
          rows
            .filter((row) => enrollment.deleting(row))
            .map((row) => row.pubkey),
        );
        const intended = enrollment.pending(rows);
        setPending(intended);
        setLoading(false);
        setBusy(true);
        try {
          await enrollment.recover(rows, controller.signal, active);
        } finally {
          if (current()) {
            const remaining = enrollment.pending(rows);
            setPending(remaining);
            setConfirmed(intended.filter((key) => !remaining.includes(key)));
          }
        }
      } catch (reason) {
        if (current()) {
          setError(
            reason instanceof Error ? reason.message : "Could not load agents.",
          );
          setLoading(false);
        }
      } finally {
        if (current()) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [client, account, revision, connection, enrollment]);
  const run = async (
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
    failure: string,
  ) => {
    const signal = operation.current?.signal;
    if (!signal || signal.aborted || busy || loading || !active()) return;
    const current = () => !signal.aborted && active();
    setBusy(true);
    setError(undefined);
    try {
      await work(signal, current);
    } catch (reason) {
      if (current())
        setError(reason instanceof Error ? reason.message : failure);
    } finally {
      if (current()) setBusy(false);
    }
  };
  const change = (agent?: RemoteAgent) =>
    run(async (signal, current) => {
      const show = (row: RemoteAgent) =>
        setAgents((rows) => [
          ...(rows ?? []).filter((item) => item.id !== row.id),
          row,
        ]);
      const context = enrollment.capture();
      if (agent?.status === "Active") {
        const id = agent.id;
        const rows = await client.list(signal);
        if (!current() || !enrollment.current(context)) return;
        setAgents(rows);
        agent = rows.find((row) => row.id === id);
        if (agent?.status !== "Active")
          throw new Error("Agent is no longer Active. Refresh agents.");
        if (!enrollment.pending(rows).includes(agent.pubkey)) return;
      }
      const registered = agent ?? (await client.register(name, signal));
      if (!current() || !enrollment.current(context)) return;
      show(registered);
      if (!agent) setName("");
      enrollment.remember(context, registered);
      if (context)
        setPending((rows) => [...new Set([...rows, registered.pubkey])]);
      const ready =
        registered.status === "Active"
          ? registered
          : await client.attest(
              registered,
              signal,
              () =>
                active() &&
                enrollment.current(context) &&
                !enrollment.deleting(registered),
              context?.viewer,
            );
      if (!current() || !enrollment.current(context)) return;
      show(ready);
      await enrollment.publish(context, ready, signal, active);
      if (current()) {
        setPending((rows) => rows.filter((key) => key !== ready.pubkey));
        if (context) setConfirmed((rows) => [...rows, ready.pubkey]);
      }
    }, "Could not create the agent. Retry the same name.");
  const remove = (agent: RemoteAgent) => {
    setDeleting(undefined);
    return run(async (signal, current) => {
      setRemoving((rows) => [...new Set([...rows, agent.pubkey])]);
      setConfirmed((rows) => rows.filter((key) => key !== agent.pubkey));
      await enrollment.remove(agent, client, signal, active);
      if (current()) {
        setRevision((value) => value + 1);
      }
    }, "Could not delete the agent. Retry Delete agent.");
  };
  return (
    <section
      data-buzz-ui=""
      className="mt-6 flex flex-col gap-3"
      aria-label="Remote agents"
    >
      <h3 className="text-heading-sm text-primary">Remote agents</h3>
      <form
        className="flex flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void change();
        }}
      >
        <Field
          label="Agent name"
          description="Up to 64 letters, numbers, spaces, dots, hyphens or underscores."
        >
          <Input
            value={name}
            onValueChange={setName}
            maxLength={64}
            required
            disabled={busy || loading}
          />
        </Field>
        <Button
          type="submit"
          variant="prominent"
          loading={busy}
          disabled={loading || !name.trim()}
        >
          Create agent
        </Button>
      </form>
      {loading && (
        <p role="status" className="text-body-sm text-secondary">
          Loading remote agents…
        </p>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {agents?.length === 0 && (
        <p className="text-body-sm text-secondary">No remote agents yet.</p>
      )}
      {agents && agents.length > 0 && (
        <ul className="flex flex-col gap-3">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-col gap-1">
              <div className="text-body-sm text-primary">
                {agent.name} · {agent.status}
              </div>
              <span className="break-all text-mono text-secondary">
                {agent.pubkey}
              </span>
              {pending.includes(agent.pubkey) &&
                !removing.includes(agent.pubkey) && (
                  <p className="text-body-sm text-secondary">
                    Community registration pending.
                  </p>
                )}
              {removing.includes(agent.pubkey) && (
                <p className="text-body-sm text-secondary">
                  Deletion pending. Retry Delete agent.
                </p>
              )}
              {confirmed.includes(agent.pubkey) && (
                <p className="text-body-sm text-secondary">
                  Registration confirmed in this community.
                </p>
              )}
              {agent.status === "Active" &&
                pending.includes(agent.pubkey) &&
                !removing.includes(agent.pubkey) && (
                  <Button
                    variant="outline"
                    disabled={busy || loading}
                    onClick={() => void change(agent)}
                  >
                    Retry community setup
                  </Button>
                )}
              {agent.status === "Unattested" &&
                !removing.includes(agent.pubkey) && (
                  <div>
                    <Button
                      variant="outline"
                      disabled={busy || loading}
                      onClick={() => void change(agent)}
                    >
                      Finish setup
                    </Button>
                  </div>
                )}
              <div>
                <Button
                  variant="destructive"
                  disabled={busy || loading}
                  onClick={() => setDeleting(agent)}
                >
                  Delete agent
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="outline"
          loading={loading}
          disabled={busy}
          onClick={() => {
            if (active()) setRevision((value) => value + 1);
          }}
        >
          {error ? "Retry" : "Refresh agents"}
        </Button>
      </div>
      {deleting && (
        <AlertDialog
          title={`Delete ${deleting.name}?`}
          description="This permanently deletes the remote agent from Builderlab. Its registration is removed from the selected community first. Channel memberships and past messages remain. With no community selected, only Builderlab is updated."
          onClose={() => setDeleting(undefined)}
          actions={
            <>
              <Button onClick={() => setDeleting(undefined)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={busy || loading}
                onClick={() => void remove(deleting)}
              >
                Delete agent
              </Button>
            </>
          }
        />
      )}
    </section>
  );
}
