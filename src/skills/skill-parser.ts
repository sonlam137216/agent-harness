import { ContextError } from '../context/context-budget.js';

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export function isSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name);
}

function invalid(): never {
  throw new ContextError(
    'source_failed',
    'Invalid SKILL.md: use name and description string fields and a non-empty Markdown body.',
    { cause: new Error('invalid_skill_format') },
  );
}

/** Deliberately a small frontmatter subset, not a general YAML interpreter. */
export function parseSkill(content: string): Skill {
  const lines = content
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n/gu, '\n')
    .split('\n');
  if (lines[0] !== '---') invalid();
  const end = lines.indexOf('---', 1);
  if (end < 0) invalid();
  const fields = new Map<string, string>();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '' || line.startsWith('#')) continue;
    const match = /^(name|description):[ \t]*(.*)$/u.exec(line);
    if (match === null) invalid();
    const key = match[1]!;
    let value = match[2]!.trim();
    if (fields.has(key)) invalid();
    if (/^[>|]-?$/u.test(value)) {
      const folded = value.startsWith('>');
      const block: string[] = [];
      while (index + 1 < end && /^(?: {2}|\s*$)/u.test(lines[index + 1]!)) {
        const next = lines[++index]!;
        block.push(next.trim() === '' ? '' : next.slice(2));
      }
      value = block.join(folded ? ' ' : '\n').trim();
    } else if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed !== 'string') invalid();
        value = parsed;
      } catch {
        invalid();
      }
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/u.test(value)) invalid();
      value = value.slice(1, -1).replace(/''/gu, "'");
    } else if (/^[!&*[{>|%@`]|\s#|:\s/u.test(value)) {
      // Reject YAML features that this parser cannot interpret faithfully.
      invalid();
    }
    if (value.trim() === '') invalid();
    fields.set(key, value.trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (name === undefined || !isSkillName(name) || description === undefined || body === '')
    invalid();
  return { name, description, body };
}
