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

  public register(tool: Tool): void {
    const { name } = tool.definition;
    if (this.#tools.has(name)) {
      throw new DuplicateToolNameError(name);
    }

    this.#tools.set(name, tool);
  }

  public get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  public getModelDefinitions(): readonly ModelToolDefinition[] {
    return Array.from(this.#tools.values(), ({ definition }) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }));
  }
}
