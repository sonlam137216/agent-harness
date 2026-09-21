/** Freeze plain lifecycle data without exposing mutable references to callbacks. */
export function freezeData<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
export function snapshot<T>(value: T): T {
  return freezeData(structuredClone(value));
}
