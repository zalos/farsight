// Pure shared identities for the closed path child, driver and retained readback. No asset lookup or file work.
export const PATHS_JOB_SCHEMA = 'sentinel-bounded-paths-job/draft-1';
export const PATHS_OUTPUT_SCHEMA = 'sentinel-bounded-paths-output/draft-1';
export const PATHS_OUTPUT_MEDIA = 'application/vnd.sentinel.bounded-paths+json';
export const PATHS_TASK_REPORT_SCHEMA = 'sentinel-path-task-report/draft-1';
export const PATHS_SUPPORTED_RULES = Object.freeze([
  Object.freeze({
    familyId: 'sentinel.paths.call-reachability',
    revision: 1,
    definitionDigest: 'sha256:7119346ea4a2959a47764325dfde778d51689cbb626940dabe02baa53d00bd8c',
  }),
]);
