import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentControl,
  AgentControlState,
} from "../../features/agents/control";
import type { ModelCatalog } from "../../features/agents/models";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { agentEdit, type AgentDraft } from "./agent-edit";

function readinessMessage(state: AgentControlState) {
  const readiness = state.codexReadiness;
  if (readiness?.status === "checking") return "Checking Codex CLI setup…";
  if (readiness?.status === "error")
    return readiness.error ?? "Couldn’t check Codex CLI setup.";
  if (readiness?.result) return readiness.result.message;
  return "Check the installed Codex CLI, ACP adapter, and existing sign-in before creating this agent.";
}

/** Managed Codex intent. Discovery is native-owned and never sends a prompt. */
export function CodexConfigurationFields({
  id,
  savedRevision,
  draft,
  control,
  state,
  disabled,
  onChange,
}: {
  id?: string | undefined;
  savedRevision?: number | undefined;
  draft: AgentDraft;
  control: AgentControl;
  state: AgentControlState;
  disabled: boolean;
  onChange(patch: Partial<AgentDraft>): void;
}) {
  const configuration = draft.configuration;
  const isAdvanced = configuration?.mode === "advanced";
  const advanced = isAdvanced ? configuration : null;
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const checked = useRef(false);
  const currentDraft = useRef(draft);
  const changeDraft = useRef(onChange);
  currentDraft.current = draft;
  changeDraft.current = onChange;
  const contextKey = JSON.stringify([
    id,
    savedRevision,
    draft.revision,
    draft.integration,
    draft.command,
    draft.args,
    draft.workspace,
    draft.environment,
  ]);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;

  useEffect(() => {
    if (!checked.current && control.checkCodex) {
      checked.current = true;
      void control.checkCodex();
    }
  }, [control]);

  const discover = useCallback(
    async (selectedModel?: string, changedModel = false) => {
      if (!control.models || pending.current) return;
      const requestContext = contextKey;
      const request = new AbortController();
      pending.current = request;
      setLoading(true);
      setStatus("");
      try {
        const requestCatalog = (selection?: string) =>
          control.models?.request(
            {
              id,
              expectedRevision: id ? savedRevision : undefined,
              edit: agentEdit(
                {
                  ...currentDraft.current,
                  ...(selection === undefined ? {} : { model: selection }),
                },
                true,
              ),
              host: "",
              filter: "",
              action: "refresh",
              integration: "codex",
              selectedModel: selection || undefined,
            },
            request.signal,
          );
        let result: ModelCatalog;
        let selectedConfirmed = true;
        try {
          const selected = await requestCatalog(selectedModel);
          if (!selected) return;
          result = selected;
        } catch (error) {
          if (
            !selectedModel ||
            request.signal.aborted ||
            currentContext.current !== requestContext
          )
            throw error;
          const fallback = await requestCatalog();
          if (!fallback) return;
          result = fallback;
          selectedConfirmed = false;
          setStatus(
            `${(error as Error).message} Choose a model from the refreshed catalog.`,
          );
        }
        if (request.signal.aborted || currentContext.current !== requestContext)
          return;
        setCatalog(result);
        const metadata = result.codex;
        if (!metadata?.modelsKnown) {
          setStatus(
            "Codex did not report a model catalog. Your saved choices are unchanged; refresh after updating the selected tools.",
          );
          return;
        }
        if (metadata.modelsKnown && result.models.length === 0) {
          setStatus(
            "Codex reported no available models. Your saved choices are unchanged.",
          );
          return;
        }
        if (!selectedModel || !changedModel || !selectedConfirmed) return;
        const effort = metadata.effort;
        if (!effort || effort.model !== selectedModel) {
          setStatus(
            "Codex did not report effort choices for this model. Your saved effort is unchanged.",
          );
          return;
        }
        const current = currentDraft.current.configuration;
        if (current?.mode !== "advanced") return;
        if (effort.options.length === 0) {
          if (current.effort.kind !== "unsupported")
            changeDraft.current({
              configuration: {
                mode: "advanced",
                effort: { kind: "unsupported" },
              },
            });
          return;
        }
        const currentEffort =
          current.effort.kind === "value" ? current.effort.value : undefined;
        if (
          currentEffort === undefined ||
          (currentEffort !== "" &&
            !effort.options.some((option) => option.id === currentEffort))
        ) {
          changeDraft.current({
            configuration: {
              mode: "advanced",
              effort: { kind: "value", value: "" },
            },
          });
        }
      } catch (error) {
        if (
          !request.signal.aborted &&
          currentContext.current === requestContext
        )
          setStatus((error as Error).message);
      } finally {
        if (pending.current === request) {
          pending.current = null;
          setLoading(false);
        }
      }
    },
    [contextKey, control.models, id, savedRevision],
  );

  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setCatalog(null);
    setStatus("");
    setLoading(false);
    if (isAdvanced) void discover(currentDraft.current.model || undefined);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [isAdvanced, discover]);

  const models = catalog?.codex?.modelsKnown ? catalog.models : [];
  const modelOptions = [...models];
  if (draft.model && !modelOptions.some((model) => model.id === draft.model))
    modelOptions.unshift({ id: draft.model, name: `${draft.model} (saved)` });
  const effort =
    catalog?.codex?.effort?.model === draft.model
      ? catalog.codex.effort
      : undefined;
  const savedEffort =
    advanced?.effort.kind === "value" ? advanced.effort.value : undefined;
  const effortValue = savedEffort ?? "unsupported";
  const effortOptions = [...(effort?.options ?? [])];
  if (savedEffort && !effortOptions.some((option) => option.id === savedEffort))
    effortOptions.unshift({
      id: savedEffort,
      name: `${savedEffort} (saved)`,
    });
  const staleEffort =
    !!savedEffort &&
    !!effort &&
    !effort.options.some((option) => option.id === savedEffort);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p
          role={state.codexReadiness?.status === "error" ? "alert" : "status"}
          className="text-body-sm text-secondary"
        >
          {readinessMessage(state)}
        </p>
        {control.checkCodex && (
          <Button
            type="button"
            disabled={disabled || state.codexReadiness?.status === "checking"}
            loading={state.codexReadiness?.status === "checking"}
            onClick={() => void control.checkCodex?.()}
          >
            Check Codex setup
          </Button>
        )}
      </div>
      <Select
        label="Codex configuration"
        variant="field"
        disabled={disabled}
        value={configuration?.mode ?? ""}
        groups={[
          {
            label: "",
            options: [
              { value: "default", label: "Default" },
              { value: "advanced", label: "Advanced" },
            ],
          },
        ]}
        onValueChange={(mode) =>
          onChange(
            mode === "default"
              ? {
                  model: "",
                  configuration: { mode: "default" },
                }
              : {
                  configuration: {
                    mode: "advanced",
                    effort: { kind: "value", value: "" },
                  },
                },
          )
        }
        description={
          configuration?.mode === "default"
            ? "Codex chooses the model and effort from its effective configuration each time this agent starts."
            : "Choose an advertised model and one of that model’s reported effort levels."
        }
      />
      {advanced && (
        <>
          <Select
            label="Codex model"
            variant="field"
            disabled={disabled || loading || !catalog?.codex?.modelsKnown}
            value={draft.model}
            groups={[
              {
                label: "",
                options: [
                  { value: "", label: "Choose a model" },
                  ...modelOptions.map((model) => ({
                    value: model.id,
                    label: model.name,
                  })),
                ],
              },
            ]}
            onValueChange={(model) => {
              onChange({ model });
              if (model) void discover(model, true);
            }}
          />
          {draft.model && effort?.options.length === 0 ? (
            <div className="space-y-2">
              <p role="status" className="text-body-sm text-secondary">
                {savedEffort
                  ? `The saved ${savedEffort} effort is no longer supported by this model.`
                  : "This model reports no effort control. Codex will use its model configuration."}
              </p>
              {savedEffort && (
                <Button
                  type="button"
                  disabled={disabled || loading}
                  onClick={() =>
                    onChange({
                      configuration: {
                        mode: "advanced",
                        effort: { kind: "unsupported" },
                      },
                    })
                  }
                >
                  Use model configuration
                </Button>
              )}
            </div>
          ) : (
            <Select
              label="Codex effort"
              variant="field"
              disabled={disabled || loading || !effort}
              value={effortValue}
              groups={[
                {
                  label: "",
                  options: [
                    { value: "", label: "Choose an effort level" },
                    ...effortOptions.map((option) => ({
                      value: option.id,
                      label: option.name,
                    })),
                  ],
                },
              ]}
              onValueChange={(value) =>
                onChange({
                  configuration: {
                    mode: "advanced",
                    effort: { kind: "value", value },
                  },
                })
              }
            />
          )}
          {loading && (
            <p role="status" className="text-body-sm text-secondary">
              Loading Codex models and effort choices…
            </p>
          )}
          {status && (
            <p role="status" className="text-body-sm text-secondary">
              {status}
            </p>
          )}
          {staleEffort && (
            <p role="alert" className="text-body-sm text-warning">
              The saved effort is no longer reported for this model. Choose an
              available effort level before saving.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {loading ? (
              <Button
                type="button"
                disabled={disabled}
                onClick={() => pending.current?.abort()}
              >
                Cancel model lookup
              </Button>
            ) : (
              <Button
                type="button"
                disabled={disabled || !control.models}
                onClick={() => void discover(draft.model || undefined)}
              >
                Refresh Codex models
              </Button>
            )}
          </div>
        </>
      )}
      <p className="text-body-sm text-secondary">
        Creating this agent, or saving execution changes, sends one real Codex
        request. It can consume quota and use tools configured in Codex. Buzz
        does not give that check an agent identity, relay access, or Buzz tools.
      </p>
    </div>
  );
}
