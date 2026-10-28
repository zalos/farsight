// Trust snapshots. Anything a later decision relies on (a validated pack, a spent receipt, the effective policy, the
// defaults) is a private deep copy, deep-frozen, so neither the caller's original objects nor anything reachable from
// the snapshot can change it afterwards. A frozen outer wrapper over mutable children is not a snapshot. The two
// functions are the kernel's (kernel/freeze.ts); this module keeps their import path and names.
export { deepFreeze, frozenCopy as snapshot } from '../kernel/freeze.js';
