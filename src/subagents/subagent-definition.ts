export const SUBAGENT_ROLES = ['explore', 'plan', 'review', 'implement'] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

/** Parent-only delegation tools; never offered to a child, which keeps nesting depth at 1. */
export const SUBAGENT_TOOL_NAMES = ['delegate_task', 'await_subagent', 'cancel_subagent'] as const;

/** Immutable description of one child role; execution belongs to SubagentRunner. */
export interface SubagentRoleDefinition {
  readonly role: SubagentRole;
  readonly description: string;
  readonly instructions: string;
  /** Exact tool names the child may be offered; write tools only for worktree roles. */
  readonly tools: readonly string[];
  readonly maxIterations: number;
  /** `worktree` roles run in a disposable Git worktree and are offered only when one exists. */
  readonly workspace: 'shared' | 'worktree';
}

export type SubagentErrorCode =
  'subagent_limit' | 'subagent_busy' | 'unknown_subagent' | 'closed' | 'worktree_unavailable';

export class SubagentError extends Error {
  public override readonly name = 'SubagentError';
  public constructor(
    public readonly code: SubagentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const READ_TOOLS = ['read_file', 'list_files', 'search_text'] as const;

const REPORTING =
  'Tool paths are relative to the workspace root. Your final answer is returned to the parent as your report: make it self-contained and concise, cite workspace paths (with line numbers when useful) for every claim, and say plainly what you could not verify.';
const SHARED_INSTRUCTIONS = `You are a read-only subagent working for a parent agent. You cannot modify files, run commands or delegate further. ${REPORTING}`;

export const SUBAGENT_ROLE_DEFINITIONS: Readonly<Record<SubagentRole, SubagentRoleDefinition>> = {
  explore: {
    role: 'explore',
    description: 'Find where and how something is implemented and summarize the evidence.',
    instructions: `${SHARED_INSTRUCTIONS} Role: explore. Locate the relevant files, read only what is needed, and report the answer with the supporting paths.`,
    tools: READ_TOOLS,
    maxIterations: 8,
    workspace: 'shared',
  },
  plan: {
    role: 'plan',
    description: 'Study the code and propose an ordered implementation plan without changing it.',
    instructions: `${SHARED_INSTRUCTIONS} Role: plan. Inspect the affected code, then report an ordered list of concrete steps naming the files to change, the risks and how to verify the result.`,
    tools: READ_TOOLS,
    maxIterations: 8,
    workspace: 'shared',
  },
  review: {
    role: 'review',
    description: 'Review the named code for correctness problems and report findings.',
    instructions: `${SHARED_INSTRUCTIONS} Role: review. Read the code under review and report concrete defects ordered by severity, each with its path, line and a failure scenario. Report "no findings" rather than speculating.`,
    tools: READ_TOOLS,
    maxIterations: 6,
    workspace: 'shared',
  },
  implement: {
    role: 'implement',
    description:
      'Make a code change in an isolated Git worktree; the user reviews and applies it later.',
    instructions: `You are a subagent working for a parent agent inside an isolated Git worktree checked out from the repository's last commit; uncommitted changes in the main working tree are not present. You can read files and change them with write_file and edit_file. If run_command is available, use it to run the project's tests or build (it runs one program without a shell, with no network, and can write only inside the worktree); otherwise you cannot run commands. You cannot delegate further. When you finish, your changes are committed to a separate branch and reach the user's working tree only if the user applies them. Make the smallest change that completes the task and keep existing style. ${REPORTING} List every file you changed and why.`,
    tools: [...READ_TOOLS, 'write_file', 'edit_file', 'run_command'],
    maxIterations: 12,
    workspace: 'worktree',
  },
};

export function isSubagentRole(value: unknown): value is SubagentRole {
  return typeof value === 'string' && (SUBAGENT_ROLES as readonly string[]).includes(value);
}
