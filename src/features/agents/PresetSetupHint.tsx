/** Preserve inline command formatting in the shared, static setup guidance. */
export function PresetSetupHint({ hint }: { hint: string }) {
  return hint.split(/(`[^`]+`)/).map((part, index) => {
    if (!part.startsWith("`")) return part;
    // biome-ignore lint/suspicious/noArrayIndexKey: Static prose fragments have no item state; repeated commands need distinct keys.
    return <code key={index}>{part.slice(1, -1)}</code>;
  });
}
