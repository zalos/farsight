// Trust snapshots. Anything a later decision relies on (a validated pack, a spent receipt, the effective policy, the
// defaults) is a private deep copy, deep-frozen, so neither the caller's original objects nor anything reachable from
// the snapshot can change it afterwards. A frozen outer wrapper over mutable children is not a snapshot.

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** A private, deep-frozen copy of plain data. */
export const snapshot = <T>(value: T): T => deepFreeze(structuredClone(value));
