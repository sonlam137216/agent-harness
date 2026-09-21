import { ContextError } from '../context/context-budget.js';
import { isSkillName, type Skill } from './skill-parser.js';

export interface SkillSelection {
  readonly explicit: readonly Skill[];
  readonly automatic: readonly Skill[];
}

/** Invocation is a whitespace-delimited $name, optionally followed by sentence punctuation. */
export function explicitSkillNames(prompt: string): readonly string[] {
  const names = [...prompt.matchAll(/(?:^|\s)\$([a-z][a-z0-9-]*)(?=$|\s|[.,;:!?])/gu)].map(
    (match) => match[1]!,
  );
  if (names.some((name) => !isSkillName(name)))
    throw new ContextError('source_failed', 'Invalid explicit skill name.');
  return [...new Set(names)];
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'from',
  'have',
  'into',
  'that',
  'their',
  'them',
  'then',
  'these',
  'this',
  'use',
  'using',
  'when',
  'with',
  'your',
  'skill',
  'please',
]);

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/gu) ?? []).filter((word) => !STOP_WORDS.has(word)),
  );
}

export function selectSkills(
  skills: readonly Skill[],
  prompt: string,
  automatic = false,
): SkillSelection {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const explicit = explicitSkillNames(prompt).map((name) => {
    const skill = byName.get(name);
    if (skill === undefined)
      throw new ContextError('source_failed', 'An explicitly requested skill was not found.');
    return skill;
  });
  if (!automatic) return { explicit, automatic: [] };
  const selected = new Set(explicit.map((skill) => skill.name));
  const promptWords = words(prompt);
  const ranked = skills
    .filter((skill) => !selected.has(skill.name))
    .map((skill) => ({
      skill,
      score: [...words(`${skill.name} ${skill.description}`)].filter((word) =>
        promptWords.has(word),
      ).length,
    }))
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return { explicit, automatic: ranked.slice(0, 3).map(({ skill }) => skill) };
}
