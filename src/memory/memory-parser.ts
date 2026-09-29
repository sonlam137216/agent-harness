export interface MemoryEntry {
  /** Level-2 heading text, or an empty string for text before the first heading. */
  readonly title: string;
  /** Complete entry text, including its heading line. */
  readonly content: string;
  /** One-based inclusive line range within the source file. */
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Splits Markdown into entries at `## ` headings so one file can hold many
 * independent notes. Text before the first heading forms one untitled entry.
 * Headings inside fenced code blocks do not split. Blank entries are dropped.
 */
export function parseMemoryEntries(content: string): MemoryEntry[] {
  const lines = content.replace(/^﻿/u, '').split(/\r?\n/u);
  const entries: MemoryEntry[] = [];
  let start = 0;
  let title = '';
  let fenced = false;
  const close = (end: number) => {
    const text = lines.slice(start, end).join('\n');
    if (text.trim() === '') return;
    // Report the range without surrounding blank lines.
    let first = start;
    let last = end - 1;
    while (lines[first]!.trim() === '') first += 1;
    while (lines[last]!.trim() === '') last -= 1;
    entries.push({
      title,
      content: lines.slice(first, last + 1).join('\n'),
      startLine: first + 1,
      endLine: last + 1,
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s{0,3}(?:```|~~~)/u.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^## +(.+?)\s*#*\s*$/u.exec(line);
    if (heading === null) continue;
    close(index);
    start = index;
    title = heading[1]!.trim();
  }
  close(lines.length);
  return entries;
}
