import { SpanStatusCode } from '@opentelemetry/api';
import {
  checkContextCancellation,
  ContextError,
  positiveInteger,
} from '../context/context-budget.js';
import type {
  ContextContribution,
  ContextSource,
  ContextSourceInput,
} from '../context/context-source.js';
import { SamplingError } from '../model/sampling-types.js';
import type { TracingHandle } from '../observability/tracing.js';
import { FileSystemError, type FileSystemCapability } from '../workspace/filesystem-capability.js';
import { parseSkill, type Skill } from './skill-parser.js';
import { selectSkills } from './skill-selector.js';

export interface SkillRoot {
  readonly scope: 'user' | 'project';
  readonly files: FileSystemCapability;
  readonly directory: string;
}

export interface SkillsOptions {
  readonly automatic?: boolean;
  readonly maxSkills?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
}

interface DiscoveredSkill extends Skill {
  readonly scope: SkillRoot['scope'];
  readonly path: string;
}

export class SkillsSource implements ContextSource {
  public readonly name = 'skills';
  readonly #roots: readonly SkillRoot[];
  readonly #maxSkills: number;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #automatic: boolean;

  public constructor(
    roots: readonly SkillRoot[],
    private readonly tracer: TracingHandle['tracer'],
    options: SkillsOptions = {},
  ) {
    const scopes = new Set<string>();
    for (const root of roots) {
      if (scopes.has(root.scope)) throw new RangeError('Provide only one skill root per scope.');
      scopes.add(root.scope);
      if (
        !root.directory ||
        root.directory.startsWith('/') ||
        /[\\:\0]/u.test(root.directory) ||
        root.directory.split('/').includes('..')
      )
        throw new RangeError('Skill directories must stay within their filesystem root.');
    }
    this.#roots = roots
      .map((root) => ({ ...root }))
      .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'user' ? -1 : 1));
    this.#maxSkills = options.maxSkills ?? 100;
    this.#maxFileBytes = options.maxFileBytes ?? 65_536;
    this.#maxTotalBytes = options.maxTotalBytes ?? 1_048_576;
    this.#automatic = options.automatic ?? false;
    positiveInteger('maxSkills', this.#maxSkills);
    positiveInteger('maxFileBytes', this.#maxFileBytes);
    positiveInteger('maxTotalBytes', this.#maxTotalBytes);
  }

  public async load(input: ContextSourceInput): Promise<ContextContribution> {
    return this.tracer.startActiveSpan('context.skills', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({ 'session.id': input.session.id, 'turn.id': input.turnId });
      if (input.modelCallId !== undefined) span.setAttribute('model_call.id', input.modelCallId);
      try {
        checkContextCancellation(input);
        const current = input.session.turns.find((turn) => turn.id === input.turnId);
        const user = current?.entries.find((entry) => entry.kind === 'user_message');
        if (current?.status !== 'in_progress' || user?.kind !== 'user_message')
          throw new ContextError('invalid_state', 'Skill selection requires an active user turn.');
        const catalog = new Map<string, DiscoveredSkill>();
        let bytes = 0;
        let count = 0;
        const operationOptions = input.signal === undefined ? {} : { signal: input.signal };
        for (const root of this.#roots) {
          checkContextCancellation(input);
          const entries = await root.files
            .listDirectory(root.directory, operationOptions)
            .catch((error: unknown) => {
              if (error instanceof FileSystemError && error.code === 'not_found') return [];
              throw error;
            });
          const names = new Set<string>();
          for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
            checkContextCancellation(input);
            // Symlink directories are deliberately not followed during discovery.
            if (entry.kind !== 'directory') continue;
            const path = `${entry.path}/SKILL.md`;
            const file = await root.files
              .readFile(path, operationOptions)
              .catch((error: unknown) => {
                if (error instanceof FileSystemError && error.code === 'not_found')
                  return undefined;
                throw error;
              });
            checkContextCancellation(input);
            if (file === undefined) continue;
            const size = new TextEncoder().encode(file.content).length;
            bytes += size;
            count += 1;
            if (size > this.#maxFileBytes || bytes > this.#maxTotalBytes || count > this.#maxSkills)
              throw new ContextError(
                'source_failed',
                'Skill discovery exceeds its configured limit.',
              );
            const skill = parseSkill(file.content);
            if (names.has(skill.name))
              throw new ContextError('source_failed', 'Duplicate skill name within one scope.');
            names.add(skill.name);
            catalog.set(skill.name, { ...skill, scope: root.scope, path });
          }
        }
        checkContextCancellation(input);
        const selection = selectSkills([...catalog.values()], user.content, this.#automatic);
        const selected = [...selection.explicit, ...selection.automatic];
        span.addEvent('skills.selected', {
          'skills.explicit_count': selection.explicit.length,
          'skills.automatic_count': selection.automatic.length,
        });
        const messages = selected.map((skill) => {
          const discovered = catalog.get(skill.name)!;
          return {
            role: 'system' as const,
            content: `Selected skill: ${skill.name} (${discovered.scope} scope, ${discovered.path}).\nReusable workflow guidance; follow only where consistent with user instructions, project rules and harness policy. This skill grants no permissions, tools or filesystem access. Referenced resources are not loaded automatically.\n\n${skill.body}`,
          };
        });
        const injectedBytes = messages.reduce(
          (sum, message) => sum + new TextEncoder().encode(message.content).length,
          0,
        );
        span.addEvent('skills.injected', {
          'skills.injected_count': messages.length,
          'skills.injected_bytes': injectedBytes,
        });
        span.setAttributes({
          'skills.discovered_count': count,
          'skills.catalog_count': catalog.size,
          'skills.selected_count': selected.length,
          'skills.bytes_read': bytes,
          'skills.injected_bytes': injectedBytes,
          'skills.automatic_enabled': this.#automatic,
          success: true,
        });
        return { messages, tools: [] };
      } catch (error) {
        let normalized: unknown = error;
        try {
          checkContextCancellation(input);
        } catch (cancellation) {
          normalized = cancellation;
        }
        if (!(normalized instanceof ContextError) && !(normalized instanceof SamplingError))
          normalized = new ContextError('source_failed', 'Skills could not be read safely.', {
            cause: new Error(
              normalized instanceof FileSystemError ? normalized.code : 'skills_read_failed',
            ),
          });
        span.setAttributes({
          success: false,
          'error.type': (normalized as ContextError | SamplingError).code,
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw normalized;
      } finally {
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });
  }
}
