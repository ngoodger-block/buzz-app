import type {
  ControlSnapshot,
  HarnessIntegration,
} from "../../features/agents/control";
import { harnessKind } from "./agent-edit";

type Options = ControlSnapshot["harnessOptions"];

/** Preserve the existing alias behavior for saved/custom Goose and Pi commands. */
export function harnessOption(
  options: Options,
  command: string,
  integration?: HarnessIntegration,
) {
  const kind = harnessKind(command);
  return (
    (integration
      ? options?.find((option) => option.id === integration)
      : undefined) ??
    options?.find((option) => option.command === command) ??
    (kind === "goose" || kind === "pi"
      ? options?.find((option) => harnessKind(option.command) === kind)
      : undefined)
  );
}

/** Consume native policy even for a saved absolute command. Never infer new integrations. */
export function harnessPolicy(
  options: Options,
  command: string,
  integration?: HarnessIntegration,
) {
  const owned = integration
    ? options?.find((option) => option.id === integration)
    : undefined;
  if (owned) return owned.configurationPolicy;
  const exact = options?.find((option) => option.command === command);
  if (exact) return exact.configurationPolicy;
  const kind = harnessKind(command);
  return kind
    ? options?.find((option) => harnessKind(option.command) === kind)
        ?.configurationPolicy
    : undefined;
}
