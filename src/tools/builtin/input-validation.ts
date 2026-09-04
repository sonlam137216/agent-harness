import type { JsonObject } from '../../json.js';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_QUERY_CHARACTERS = 1_000;

export type ValidationResult<T> =
  { readonly valid: true; readonly value: T } | { readonly valid: false; readonly message: string };

function hasOnlyKeys(input: JsonObject, allowedKeys: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowedKeys.includes(key));
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_CHARACTERS;
}

export function validateRequiredPath(input: JsonObject): ValidationResult<string> {
  if (!hasOnlyKeys(input, ['path']) || !validPath(input.path)) {
    return {
      valid: false,
      message: 'Expected exactly one non-empty string field named "path".',
    };
  }

  return { valid: true, value: input.path };
}

export function validateOptionalPath(input: JsonObject): ValidationResult<string> {
  if (!hasOnlyKeys(input, ['path'])) {
    return { valid: false, message: 'Only the optional string field "path" is allowed.' };
  }
  if (input.path === undefined) return { valid: true, value: '.' };
  if (!validPath(input.path)) {
    return { valid: false, message: 'The "path" field must be a non-empty string.' };
  }

  return { valid: true, value: input.path };
}

export interface SearchTextInput {
  readonly path: string;
  readonly query: string;
}

export function validateSearchTextInput(input: JsonObject): ValidationResult<SearchTextInput> {
  if (!hasOnlyKeys(input, ['path', 'query'])) {
    return {
      valid: false,
      message: 'Only "query" and the optional string field "path" are allowed.',
    };
  }
  if (
    typeof input.query !== 'string' ||
    input.query.length === 0 ||
    input.query.length > MAX_QUERY_CHARACTERS
  ) {
    return {
      valid: false,
      message: 'The "query" field must be a non-empty string of at most 1000 characters.',
    };
  }
  if (input.path !== undefined && !validPath(input.path)) {
    return { valid: false, message: 'The "path" field must be a non-empty string.' };
  }

  return {
    valid: true,
    value: { path: input.path ?? '.', query: input.query },
  };
}
