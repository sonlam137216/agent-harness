import { describe, expect, it, vi } from 'vitest';
import { HookRegistry } from '../../src/hooks/hook-registry.js';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';

const context = {
  name: 'PreToolUse' as const,
  sessionId: createSessionId(),
  turnId: createTurnId(),
  modelCallId: createModelCallId(),
  call: { id: createToolCallId(), name: 'test', arguments: { nested: { value: 'original' } } },
};

describe('HookRegistry', () => {
  it('runs only matching hooks in registration order and supports removal', async () => {
    const hooks = new HookRegistry();
    const order: number[] = [];
    hooks.register('PreToolUse', () => {
      order.push(1);
    });
    const remove = hooks.register('PreToolUse', () => {
      order.push(2);
    });
    hooks.register('TurnStart', () => {
      order.push(3);
    });
    await hooks.run(context);
    remove();
    await hooks.run(context);
    expect(order).toEqual([1, 2, 1]);
  });
  it('vetoes before later hooks and wraps errors with their cause', async () => {
    const hooks = new HookRegistry();
    const later = vi.fn();
    hooks.register('PreToolUse', () => ({ deny: true }));
    hooks.register('PreToolUse', later);
    await expect(hooks.run(context)).rejects.toMatchObject({
      name: 'HookError',
      hookName: 'PreToolUse',
      cause: expect.any(Error) as unknown,
    });
    expect(later).not.toHaveBeenCalled();
  });
  it('deep freezes a separate snapshot', async () => {
    const hooks = new HookRegistry();
    hooks.register('PreToolUse', (value) => {
      if (value.name !== 'PreToolUse') throw new Error('Wrong hook');
      expect(Object.isFrozen(value.call.arguments.nested)).toBe(true);
      expect(value.call).not.toBe(context.call);
    });
    await hooks.run(context);
    expect(Object.isFrozen(context.call)).toBe(false);
  });
  it('cancels hooks that ignore the signal', async () => {
    const controller = new AbortController();
    const hooks = new HookRegistry();
    hooks.register('PreToolUse', () => new Promise(() => undefined));
    const pending = hooks.run(context, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'HookError' });
  });
});
