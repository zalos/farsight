// Default-off, private library fault injection only. Not a package export, runtime input or authority constructor.
let afterRetainedAppend: (() => void) | undefined;
/**
 * Installs a fault the owner decision command raises right after its record is retained, or clears it with undefined.
 * Tests only.
 */
export function setOwnerDecisionAppendFailureForTest(hook: (() => void) | undefined): void {
  afterRetainedAppend = hook;
}
/** Raises the installed fault, if any; the owner decision command calls it right after its record is retained. */
export function ownerDecisionAfterRetainedAppend(): void {
  afterRetainedAppend?.();
}
