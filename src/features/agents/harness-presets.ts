import presets from "../../../crates/agent-controller/src/harness-presets.json";

// Metadata only. Discovery and selectable choices still come from native.
export const harnessPresets = presets;
const executableName = (command: string) =>
  command.replaceAll("\\", "/").split("/").at(-1);

export function isGoose(command: string): boolean {
  const name = executableName(command)?.replace(/\.exe$/, "");
  return name === "goose" || name === "goose-acp";
}

export function harnessPreset(command: string) {
  const name = executableName(command)?.replace(/\.(?:exe|cmd|bat)$/, "");
  return presets.find((preset) => preset.command === name);
}

export function harnessKind(command: string): string | undefined {
  if (executableName(command) === "buzz-agent") return "buzz-agent";
  if (isGoose(command)) return "goose";
  if (executableName(command) === "buzz-pi-acp") return "pi";
  return harnessPreset(command)?.id;
}
