export interface ExplorationTask {
  readonly id: string;
  readonly question: string;
  readonly search: { readonly query: string; readonly path: string };
  readonly evidence: readonly string[];
  readonly rubric: readonly string[];
  readonly expectNoMatches?: boolean;
}

export const TASK_SET_VERSION = 1;

/** Evidence/rubrics are evaluator metadata; live samplers receive only the question. */
export const explorationTasks: readonly ExplorationTask[] = [
  {
    id: 'target-permissions',
    question: 'How does external tool delegation enforce permissions on the actual target?',
    search: { query: 'delegat', path: 'src/tools' },
    evidence: ['src/tools/tool-bridge.ts', 'test/mcp/mcp.test.ts'],
    rubric: [
      'Wrapper permission is insufficient.',
      'Target validation, hooks and permission precede execution.',
      'Catalog changes during approval prevent stale dispatch.',
    ],
  },
  {
    id: 'deny-precedence',
    question:
      'Can always-approve bypass an explicit deny rule? Identify the decision and its test.',
    search: { query: 'deny', path: 'src/permissions' },
    evidence: [
      'src/permissions/permission-engine.ts',
      'test/permissions/permission-engine.test.ts',
    ],
    rubric: [
      'Deny wins over ask and allow.',
      'Always-approve does not override an explicit deny.',
      'Cite a relevant test.',
    ],
  },
  {
    id: 'checkpoint-reuse',
    question: 'How is a compaction checkpoint validated and reused in a later context build?',
    search: { query: 'checkpoint', path: 'src/context' },
    evidence: ['src/context/context-source.ts', 'src/context/context-builder.ts'],
    rubric: [
      'Covered turn IDs must match a terminal session prefix.',
      'The summary replaces only the model-facing historical prefix.',
      'Original turns remain in Session.',
    ],
  },
  {
    id: 'required-context',
    question: 'What happens when the active turn and required context exceed the input budget?',
    search: { query: 'inputLimit', path: 'src/context' },
    evidence: ['src/context/context-builder.ts', 'test/context/context-engine.test.ts'],
    rubric: [
      'Output reserve reduces the input allowance.',
      'Required-context overflow fails explicitly.',
      'Historical pruning cannot discard the active turn.',
    ],
  },
  {
    id: 'interrupted-call',
    question: 'How does resume handle an interrupted tool call whose execution result is unknown?',
    search: { query: 'execution_unknown', path: 'src/session' },
    evidence: ['src/session/session-history.ts', 'src/runtime/session-runtime.ts'],
    rubric: [
      'Interrupted turns are recovered explicitly.',
      'Missing results receive execution-unknown records.',
      'The tool is not replayed and success is not inferred.',
    ],
  },
  {
    id: 'rewind-checkpoint',
    question: 'What does rewinding a session do to usage, checkpoints and external side effects?',
    search: { query: 'rewind', path: 'src/session' },
    evidence: ['src/session/session-history.ts', 'test/session/file-session-store.test.ts'],
    rubric: [
      'Removed-turn usage is removed.',
      'A checkpoint covering removed turns is invalidated.',
      'External effects are not undone.',
    ],
  },
  {
    id: 'skill-selection',
    question:
      'Which skill wins a project/user name collision, and can old tool output invoke a skill?',
    search: { query: 'project', path: 'src/skills' },
    evidence: [
      'src/skills/skills-source.ts',
      'src/skills/skill-selector.ts',
      'test/skills/skills-source.test.ts',
    ],
    rubric: [
      'Project skill takes precedence.',
      'Explicit invocation is taken from the active user message.',
      'Historical tool output cannot invoke skills.',
    ],
  },
  {
    id: 'workspace-containment',
    question:
      'How are workspace file reads constrained when a path contains symlinks or traversal?',
    search: { query: 'realpath', path: 'src/workspace' },
    evidence: ['src/workspace/local-file-system.ts', 'test/workspace/local-file-system.test.ts'],
    rubric: [
      'Lexical and canonical containment are checked.',
      'Out-of-root paths fail intentionally.',
      'Path containment is not an OS sandbox.',
    ],
  },
  {
    id: 'search-bounds',
    question:
      'What limits literal code search, and does a truncated result prove no other matches exist?',
    search: { query: 'truncated', path: 'src/tools' },
    evidence: ['src/tools/builtin/search-text.tool.ts', 'test/tools/search-text-tool.test.ts'],
    rubric: [
      'Match, visited-entry and snippet bounds exist.',
      'Results identify truncation.',
      'Truncated search is not exhaustive.',
    ],
  },
  {
    id: 'absent-vector-index',
    question:
      'Within this supplied fixture corpus, is there evidence of a VectorIndex implementation? Explain the limits of an absence claim.',
    search: { query: 'VectorIndex', path: 'src' },
    evidence: ['src/context/context-builder.ts'],
    expectNoMatches: true,
    rubric: [
      'No matching implementation is present in the fixture.',
      'Bound the conclusion to the inspected corpus.',
      'Do not invent an implementation or infer absence from a failed/truncated search.',
    ],
  },
];

export const fixturePaths = [
  'AGENTS.md',
  ...new Set(explorationTasks.flatMap((task) => task.evidence)),
].sort();
