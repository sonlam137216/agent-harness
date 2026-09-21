import { waitForCallback } from '../cancellation.js';
import { snapshot } from '../immutable.js';
import type { ModelCallId, SessionId, TurnId } from '../ids.js';
import type { ToolCall } from '../tools/tool-types.js';
import type { AccessKind } from './access-kind.js';

export type PermissionMode = 'ask' | 'auto' | 'always-approve';
export type PermissionDecision = 'deny' | 'ask' | 'allow';
export interface PermissionRule {
  readonly decision: PermissionDecision;
  readonly toolName?: string;
  readonly accessKind?: AccessKind;
}
export interface PermissionRequest {
  readonly call: ToolCall;
  readonly accessKind: AccessKind;
  readonly destructive?: boolean;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly modelCallId: ModelCallId;
}
export type ApprovalHandler = (
  request: PermissionRequest,
  signal?: AbortSignal,
) => boolean | Promise<boolean>;
export interface PermissionEngineOptions {
  readonly mode?: PermissionMode;
  readonly rules?: readonly PermissionRule[];
  readonly approve?: ApprovalHandler;
}
export interface PermissionResolution {
  readonly decision: PermissionDecision;
  readonly allowed: boolean;
  readonly reason:
    'rule' | 'default' | 'destructive' | 'approved' | 'rejected' | 'unavailable' | 'cancelled';
}

export class PermissionEngine {
  public readonly mode: PermissionMode;
  readonly #rules: readonly PermissionRule[];
  readonly #approve: ApprovalHandler | undefined;

  public constructor(options: PermissionEngineOptions = {}) {
    this.mode = options.mode ?? 'auto';
    if (!['ask', 'auto', 'always-approve'].includes(this.mode)) {
      throw new TypeError('Invalid permission mode.');
    }
    this.#rules = snapshot(options.rules ?? []);
    for (const rule of this.#rules) {
      if (
        !['deny', 'ask', 'allow'].includes(rule.decision) ||
        (rule.accessKind !== undefined &&
          !['read', 'write', 'execute', 'external'].includes(rule.accessKind)) ||
        (rule.toolName !== undefined && rule.toolName.trim() === '')
      ) {
        throw new TypeError('Invalid permission rule.');
      }
    }
    this.#approve = options.approve;
  }

  public evaluate(request: PermissionRequest): PermissionResolution {
    const matching = this.#rules.filter(
      (rule) =>
        (rule.toolName === undefined || rule.toolName === request.call.name) &&
        (rule.accessKind === undefined || rule.accessKind === request.accessKind),
    );
    for (const decision of ['deny', 'ask', 'allow'] as const) {
      if (matching.some((rule) => rule.decision === decision)) {
        if (decision === 'allow' && request.destructive === true) break;
        return { decision, allowed: decision === 'allow', reason: 'rule' };
      }
    }
    if (request.destructive === true)
      return { decision: 'ask', allowed: false, reason: 'destructive' };
    const decision =
      this.mode === 'always-approve' || request.accessKind === 'read'
        ? 'allow'
        : this.mode === 'ask'
          ? 'ask'
          : 'deny';
    return { decision, allowed: decision === 'allow', reason: 'default' };
  }

  public async authorize(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionResolution> {
    const immutable = snapshot(request);
    const resolution = this.evaluate(immutable);
    if (signal?.aborted === true) return { ...resolution, allowed: false, reason: 'cancelled' };
    if (resolution.decision !== 'ask') return resolution;
    const approve = this.#approve;
    if (approve === undefined) return { ...resolution, allowed: false, reason: 'unavailable' };
    try {
      const approved = await waitForCallback(() => approve(immutable, signal), signal);
      return {
        ...resolution,
        allowed: approved === true && !signal?.aborted,
        reason: signal?.aborted ? 'cancelled' : approved === true ? 'approved' : 'rejected',
      };
    } catch {
      return {
        ...resolution,
        allowed: false,
        reason: signal?.aborted ? 'cancelled' : 'unavailable',
      };
    }
  }
}
