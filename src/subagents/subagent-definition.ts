export const SUBAGENT_ROLES = ['explore', 'plan', 'review'] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

/** Parent-only delegation tools; never offered to a child, which keeps nesting depth at 1. */
export const SUBAGENT_TOOL_NAMES = ['delegate_task', 'await_subagent', 'cancel_subagent'] as const;

/** Immutable description of one child role; execution belongs to SubagentRunner. */
export interface SubagentRoleDefinition {
  readonly role: SubagentRole;
  readonly description: string;
  readonly instructions: string;
  /** Exact tool names the child may be offered; each must be a native read tool. */
  readonly tools: readonly string[];
  readonly maxIterations: number;
}

const READ_TOOLS = ['read_file', 'list_files', 'search_text'] as const;

const SHARED_INSTRUCTIONS =
  'You are a read-only subagent working for a parent agent. You cannot modify files, run commands or delegate further. Tool paths are relative to the workspace root. Your final answer is returned to the parent as your report: make it self-contained and concise, cite workspace paths (with line numbers when useful) for every claim, and say plainly what you could not verify.';

export const SUBAGENT_ROLE_DEFINITIONS: Readonly<Record<SubagentRole, SubagentRoleDefinition>> = {
  explore: {
    role: 'explore',
    description: 'Find where and how something is implemented and summarize the evidence.',
    instructions: `${SHARED_INSTRUCTIONS} Role: explore. Locate the relevant files, read only what is needed, and report the answer with the supporting paths.`,
    tools: READ_TOOLS,
    maxIterations: 8,
  },
  plan: {
    role: 'plan',
    description: 'Study the code and propose an ordered implementation plan without changing it.',
    instructions: `${SHARED_INSTRUCTIONS} Role: plan. Inspect the affected code, then report an ordered list of concrete steps naming the files to change, the risks and how to verify the result.`,
    tools: READ_TOOLS,
    maxIterations: 8,
  },
  review: {
    role: 'review',
    description: 'Review the named code for correctness problems and report findings.',
    instructions: `${SHARED_INSTRUCTIONS} Role: review. Read the code under review and report concrete defects ordered by severity, each with its path, line and a failure scenario. Report "no findings" rather than speculating.`,
    tools: READ_TOOLS,
    maxIterations: 6,
  },
};

export function isSubagentRole(value: unknown): value is SubagentRole {
  return typeof value === 'string' && (SUBAGENT_ROLES as readonly string[]).includes(value);
}
