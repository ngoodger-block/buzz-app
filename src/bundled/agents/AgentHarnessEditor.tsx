import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useState } from "react";
import type { ControlSnapshot } from "../../features/agents/control";
import { PI_API_KEYS, type AgentDraft } from "./agent-edit";
import { harnessOption, harnessPolicy } from "./harness-policy";

/** Choices come from the injected native snapshot, never a plugin runtime catalog. */
export function AgentHarnessEditor({
  draft,
  options,
  defaultProvider,
  piProviders = [],
  onChange,
  onProviderSelected,
  onOpenHarnesses,
  discardEdits = false,
  disabled = false,
}: {
  draft: AgentDraft;
  onOpenHarnesses?: (() => void) | undefined;
  discardEdits?: boolean;
  piProviders?: string[] | null;
  options: NonNullable<ControlSnapshot["harnessOptions"]>;
  disabled?: boolean;
  defaultProvider?: string | undefined;
  onChange(patch: Partial<AgentDraft>): void;
  onProviderSelected?(): void;
}) {
  const harness = harnessOption(options, draft.command, draft.integration);
  const policy = harnessPolicy(options, draft.command, draft.integration);
  // Missing policy preserves older hosts; native policy wins whenever supplied.
  const external = policy
    ? policy.authentication === "harnessWithOverrides"
    : harness?.label === "Goose" || harness?.label === "Pi";
  const discoveredProviders = policy
    ? policy.provider === "discovered"
    : harness?.label === "Pi";
  const piLoading = discoveredProviders && piProviders === null;
  const missingPi = options.some(
    (option) => option.label === "Pi" && option.available === false,
  );
  return (
    <div className="space-y-4">
      <ConfigChoice
        disabled={disabled}
        label="Harness"
        customLabel="Custom executable / current value"
        inputLabel="Executable"
        value={draft.command}
        options={options.map(({ command, label, available, id }) => ({
          value: command,
          label:
            available === false && id === "codex"
              ? `${label} (coming in a later update)`
              : available === false
                ? `${label} (install first)`
                : label,
          disabled: available === false,
        }))}
        onChange={(command, pickedOption) => {
          const option = options.find((item) => item.command === command);
          const enteringExternal = option?.configurationPolicy
            ? option.configurationPolicy.authentication ===
              "harnessWithOverrides"
            : option?.label === "Goose" || option?.label === "Pi";
          onChange({
            command,
            ...(pickedOption
              ? { integration: option?.id }
              : { integration: undefined, configuration: undefined }),
            ...(pickedOption && (enteringExternal || external)
              ? {
                  args: JSON.stringify(option?.defaultArgs ?? []),
                  provider: enteringExternal
                    ? ""
                    : (option?.providers[0]?.value ?? ""),
                  model: "",
                }
              : {}),
            ...(pickedOption && option?.id === "codex"
              ? {
                  args: "[]",
                  provider: "",
                  model: "",
                  configuration: { mode: "default" },
                }
              : pickedOption && draft.integration === "codex"
                ? { configuration: undefined }
                : {}),
          });
        }}
      />
      {missingPi && (
        <p className="text-body-sm text-secondary">
          Pi needs its CLI, Node.js and buzz-pi-acp before you can select it.
        </p>
      )}
      {missingPi && onOpenHarnesses && (
        <div className="space-y-1">
          <Button
            type="button"
            variant="link"
            disabled={disabled}
            onClick={onOpenHarnesses}
          >
            Open Harnesses in Settings
          </Button>
          {discardEdits && (
            <p className="m-0 text-body-sm text-secondary">
              Opening Settings discards unsaved edits.
            </p>
          )}
        </div>
      )}
      {policy?.provider !== "external" && (
        <ConfigChoice
          disabled={disabled || piLoading}
          key={harness?.label ?? draft.command}
          label={external ? "LLM Provider" : "Provider"}
          customLabel="Custom provider / current value"
          inputLabel="Custom provider"
          value={draft.provider}
          options={[
            {
              value: "",
              label: defaultProvider
                ? `Use agent defaults (${defaultProvider})`
                : "Not set",
            },
            ...(discoveredProviders
              ? piOptions(piProviders, draft.provider)
              : (harness?.providers ?? [])),
          ]}
          onChange={(provider, pickedOption) => {
            onChange({
              provider,
              ...(external ? { model: "" } : {}),
            });
            if (pickedOption) onProviderSelected?.();
          }}
        />
      )}
      {piLoading && (
        <p role="status" className="text-body-sm text-secondary">
          Loading signed-in providers…
        </p>
      )}
    </div>
  );
}

// Pi lists providers its catalog reports as signed in, then the providers
// someone can sign in to here with an API key. While the catalog loads, keep
// a current custom choice listed so the selection stays put.
function piOptions(signedIn: string[] | null, current: string) {
  const known = signedIn ?? (current && !PI_API_KEYS[current] ? [current] : []);
  const label = (value: string) => PI_API_KEYS[value]?.label ?? value;
  return [
    ...known.map((value) => ({ value, label: label(value) })),
    ...Object.keys(PI_API_KEYS)
      .filter((value) => !known.includes(value))
      .map((value) => ({ value, label: `${label(value)} (API key needed)` })),
  ];
}

function ConfigChoice({
  label,
  customLabel,
  inputLabel,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  customLabel: string;
  inputLabel: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange(value: string, pickedOption: boolean): void;
}) {
  // Custom is an editing mode, not a saved value. Entering it never erases data.
  const [custom, setCustom] = useState(false);
  const index = options.findIndex((option) => option.value === value);
  const showInput = custom || index < 0;
  return (
    <div className="min-w-0 space-y-3">
      <Select
        label={label}
        variant="field"
        disabled={disabled}
        value={showInput ? "custom" : String(index)}
        groups={[
          {
            label: "",
            options: [
              ...options.map((option, i) => ({
                value: String(i),
                label: option.label,
                disabled: option.disabled ?? false,
              })),
              { value: "custom", label: customLabel },
            ],
          },
        ]}
        onValueChange={(selected) => {
          setCustom(selected === "custom");
          if (selected !== "custom") {
            const option = options[Number(selected)];
            if (option) onChange(option.value, true);
          }
        }}
      />
      {showInput && (
        <Field label={inputLabel}>
          <Input
            disabled={disabled}
            value={value}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value, false)}
          />
        </Field>
      )}
    </div>
  );
}
