const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Count characters the way a person sees them (grapheme clusters), not UTF-16 code units. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive match that also works for multi-word phrases. */
export function containsTerm(text: string, term: string): boolean {
  if (!term.trim()) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(term)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

export function findTerms(text: string, terms: string[]): string[] {
  return terms.filter((t) => containsTerm(text, t));
}

/** Levenshtein distance between two strings. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length]!;
}

/** How much a person changed the AI text: 0 = unchanged, 1 = fully rewritten. */
export function editRatio(before: string, after: string): number {
  const longest = Math.max(before.length, after.length);
  return longest === 0 ? 0 : Math.round((distance(before, after) / longest) * 100) / 100;
}
