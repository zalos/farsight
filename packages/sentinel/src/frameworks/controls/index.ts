// Framework control inspection (ADR 44): the built-in worker and the pure inspection mapping. Internal; the trusted
// profile, the driver and the coordinator are its callers.
export { inspect, inspectionReport, libraryPresent, CONTROL_FAMILIES, INSPECTED_PROPERTIES, FRAMEWORKS, CONTROLS_REASONS } from './facts.js';
export type { InspectedProperty, FrameworkName, LibraryOutcome, InspectionCheck, InspectionCoverage, CheckInspection, InspectedRow, ControlsReason } from './facts.js';
export { FRAMEWORK_CONTROLS_ADAPTER_ID, CONTROLS_JOB_SCHEMA, CONTROLS_OUTPUT_SCHEMA, CONTROLS_OUTPUT_MEDIA, inspectSealed, runFrameworkControlsWorker } from './worker.js';
export type { ControlsJob, ControlsOutput } from './worker.js';
export { workerClosure, closureEntrySource, writeClosureEntry, FRAMEWORK_CONTROLS_WORKER, CLOSURE_REFUSED } from './closure.js';
export type { WorkerClosure, ClosureEntry } from './closure.js';
