/** Small deterministic BM25 index; schemas do not affect ranking. */
export class ToolIndex {
  private readonly documents: readonly {
    name: string;
    words: string[];
    frequencies: Map<string, number>;
  }[];
  private readonly counts = new Map<string, number>();
  private readonly average: number;
  constructor(entries: readonly { name: string; description: string }[]) {
    this.documents = entries.map((entry) => {
      const words = tokenize(`${entry.name} ${entry.description}`);
      const frequencies = new Map<string, number>();
      for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      for (const word of frequencies.keys())
        this.counts.set(word, (this.counts.get(word) ?? 0) + 1);
      return { name: entry.name, words, frequencies };
    });
    this.average =
      this.documents.reduce((sum, doc) => sum + doc.words.length, 0) / (entries.length || 1) || 1;
  }
  search(query: string): readonly string[] {
    const terms = [...new Set(tokenize(query))];
    return this.documents
      .map((doc) => ({
        name: doc.name,
        score: terms.reduce((score, term) => {
          const frequency = doc.frequencies.get(term) ?? 0;
          const count = this.counts.get(term) ?? 0;
          const idf = Math.log(1 + (this.documents.length - count + 0.5) / (count + 0.5));
          return (
            score +
            (idf * frequency * 2.2) /
              (frequency + 1.2 * (0.25 + (0.75 * doc.words.length) / this.average))
          );
        }, 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((item) => item.name);
  }
}
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
}
