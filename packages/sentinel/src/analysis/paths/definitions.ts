// Pure shared identities for the closed path child, driver and retained readback. No asset lookup or file work.
/** The schema of a path worker's job: the sealed request, snapshot and parser analysis it reads. */
export const PATHS_JOB_SCHEMA = 'sentinel-bounded-paths-job/draft-1';
/** The schema of a path worker's output. */
export const PATHS_OUTPUT_SCHEMA = 'sentinel-bounded-paths-output/draft-1';
/** The media type a path worker's output is published under. */
export const PATHS_OUTPUT_MEDIA = 'application/vnd.sentinel.bounded-paths+json';
/** The schema of a path task's report. */
export const PATHS_TASK_REPORT_SCHEMA = 'sentinel-path-task-report/draft-1';
/** The rule families the bounded-paths adapter implements, each pinned by revision and definition digest. */
export const PATHS_SUPPORTED_RULES = Object.freeze([
  Object.freeze({
    familyId: 'sentinel.paths.call-reachability',
    revision: 1,
    definitionDigest: 'sha256:7119346ea4a2959a47764325dfde778d51689cbb626940dabe02baa53d00bd8c',
  }),
]);
