import { describe, expect, it, vi } from 'vitest';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import {
  PermissionEngine,
  type PermissionRequest,
  type PermissionRule,
} from '../../src/permissions/permission-engine.js';

const request: PermissionRequest = {
  sessionId: createSessionId(),
  turnId: createTurnId(),
  modelCallId: createModelCallId(),
  call: { id: createToolCallId(), name: 'edit', arguments: { path: 'private.txt' } },
  accessKind: 'write',
};

describe('PermissionEngine', () => {
  it.each(['ask', 'auto', 'always-approve'] as const)(
    'deny wins in %s, independent of rule order',
    async (mode) => {
      const approve = vi.fn(() => true);
      const rules: PermissionRule[] = [
        { decision: 'allow', toolName: 'edit' },
        { decision: 'ask', accessKind: 'write' },
        { decision: 'deny', toolName: 'edit', accessKind: 'write' },
      ];
      for (const ordered of [rules, [...rules].reverse()]) {
        expect(
          await new PermissionEngine({ mode, rules: ordered, approve }).authorize(request),
        ).toMatchObject({ decision: 'deny', allowed: false });
      }
      expect(approve).not.toHaveBeenCalled();
    },
  );

  it.each(['ask', 'auto', 'always-approve'] as const)(
    'explicit ask wins over allow in %s',
    async (mode) => {
      const approve = vi.fn(() => true);
      const engine = new PermissionEngine({
        mode,
        approve,
        rules: [{ decision: 'allow' }, { decision: 'ask', toolName: 'edit' }],
      });
      expect(await engine.authorize(request)).toMatchObject({
        decision: 'ask',
        allowed: true,
        reason: 'approved',
      });
      expect(approve).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['auto', 'read', true, 'allow'],
    ['auto', 'write', false, 'deny'],
    ['auto', 'execute', false, 'deny'],
    ['auto', 'external', false, 'deny'],
    ['ask', 'read', true, 'allow'],
    ['ask', 'write', false, 'ask'],
    ['always-approve', 'execute', true, 'allow'],
  ] as const)('defaults for %s / %s', async (mode, accessKind, allowed, decision) => {
    expect(
      await new PermissionEngine({ mode }).authorize({ ...request, accessKind }),
    ).toMatchObject({ allowed, decision });
  });

  it('requires all selectors to match and snapshots caller rules', async () => {
    const rules: PermissionRule[] = [{ decision: 'allow', toolName: 'other', accessKind: 'write' }];
    const engine = new PermissionEngine({ rules });
    rules.push({ decision: 'allow' });
    expect((await engine.authorize(request)).allowed).toBe(false);
    expect(
      (await engine.authorize({ ...request, call: { ...request.call, name: 'other' } })).allowed,
    ).toBe(true);
  });

  it('requires approval for destructive tools even with allow and always-approve', async () => {
    const engine = new PermissionEngine({ mode: 'always-approve', rules: [{ decision: 'allow' }] });
    expect(await engine.authorize({ ...request, destructive: true })).toMatchObject({
      decision: 'ask',
      allowed: false,
      reason: 'unavailable',
    });
  });

  it('denies rejected and failed approvals without exposing callback failures', async () => {
    expect(
      await new PermissionEngine({ mode: 'ask', approve: () => false }).authorize(request),
    ).toMatchObject({ allowed: false, reason: 'rejected' });
    const result = await new PermissionEngine({
      mode: 'ask',
      approve: () => {
        throw new Error('secret');
      },
    }).authorize(request);
    expect(result).toMatchObject({ allowed: false, reason: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('cancels a hanging approval and ignores a late affirmative answer', async () => {
    const controller = new AbortController();
    let resolveApproval: (value: boolean) => void = () => undefined;
    const approve = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveApproval = resolve;
        }),
    );
    const pending = new PermissionEngine({ mode: 'ask', approve }).authorize(
      request,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ allowed: false, reason: 'cancelled' });
    resolveApproval(true);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('passes immutable approval data and does not cache approvals', async () => {
    const approve = vi.fn((value: PermissionRequest) => {
      expect(() => {
        (value.call.arguments as { path: string }).path = 'changed';
      }).toThrow();
      return true;
    });
    const engine = new PermissionEngine({ mode: 'ask', approve });
    await engine.authorize(request);
    await engine.authorize(request);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(request.call.arguments.path).toBe('private.txt');
  });
});
