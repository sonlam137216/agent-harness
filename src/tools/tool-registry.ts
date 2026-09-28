import type { Tool } from './tool.interface.js';
import type { ModelToolDefinition } from './tool-types.js';

export class DuplicateToolNameError extends Error {
  public override readonly name = 'DuplicateToolNameError';

  public constructor(public readonly toolName: string) {
    super(`A tool named "${toolName}" is already registered.`);
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  readonly #hidden = new Set<string>();

  public register(tool: Tool, options: { hidden?: boolean } = {}): void {
    const { name } = tool.definition;
    if (this.#tools.has(name)) {
      throw new DuplicateToolNameError(name);
    }

    this.#tools.set(name, tool);
    if (options.hidden) this.#hidden.add(name);
  }

  public get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  public isHidden(name: string): boolean {
    return this.#hidden.has(name);
  }

  /** Validate first, then publish a complete external generation synchronously. */
  public replaceHidden(previous: readonly string[], tools: readonly Tool[]): void {
    const names = new Set<string>();
    for (const tool of tools) {
      const name = tool.definition.name;
      if (names.has(name) || (this.#tools.has(name) && !previous.includes(name)))
        throw new DuplicateToolNameError(name);
      if (tool.definition.origin !== 'external' || tool.resolveInvocation !== undefined)
        throw new TypeError('Hidden targets must be external leaf tools.');
      names.add(name);
    }
    for (const name of previous) {
      if (!this.#hidden.has(name)) throw new TypeError('Cannot replace a visible tool.');
    }
    for (const name of previous) {
      this.#tools.delete(name);
      this.#hidden.delete(name);
    }
    for (const tool of tools) this.register(tool, { hidden: true });
  }

  public getModelDefinitions(): readonly ModelToolDefinition[] {
    return Array.from(this.#tools.values())
      .filter(({ definition }) => !this.#hidden.has(definition.name))
      .map(({ definition }) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }));
  }
}
