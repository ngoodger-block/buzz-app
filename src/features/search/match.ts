const isWordChar = (char: string | undefined) =>
  /[\p{L}\p{N}]/u.test(char ?? "");

/** How well a label matches typed text: exact, then prefix, then word start,
 * then any substring, then a fuzzy match whose letters each continue a run
 * that began at a word start ("bgp" in "buzz-github-prs"), then any fuzzy
 * match (the letters appear in order). Lower is better; undefined means no
 * match. Ranks are whole numbers, so callers can add fractional tie-breaks.
 * `positions` are the matched code points of the label, for underlining. */
export function matchName(
  label: string,
  needle: string,
): { rank: number; positions: number[] } | undefined {
  const text = label.toLowerCase();
  const chars = [...text];
  // Lowercasing can change a label's length (İ → i̇). Rank it, but do not
  // underline positions that would land on the wrong letters.
  const aligned = chars.length === [...label].length;
  const found = (rank: number, positions: number[]) => ({
    rank,
    positions: aligned ? positions : [],
  });
  const run = (at: number) => {
    const from = [...text.slice(0, at)].length;
    return Array.from({ length: [...needle].length }, (_, n) => from + n);
  };
  if (text === needle) return found(0, run(0));
  let substring: number | undefined;
  for (
    let at = text.indexOf(needle);
    at >= 0;
    at = text.indexOf(needle, at + 1)
  ) {
    if (at === 0) return found(1, run(0));
    if (!isWordChar(text[at - 1])) return found(2, run(at));
    substring ??= at;
  }
  if (substring !== undefined) return found(3, run(substring));
  // Spaces in typed text only separate words; they need not match.
  const letters = [...needle.replace(/\s+/g, "")];
  if (!letters.length) return undefined;
  // Can letters[i..] match chars[j..] with every run starting at a word start?
  // `inRun` means the previous letter matched chars[j - 1].
  const memo = new Map<number, boolean>();
  const takes = (i: number, j: number, inRun: boolean) =>
    chars[j] === letters[i] &&
    (inRun || !isWordChar(chars[j - 1])) &&
    wordRuns(i + 1, j + 1, true);
  const wordRuns = (i: number, j: number, inRun: boolean): boolean => {
    if (i === letters.length) return true;
    if (j === chars.length) return false;
    const key = (i * (chars.length + 1) + j) * 2 + (inRun ? 1 : 0);
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result = takes(i, j, inRun) || wordRuns(i, j + 1, false);
    memo.set(key, result);
    return result;
  };
  if (wordRuns(0, 0, false)) {
    // Replay the same choices the search made: take a letter when it leads
    // to a full match, otherwise skip the character.
    const positions: number[] = [];
    for (let i = 0, j = 0, inRun = false; i < letters.length; j += 1) {
      inRun = takes(i, j, inRun);
      if (inRun) {
        positions.push(j);
        i += 1;
      }
    }
    return found(4, positions);
  }
  const positions: number[] = [];
  chars.forEach((char, j) => {
    if (char === letters[positions.length]) positions.push(j);
  });
  return positions.length === letters.length ? found(5, positions) : undefined;
}

export const matchRank = (label: string, needle: string) =>
  matchName(label, needle)?.rank;

// Lowercasing a whole word turns a final Σ into ς, but one letter at a time
// gives σ; treat them as one letter so both sides agree.
const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ");

/** `matchName` on text without accents, the way the people directory
 * searches: "jose" matches José exactly. Positions are the label's own code
 * points, so the underline lands on the accented letters. */
export function matchFolded(label: string, needle: string) {
  const origin: number[] = [];
  let folded = "";
  [...label].forEach((char, index) => {
    for (const piece of fold(char)) {
      folded += piece;
      origin.push(index);
    }
  });
  const match = matchName(folded, fold(needle));
  return (
    match && {
      rank: match.rank,
      positions: [
        ...new Set(match.positions.flatMap((at) => origin[at] ?? [])),
      ],
    }
  );
}
