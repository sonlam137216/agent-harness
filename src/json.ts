export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
