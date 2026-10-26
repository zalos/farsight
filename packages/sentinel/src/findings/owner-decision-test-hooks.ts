// Default-off, private library fault injection only. Not a package export, runtime input or authority constructor.
let afterRetainedAppend: (() => void) | undefined;
export function setOwnerDecisionAppendFailureForTest(hook: (() => void) | undefined): void {
  afterRetainedAppend = hook;
}
export function ownerDecisionAfterRetainedAppend(): void {
  afterRetainedAppend?.();
}
