import "./MatchedLabel.css";

/** A label with its matched letters underlined. The text stays whole, so the
 * row's accessible name does not change. */
export function MatchedLabel({
  label,
  positions,
}: {
  label: string;
  positions: readonly number[] | undefined;
}) {
  if (!positions?.length) return label;
  const marked = new Set(positions);
  const runs: { text: string; match: boolean }[] = [];
  [...label].forEach((char, index) => {
    const match = marked.has(index);
    const last = runs.at(-1);
    if (last?.match === match) last.text += char;
    else runs.push({ text: char, match });
  });
  return runs.map(({ text, match }, index) =>
    match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional.
      <mark key={index} className="search-match">
        {text}
      </mark>
    ) : (
      text
    ),
  );
}
