// Pure inspection definitions shared by execution and retained reports. No worker, asset lookup or parser load.
import type { ArtifactId } from '../../contracts/common.js';
import { deepFreeze } from '../../kernel/freeze.js';
import { EXPRESS_SUPPORT } from '../express/support.js';
import { NEST_PACK } from '../nest/support.js';
import { NEXT_SUPPORT } from '../next/support.js';
import { SPRING_SUPPORT } from '../spring/support.js';
import type { FrameworkName, InspectedProperty, LibraryOutcome } from './facts.js';

/** The built-in framework inspection adapter's id. */
export const FRAMEWORK_CONTROLS_ADAPTER_ID = 'framework-controls';
/** The schema of the job the driver seals for one inspection unit. */
export const CONTROLS_JOB_SCHEMA = 'sentinel-framework-controls-job/draft-1';
/** The schema of the document the inspection worker writes as its one output. */
export const CONTROLS_OUTPUT_SCHEMA = 'sentinel-framework-controls-output/draft-1';
/** The media type of the inspection worker's output. */
export const CONTROLS_OUTPUT_MEDIA = 'application/vnd.sentinel.framework-controls+json';

/** The job the driver seals for one unit: what to read, nothing else. */
export interface ControlsJob {
  readonly schema: typeof CONTROLS_JOB_SCHEMA;
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly snapshot: ArtifactId;
  readonly analysis: { readonly artifact: ArtifactId; readonly result: ArtifactId; readonly index: ArtifactId };
  readonly properties: readonly InspectedProperty[];
  /** Spring profiles: none selected, so profile-conditioned chains stay unknown. */
  readonly environment: { readonly activeProfiles: null };
}

/** The worker's output: the job it answers and each library's outcome. */
export interface ControlsOutput {
  readonly schema: typeof CONTROLS_OUTPUT_SCHEMA;
  readonly job: ArtifactId;
  readonly libraries: readonly LibraryOutcome[];
}

/** The pack's rules at their shipped definition digests (pinned by test against `rules/framework-controls`). */
export const CONTROLS_SUPPORTED_RULES = Object.freeze([
  Object.freeze({
    familyId: 'sentinel.controls.authentication',
    revision: 1,
    definitionDigest: 'sha256:27ab274651c063cc5ac5c84645a8663db47f24f5a438b2a67ebc0b7e45f1d7c7',
  }),
  Object.freeze({
    familyId: 'sentinel.controls.authorization',
    revision: 1,
    definitionDigest: 'sha256:5f13578899efd12b5d149db6d65ca7b78d3f793593c42e6ccea859d8e1e03d13',
  }),
  Object.freeze({
    familyId: 'sentinel.controls.input-validation',
    revision: 1,
    definitionDigest: 'sha256:4dc4ab238c0a5e5c3388058779cb9a17bc5ed0e1d293d16729ce24d8c5e0997e',
  }),
]);
/** The schema of the driver report the inspection publishes beside its facts. */
export const CONTROLS_REPORT_SCHEMA = 'sentinel-driver-report/draft-1';
/** The schema of the control-facts envelopes the libraries emit. */
export const CONTROLS_ENVELOPE_SCHEMA = 'sentinel-controls/draft-1';

/** The exact versions each library models, from the libraries themselves. */
export const CONTROLS_MODELED_VERSIONS: Readonly<Record<FrameworkName, Readonly<Record<string, string>>>> = deepFreeze({
  next: { ...NEXT_SUPPORT.versions },
  express: { express: EXPRESS_SUPPORT.versions.express },
  nest: { ...NEST_PACK.versions },
  spring: {
    'spring-boot': SPRING_SUPPORT.versions.springBoot,
    'spring-security': SPRING_SUPPORT.versions.springSecurity,
  },
});
