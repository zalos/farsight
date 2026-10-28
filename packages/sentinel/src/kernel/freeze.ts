// Deep immutability, written once (README §6, L0). Anything a later decision relies on is frozen all the way down: a
// frozen outer object over mutable children is not a snapshot.

/**
 * Freezes `value` and every object reachable from it through own enumerable string-keyed properties, outermost
 * first, and returns `value` itself.
 *
 * Guarantees: each object it reaches that was not frozen is frozen; a cycle ends the walk instead of overflowing it.
 * Leaves as they are: primitives, symbol-keyed and non-enumerable properties, the entries of a Map or Set (only their
 * own properties are frozen), and everything under an object that was already frozen when reached. Refuses, with the
 * TypeError `Object.freeze` raises, a typed array or Buffer that holds elements.
 */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * A private, deep-frozen copy of plain data: `structuredClone`, then {@link deepFreeze}. Nothing the caller holds can
 * change the copy afterwards, and the copy shares no object with the original. Refuses, with the error
 * `structuredClone` raises, a value it cannot clone (a function, a symbol, a class instance's methods).
 */
export const frozenCopy = <T>(value: T): T => deepFreeze(structuredClone(value));
