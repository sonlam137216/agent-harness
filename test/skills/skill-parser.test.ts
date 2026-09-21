import { describe, expect, it } from 'vitest';
import { parseSkill } from '../../src/skills/skill-parser.js';
import { explicitSkillNames, selectSkills } from '../../src/skills/skill-selector.js';

describe('skill format and selection', () => {
  it.each([
    'description: Review code changes.',
    'description: "Review code changes."',
    "description: 'Review code changes.'",
    'description: >-\n  Review code\n  changes.',
  ])('parses the supported string format: %s', (description) => {
    expect(
      parseSkill(`\uFEFF---\r\nname: review\r\n${description}\r\n---\r\n# Steps\r\nRead files.`),
    ).toEqual({
      name: 'review',
      description: 'Review code changes.',
      body: '# Steps\nRead files.',
    });
  });

  it('supports literal descriptions and escaped quotes', () => {
    expect(
      parseSkill('---\nname: test\ndescription: |\n  First\n  Second\n---\nRun.').description,
    ).toBe('First\nSecond');
    expect(parseSkill("---\nname: test\ndescription: 'It''s a test'\n---\nRun.").description).toBe(
      "It's a test",
    );
  });

  it.each([
    'name: test\ndescription: missing fences',
    '---\nname: test\ndescription: missing closing fence',
    '---\nname: test\n---\nBody',
    '---\nname: ../escape\ndescription: test\n---\nBody',
    '---\nname: test\nname: other\ndescription: test\n---\nBody',
    '---\nname: test\ndescription: [nested]\n---\nBody',
    '---\nname: test\ndescription: &anchor test\n---\nBody',
    '---\nname: test\ndescription: "unterminated\n---\nBody',
    '---\nname: test\ndescription: test\nallowed-tools: run_command\n---\nBody',
    '---\nname: test\ndescription: test\n---\n  ',
    '---\nname: test\ndescription: >\n---\nBody',
  ])('rejects malformed or unsupported frontmatter without echoing contents', (content) => {
    expect(() => parseSkill(content)).toThrow('Invalid SKILL.md');
    try {
      parseSkill(content);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'source_failed',
        cause: { message: 'invalid_skill_format' },
      });
    }
  });

  const skills = [
    { name: 'review', description: 'Review code changes', body: 'private workflow body' },
    { name: 'test', description: 'Run focused tests', body: 'review code changes' },
  ];

  it('deduplicates explicit invocations and never silently ignores a missing skill', () => {
    expect(explicitSkillNames('$review check this with $test. $review')).toEqual([
      'review',
      'test',
    ]);
    expect(
      explicitSkillNames('price $10.00 and prefix$review and $HOME and $review/other'),
    ).toEqual([]);
    expect(selectSkills(skills, '$test $review').explicit.map((skill) => skill.name)).toEqual([
      'test',
      'review',
    ]);
    expect(() => selectSkills(skills, '$missing')).toThrow('not found');
  });

  it('is opt-in and scores only metadata, with deterministic ordering and a three-skill cap', () => {
    expect(selectSkills(skills, 'Review code changes')).toEqual({ explicit: [], automatic: [] });
    expect(selectSkills(skills, 'Review code changes', true).automatic).toEqual([skills[0]]);
    expect(selectSkills(skills, '$review review code changes', true).automatic).toEqual([]);
    expect(selectSkills(skills, 'review', true).automatic).toEqual([]);
    const many = ['z', 'b', 'a', 'd'].map((name) => ({
      name,
      description: 'Review code',
      body: 'workflow',
    }));
    expect(selectSkills(many, 'Review code', true).automatic.map((skill) => skill.name)).toEqual([
      'a',
      'b',
      'd',
    ]);
  });
});
