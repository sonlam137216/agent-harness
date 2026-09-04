import { randomUUID } from 'node:crypto';

declare const idBrand: unique symbol;

type BrandedId<Name extends string> = string & {
  readonly [idBrand]: Name;
};

export type SessionId = BrandedId<'SessionId'>;
export type TurnId = BrandedId<'TurnId'>;
export type ModelCallId = BrandedId<'ModelCallId'>;
export type ToolCallId = BrandedId<'ToolCallId'>;

export function createSessionId(): SessionId {
  return randomUUID() as SessionId;
}

export function createTurnId(): TurnId {
  return randomUUID() as TurnId;
}

export function createModelCallId(): ModelCallId {
  return randomUUID() as ModelCallId;
}

export function createToolCallId(): ToolCallId {
  return randomUUID() as ToolCallId;
}
