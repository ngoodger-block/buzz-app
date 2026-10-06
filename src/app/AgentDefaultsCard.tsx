import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  savedMessage,
  type AgentControl,
  type AgentControlState,
  type AgentDefaultSettings,
  type AgentDefaultsEdit,
  type AgentEdit,
  type HarnessConfigurationPolicy,
} from "../features/agents/control";
import type { ModelCatalog } from "../features/agents/models";
import {
  effectiveGooseProvider,
  gooseApiKey,
  PI_API_KEYS,
  harnessKind,
} from "../bundled/agents/agent-edit";
import { ProviderApiKeyField } from "../bundled/agents/ProviderApiKeyField";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { Button } from "../shared/design-system/ui/Button";
import { Accordion } from "../shared/design-system/ui/Accordion";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Select } from "../shared/design-system/ui/Select";
import styles from "./AgentSettings.module.css";

const harnesses = [
  { value: "buzz-agent", label: "Buzz Agent" },
  { value: "goose", label: "Goose" },
  { value: "pi", label: "Pi" },
] as const;

// Legacy suggestions only, never model capability evidence. Native policy marks
// effort discovery unknown until the integration reports model-specific metadata.
const effortChoices = {
  "buzz-agent": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  goose: ["off", "low", "medium", "high", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh"],
} as const;

const VISIBLE_MODEL_LIMIT = 10;

function defaultLabel(harness: AgentDefaultsEdit["harness"], value: string) {
  return value && harness === "buzz-agent"
    ? `Use build default (${value})`
    : "Not set (use harness default)";
}

type Choice = { value: string; label: string };

function defaultHarness(
  state: AgentControlState,
  kind: AgentDefaultsEdit["harness"],
) {
  return state.data?.harnessOptions?.find(
    (option) => harnessKind(option.command) === kind,
  );
}

function environmentSet(
  current: AgentDefaultsEdit,
  savedKeys: string[],
  key: string,
) {
  return (
    typeof current.environment[key] === "string" ||
    (current.environment[key] === undefined && savedKeys.includes(key))
  );
}

/** A saved ID stays editable even when it is absent from today's suggestions. */
function DefaultsChoice({
  label,
  value,
  customValue = value,
  choices,
  disabled,
  onSelect,
  onCustom,
  resetKey,
}: {
  label: string;
  value: string;
  customValue?: string;
  choices: Choice[];
  disabled: boolean;
  onSelect(value: string): void;
  onCustom(value: string): void;
  resetKey: string;
}) {
  const [custom, setCustom] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const focusAfterSelection = useRef<"input" | "trigger" | null>(null);
  // Only a user-selected mode change transfers focus; catalog retirement must
  // leave focus in the credential or environment field being edited.
  useLayoutEffect(() => {
    if (focusAfterSelection.current === "input") input.current?.focus();
    else if (focusAfterSelection.current === "trigger")
      container.current
        ?.querySelector<HTMLElement>('[role="combobox"]')
        ?.focus();
    focusAfterSelection.current = null;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new editing session resets the local input mode.
  useEffect(() => setCustom(false), [resetKey]);
  const index = choices.findIndex((choice) => choice.value === value);
  const showInput = custom || index < 0;
  return (
    <div ref={container} className="space-y-3">
      <Select
        // A removed catalog option becomes editable text; retire the old
        // Select so its option-removal fallback cannot clear the chosen ID.
        key={showInput ? "custom" : "choice"}
        label={label}
        variant="field"
        disabled={disabled}
        value={showInput ? "custom" : `choice:${value}`}
        groups={[
          {
            label: "",
            options: [
              ...choices.map((choice) => ({
                value: `choice:${choice.value}`,
                label: choice.label,
              })),
              { value: "custom", label: "Custom ID" },
            ],
          },
        ]}
        onValueChange={(selected) => {
          if (selected === "custom") {
            if (showInput) input.current?.focus();
            else focusAfterSelection.current = "input";
          } else if (showInput) focusAfterSelection.current = "trigger";
          setCustom(selected === "custom");
          if (selected !== "custom") {
            const choice = choices.find(
              (option) => `choice:${option.value}` === selected,
            );
            if (choice) onSelect(choice.value);
          }
        }}
      />
      {showInput && (
        <Field label={`Custom ${label.toLowerCase()} ID`}>
          <Input
            ref={input}
            disabled={disabled}
            spellCheck={false}
            value={customValue}
            onChange={(event) => {
              setCustom(true);
              onCustom(event.target.value);
            }}
          />
        </Field>
      )}
    </div>
  );
}

function ProviderChoice({
  current,
  state,
  models,
  disabled,
  onChange,
  editSession,
}: {
  current: AgentDefaultsEdit;
  state: AgentControlState;
  models: ModelCatalog["models"];
  disabled: boolean;
  onChange(provider: string): void;
  editSession: number;
}) {
  const harness = defaultHarness(state, current.harness);
  const discoveredProviders = harness?.configurationPolicy
    ? harness.configurationPolicy.provider === "discovered"
    : current.harness === "pi";
  const discovered = discoveredProviders
    ? [...new Set(models.map((model) => model.id.split("/")[0] ?? ""))].filter(
        Boolean,
      )
    : [];
  const providers = discoveredProviders
    ? [
        ...discovered.map((value) => ({
          value,
          label: `${PI_API_KEYS[value]?.label ?? value} (available in Pi)`,
        })),
        ...Object.entries(PI_API_KEYS)
          .filter(([value]) => !discovered.includes(value))
          .map(([value, details]) => ({
            value,
            label: `${details.label} (API key may be needed)`,
          })),
      ]
    : (harness?.providers ?? []);
  const builtInProvider = state.data?.agentDefaults?.provider ?? "";
  const builtInLabel =
    providers.find((provider) => provider.value === builtInProvider)?.label ??
    builtInProvider;
  const overrideKey = harness?.configurationPolicy
    ? harness.configurationPolicy.selectorEnvironment?.provider
    : current.harness === "goose"
      ? "GOOSE_PROVIDER"
      : current.harness === "buzz-agent"
        ? "BUZZ_AGENT_PROVIDER"
        : null;
  const providerOverridden =
    !!overrideKey &&
    environmentSet(
      current,
      state.data?.defaultSettings?.environmentKeys ?? [],
      overrideKey,
    );
  return (
    <div className="space-y-2">
      <DefaultsChoice
        label="Default provider"
        value={current.provider}
        choices={[
          { value: "", label: defaultLabel(current.harness, builtInLabel) },
          ...providers,
        ]}
        disabled={disabled}
        resetKey={`${current.harness}-${editSession}`}
        onSelect={onChange}
        onCustom={onChange}
      />
      {providerOverridden && (
        <p className="m-0 text-body-sm text-warning">
          {overrideKey} overrides this provider selection. Replace or remove it
          under Environment variables.
        </p>
      )}
    </div>
  );
}

function defaultsApiKey(
  current: AgentDefaultsEdit,
  savedKeys: string[],
  policy?: HarnessConfigurationPolicy,
) {
  if (policy?.authentication === "external") return undefined;
  if (current.harness === "pi") return PI_API_KEYS[current.provider];
  if (current.harness !== "goose") return undefined;
  const provider = effectiveGooseProvider(
    current.provider,
    current.environment,
    savedKeys,
  );
  return provider ? gooseApiKey(provider) : undefined;
}

function ModelChoice({
  control,
  state,
  current,
  disabled,
  onChange,
  onModels,
  editSession,
}: {
  control: AgentControl;
  state: AgentControlState;
  current: AgentDefaultsEdit;
  disabled: boolean;
  onChange(patch: Partial<AgentDefaultsEdit>): void;
  onModels(models: ModelCatalog["models"]): void;
  editSession: number;
}) {
  const harness = defaultHarness(state, current.harness);
  const policy = harness?.configurationPolicy;
  const pi = policy
    ? policy.provider === "discovered"
    : current.harness === "pi";
  const [catalog, setCatalog] = useState<{
    key: string;
    models: ModelCatalog["models"];
  } | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [query, setQuery] = useState("");
  const pending = useRef<AbortController | null>(null);
  const key = JSON.stringify([
    current.harness,
    pi ? null : current.provider,
    harness?.command,
    harness?.defaultArgs,
    current.environment,
    state.data?.defaultWorkspace,
    state.data?.databricksDefaults,
    state.data?.defaultSettings?.environmentKeys,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: search text belongs to this provider and editing session.
  useEffect(() => setQuery(""), [current.provider, editSession]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the lookup context; a changed context retires native work.
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setAttempted(false);
    setStatus("");
    setQuery("");
    onModels([]);
    return () => {
      pending.current?.abort();
    };
  }, [key]);
  const fresh = catalog?.key === key ? catalog.models : [];
  const entries = fresh.filter(
    (model) =>
      !pi || !current.provider || model.id.startsWith(`${current.provider}/`),
  );
  const selectedId =
    pi && current.provider && current.model
      ? `${current.provider}/${current.model}`
      : current.model;
  const matching = entries
    .filter((model) =>
      `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, VISIBLE_MODEL_LIMIT);
  // Filtering must not turn the current catalog choice into a custom ID.
  const selected = entries.find((model) => model.id === selectedId);
  if (selected && !matching.some((model) => model.id === selected.id))
    matching.unshift(selected);
  const modelKey = policy
    ? policy.selectorEnvironment?.model
    : {
        "buzz-agent": "BUZZ_AGENT_MODEL",
        goose: "GOOSE_MODEL",
        pi: "",
      }[current.harness];
  const savedKeys = state.data?.defaultSettings?.environmentKeys ?? [];
  const modelOverridden =
    !!modelKey && environmentSet(current, savedKeys, modelKey);
  const providerOverride = current.environment.BUZZ_AGENT_PROVIDER;
  const effectiveProvider =
    typeof providerOverride === "string"
      ? providerOverride
      : environmentSet(current, savedKeys, "BUZZ_AGENT_PROVIDER")
        ? null
        : current.provider || state.data?.agentDefaults?.provider;
  const buildModelApplies =
    current.harness === "buzz-agent" &&
    ["databricks_v2", "databricks-v2", "databricks"].includes(
      effectiveProvider ?? "",
    ) &&
    !modelOverridden &&
    !environmentSet(current, savedKeys, "DATABRICKS_MODEL");
  const removingEnvironment = Object.values(current.environment).includes(null);
  const choices: Choice[] = [
    {
      value: "",
      label: defaultLabel(
        current.harness,
        buildModelApplies ? (state.data?.agentDefaults?.model ?? "") : "",
      ),
    },
    ...matching.map((model) => ({
      value: model.id,
      label: model.name === model.id ? model.id : `${model.name} · ${model.id}`,
    })),
  ];
  const choose = (value: string) => {
    if (pi && !value) onChange({ provider: "", model: "" });
    else if (pi && fresh.some((model) => model.id === value)) {
      const slash = value.indexOf("/");
      onChange({
        provider: value.slice(0, slash),
        model: value.slice(slash + 1),
      });
    } else onChange({ model: value });
  };
  const browse = async () => {
    if (
      !control.models ||
      !harness ||
      harness.available === false ||
      removingEnvironment ||
      pending.current
    )
      return;
    const run = new AbortController();
    pending.current = run;
    setBusy(true);
    setAttempted(true);
    setStatus(`Loading ${harness.label} models…`);
    const environmentHost = environmentSet(
      current,
      savedKeys,
      "DATABRICKS_HOST",
    );
    const environmentFilter = environmentSet(
      current,
      savedKeys,
      "DATABRICKS_MODEL_FILTER",
    );
    const edit: AgentEdit = {
      name: "",
      systemPrompt: "",
      sessionPolicy: current.sessionPolicy,
      workspace: state.data?.defaultWorkspace ?? "",
      harness: {
        command: harness.command,
        args: harness.defaultArgs ?? [],
        provider:
          current.harness === "buzz-agent" && !current.provider
            ? state.data?.agentDefaults?.provider || "databricks_v2"
            : current.provider,
        model: current.model,
      },
      environment: current.environment,
    };
    try {
      const result = await control.models.request(
        {
          edit,
          host:
            current.harness === "buzz-agent" && !environmentHost
              ? (state.data?.databricksDefaults?.host ?? "")
              : "",
          filter:
            current.harness === "buzz-agent" && !environmentFilter
              ? (state.data?.databricksDefaults?.filter ?? "")
              : "",
          action: "connect",
          integration: harness.id,
          selectedModel: current.model || undefined,
          ...(environmentHost || environmentFilter
            ? { inheritWorkspace: true }
            : {}),
        },
        run.signal,
      );
      if (run.signal.aborted || currentKey.current !== key) return;
      setCatalog({ key, models: result.models });
      onModels(result.models);
      setStatus(
        result.modelOverridden
          ? "A saved environment model override takes precedence over this selection."
          : result.models.length
            ? "Model choices loaded. Availability does not confirm inference access."
            : `No ${harness.label} models found. Enter a custom model ID or retry.`,
      );
    } catch (problem) {
      if (!run.signal.aborted && currentKey.current === key)
        setStatus((problem as Error).message);
    } finally {
      if (pending.current === run) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <div className="space-y-2">
      {entries.length > VISIBLE_MODEL_LIMIT && (
        <Field
          label="Search models"
          description={`Search all ${entries.length} models by name or ID. Up to ${VISIBLE_MODEL_LIMIT} matches are shown, plus the selected model.`}
        >
          <Input
            disabled={disabled}
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
      )}
      <DefaultsChoice
        label="Default model"
        value={selectedId}
        customValue={current.model}
        choices={choices}
        disabled={disabled}
        resetKey={`${current.harness}-${editSession}`}
        onSelect={choose}
        onCustom={(model) => onChange({ model })}
      />
      {modelOverridden && (
        <p className="m-0 text-body-sm text-warning">
          {modelKey} overrides this model selection. Replace or remove it under
          Environment variables.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <Button
            type="button"
            disabled={disabled}
            onClick={() => {
              pending.current?.abort();
              setStatus("Cancelled. Retry when ready.");
            }}
          >
            Cancel model lookup
          </Button>
        ) : (
          <Button
            type="button"
            disabled={
              disabled ||
              !control.models ||
              !harness ||
              harness.available === false ||
              removingEnvironment ||
              (current.harness === "goose" && !current.provider)
            }
            onClick={() => void browse()}
          >
            {attempted ? "Retry models" : "Browse models"}
          </Button>
        )}
        {status && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            {status}
          </p>
        )}
      </div>
      {harness?.available === false && (
        <p className="m-0 text-body-sm text-secondary">
          Install {harness.label} to browse its models. Custom IDs remain
          editable.
        </p>
      )}
      {!control.models && (
        <p className="m-0 text-body-sm text-secondary">
          Model browsing requires an updated desktop app. Custom IDs remain
          editable.
        </p>
      )}
      {current.harness === "goose" && !current.provider && (
        <p className="m-0 text-body-sm text-secondary">
          Choose a Goose provider to browse its models.
        </p>
      )}
      {(policy ? policy.model === "withProvider" : pi) &&
        current.provider &&
        !current.model && (
          <p className="m-0 text-body-sm text-warning">
            Choose a model for this Pi provider, or clear Provider to use Pi
            defaults.
          </p>
        )}
      {removingEnvironment && (
        <p className="m-0 text-body-sm text-secondary">
          Save environment removals before browsing models so lookup uses the
          updated settings.
        </p>
      )}
    </div>
  );
}

function draftFrom(saved: AgentDefaultSettings): AgentDefaultsEdit {
  const { environmentKeys: _keys, ...fields } = saved;
  return { ...fields, environment: {} };
}

/** Device-wide defaults. Environment values are write-only: only keys return. */
export function AgentDefaultsCard({
  control,
  state,
}: {
  control: AgentControl;
  state: AgentControlState;
}) {
  const saved = state.data?.defaultSettings;
  const [draft, setDraft] = useState<AgentDefaultsEdit | null>(null);
  const [newKey, setNewKey] = useState("");
  const newKeyInput = useRef<HTMLInputElement>(null);
  const [newValue, setNewValue] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelCatalog["models"]>([]);
  const [editSession, setEditSession] = useState(0);
  if (!saved || !control.saveDefaults) return null;
  const current = draft ?? draftFrom(saved);
  const disabled = state.busy || state.status !== "ready";
  const policy = defaultHarness(state, current.harness)?.configurationPolicy;
  const apiKey = defaultsApiKey(current, saved.environmentKeys, policy);
  const gooseProvider =
    current.harness === "goose"
      ? effectiveGooseProvider(
          current.provider,
          current.environment,
          saved.environmentKeys,
        )
      : undefined;
  const change = (patch: Partial<AgentDefaultsEdit>) => {
    setNotice("");
    const next = { ...current, ...patch };
    const previousKey = apiKey?.env;
    if (
      previousKey &&
      (next.harness !== current.harness ||
        defaultsApiKey(
          next,
          saved.environmentKeys,
          defaultHarness(state, next.harness)?.configurationPolicy,
        )?.env !== previousKey) &&
      typeof next.environment[previousKey] === "string"
    ) {
      next.environment = { ...next.environment };
      delete next.environment[previousKey];
    }
    setDraft(next);
  };
  const keys = [
    ...new Set([...saved.environmentKeys, ...Object.keys(current.environment)]),
  ].sort();
  const save = () => {
    setError("");
    void control.saveDefaults?.(current).then(
      (snapshot) => {
        setDraft(null);
        setNewKey("");
        setNewValue("");
        setEditSession((session) => session + 1);
        setNotice(savedMessage(snapshot.restarted, snapshot.restartFailures));
      },
      // The controller's sanitized reason: a save may already have committed
      // (e.g. Stop overtook its restart), so never claim nothing was saved.
      (problem: Error) => setError(problem.message),
    );
  };
  return (
    <section
      aria-labelledby="agent-defaults-title"
      className="mt-section-gap space-y-4"
    >
      <InlineHeader
        id="agent-defaults-title"
        title="Agent defaults"
        subtitle="Used when an agent starts without its own choices. Changes apply on its next start."
      />
      <SettingsGroup layout="form">
        <Select
          label="Default harness"
          variant="field"
          disabled={disabled}
          value={current.harness}
          groups={[{ label: "", options: harnesses }]}
          onValueChange={(harness) => {
            change({
              harness: harness as AgentDefaultsEdit["harness"],
              // Keep the provider, but clear values tied to the old harness.
              ...(harness === current.harness ? {} : { model: "", effort: "" }),
            });
          }}
        />
        <p className="m-0 text-body-sm text-secondary">
          Codex is selected per agent. Its Default mode uses the model and
          effort from the Codex CLI, so these device-wide defaults do not
          configure Codex.
        </p>
        <ProviderChoice
          current={current}
          state={state}
          models={models}
          disabled={disabled}
          editSession={editSession}
          onChange={(provider) => {
            change({
              provider,
              ...(provider === current.provider ? {} : { model: "" }),
            });
          }}
        />
        {gooseProvider === null && (
          <p role="status" className="m-0 text-body-sm text-secondary">
            A saved GOOSE_PROVIDER override has a hidden value. Replace or
            remove it under Environment variables to enter the matching API key
            here.
          </p>
        )}
        {apiKey && (
          <div className="space-y-2">
            <ProviderApiKeyField
              key={`${current.harness}-${current.provider}-${gooseProvider ?? ""}-${editSession}`}
              apiKey={apiKey}
              value={current.environment[apiKey.env]}
              saved={saved.environmentKeys.includes(apiKey.env)}
              disabled={disabled}
              emptyPlaceholder={
                current.harness === "pi"
                  ? "Paste API key or use an existing Pi sign-in"
                  : "Paste API key or use existing Goose credentials"
              }
              onChange={(value) => {
                const environment = { ...current.environment };
                if (value) environment[apiKey.env] = value;
                else delete environment[apiKey.env];
                change({ environment });
              }}
            />
            <p className="m-0 text-body-sm text-secondary">
              {apiKey.env} is used for model lookup and every local agent
              without its own value, including other harnesses. Leave blank to
              keep a saved key or use your{" "}
              {current.harness === "pi" ? "Pi sign-in" : "Goose credentials"}.
              Saved keys remain after provider changes; remove them under
              Environment variables. Saved values are never shown again.
            </p>
          </div>
        )}
        <ModelChoice
          control={control}
          state={state}
          current={current}
          disabled={disabled}
          editSession={editSession}
          onChange={change}
          onModels={setModels}
        />
        <DefaultsChoice
          label="Default effort"
          value={current.effort}
          choices={[
            { value: "", label: "Not set (use harness default)" },
            ...effortChoices[current.harness].map((value) => ({
              value,
              label:
                value === "xhigh"
                  ? "Extra high"
                  : value.charAt(0).toUpperCase() + value.slice(1),
            })),
          ]}
          disabled={disabled}
          resetKey={`${current.harness}-${editSession}`}
          onSelect={(effort) => change({ effort })}
          onCustom={(effort) => change({ effort })}
        />
        <Select
          label="Conversation context"
          variant="field"
          disabled={disabled}
          value={current.sessionPolicy}
          groups={[
            {
              label: "",
              options: [
                { value: "channel", label: "Entire channel" },
                { value: "thread", label: "Each thread" },
              ],
            },
          ]}
          onValueChange={(sessionPolicy) =>
            change({
              sessionPolicy:
                sessionPolicy as AgentDefaultsEdit["sessionPolicy"],
            })
          }
          description="Share one conversation across the channel, or keep threads separate. Direct messages stay shared."
        />
        <fieldset disabled={disabled} className="min-w-0 space-y-3">
          <legend className="mb-2 text-label-sm">Environment variables</legend>
          <p className="m-0 text-body-sm text-secondary">
            Added to every agent; an agent’s own key wins. Saved values stay on
            this device and are never shown again.
          </p>
          {keys.length > 0 && (
            <ul className={styles.rows}>
              {keys.map((key) => {
                const removed = current.environment[key] === null;
                return (
                  <li
                    key={key}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-body-sm"
                  >
                    <code className={`${styles.command} text-mono`}>{key}</code>
                    <span className="flex items-center gap-2">
                      <span className="text-secondary">
                        {removed
                          ? "Removed on save"
                          : typeof current.environment[key] === "string"
                            ? "Set on save"
                            : "Set"}
                      </span>
                      <Button
                        size="sm"
                        type="button"
                        aria-label={`${removed ? "Keep" : "Remove"} ${key}`}
                        onClick={() => {
                          const environment = { ...current.environment };
                          if (removed || !saved.environmentKeys.includes(key))
                            delete environment[key];
                          else environment[key] = null;
                          change({ environment });
                        }}
                      >
                        {removed ? "Keep" : "Remove"}
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <Accordion
            variant="form"
            keepMounted
            items={[
              {
                value: "add-variable",
                title: "Add environment variable",
                content: (
                  <div className="grid gap-3">
                    <Field label="Name">
                      <Input
                        ref={newKeyInput}
                        value={newKey}
                        spellCheck={false}
                        onChange={(event) =>
                          setNewKey(event.target.value.trim())
                        }
                      />
                    </Field>
                    <Field label="Value">
                      <Input
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={newValue}
                        onChange={(event) => setNewValue(event.target.value)}
                      />
                    </Field>
                    <div>
                      <Button
                        type="button"
                        disabled={!newKey}
                        onClick={() => {
                          change({
                            environment: {
                              ...current.environment,
                              [newKey]: newValue,
                            },
                          });
                          setNewKey("");
                          setNewValue("");
                          newKeyInput.current?.focus();
                        }}
                      >
                        Add variable
                      </Button>
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </fieldset>
        <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
          {(draft || newKey || newValue) && (
            <Button
              type="button"
              disabled={disabled}
              onClick={() => {
                setDraft(null);
                setNewKey("");
                setNewValue("");
                setEditSession((session) => session + 1);
              }}
            >
              Discard
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={disabled || !draft}
            onClick={save}
          >
            Save defaults
          </Button>
        </div>
        {notice && (
          <p role="status" className="m-0 text-body-sm">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-body-sm">
            {error}
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
