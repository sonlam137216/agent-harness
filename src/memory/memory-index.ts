const STOP_WORDS = new Set(
  'a an and are as at be by can do does for from how i in is it of on or please that the their this to use was we what when where which why with would you'.split(
    ' ',
  ),
);

/** Lowercase identifier-aware terms; camelCase and snake_case split into words. */
export function memoryTerms(text: string): string[] {
  return (
    text
      .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
      .toLowerCase()
      .match(/[a-z][a-z\d]{1,63}/gu) ?? []
  ).filter((word) => !STOP_WORDS.has(word));
}

export interface RankedMemory {
  readonly index: number;
  readonly score: number;
}

/**
 * Deterministic in-memory BM25 over memory entries (k1 = 1.2, b = 0.75).
 * Rebuilt per search; a persistent FTS index is deferred until corpus size needs it.
 */
export function rankMemories(documents: readonly string[], query: string): RankedMemory[] {
  const terms = [...new Set(memoryTerms(query))];
  if (terms.length === 0 || documents.length === 0) return [];
  const docs = documents.map((text) => {
    const words = memoryTerms(text);
    const frequencies = new Map<string, number>();
    for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    return { length: words.length, frequencies };
  });
  const documentCounts = new Map<string, number>();
  for (const doc of docs)
    for (const word of doc.frequencies.keys())
      documentCounts.set(word, (documentCounts.get(word) ?? 0) + 1);
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  return docs
    .map((doc, index) => ({
      index,
      score: terms.reduce((score, term) => {
        const frequency = doc.frequencies.get(term) ?? 0;
        if (frequency === 0) return score;
        const count = documentCounts.get(term)!;
        const idf = Math.log(1 + (docs.length - count + 0.5) / (count + 0.5));
        return (
          score +
          (idf * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * doc.length) / average))
        );
      }, 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
