// The pipeline each init profile writes. `static`, `scanners` and `secrets` declare exactly the stages those
// profiles plan today (capture, a parse per source, the inventory, the checks their rules select, the report), so
// declared planning reproduces today's units; `agentic` is the plan's example (README §3.3) with this build's
// registered adapter ids.
import type { PipelineDefinition, StageDefinition } from '../contracts/index.js';
import { PREVIEW_DETECTOR_ID, PREVIEW_RULE } from '../adapters/preview-detector.js';
import {
  GITLEAKS_SUPPORTED_RULES,
  OSV_SUPPORTED_RULES,
  PATTERN_SUPPORTED_RULES,
  TRIVY_SUPPORTED_RULES,
  ZIZMOR_SUPPORTED_RULES,
} from '../adapters/drivers/index.js';

const BOOTSTRAP: readonly StageDefinition[] = [
  { id: 'capture', kind: 'builtin', operation: 'capture' },
  { id: 'parse', kind: 'builtin', operation: 'parse', needs: ['capture'], fanOut: 'per-source' },
  { id: 'inventory', kind: 'builtin', operation: 'inventory', needs: ['parse'] },
];
const families = (rules: readonly { familyId: string }[]) => rules.map((r) => r.familyId);
const tool = (id: string, adapter: string, rules: string[]): StageDefinition => ({
  id,
  kind: 'tool',
  adapter,
  rules,
  needs: ['capture', 'inventory'],
});
const report = (needs: string[]): StageDefinition => ({ id: 'report', kind: 'builtin', operation: 'report', needs });
const pipeline = (stages: StageDefinition[], flags?: PipelineDefinition['flags']): PipelineDefinition => ({
  schema: 'sentinel-pipeline/draft-1',
  id: 'default',
  revision: 1,
  stages: [...BOOTSTRAP, ...stages],
  ...(flags ? { flags } : {}),
});

/**
 * The scan profiles init describes: the foundation preview, the five pinned scanners, the secret scan alone, and the
 * plan's agentic example (the secret and pattern scanners, the walkthrough, a brokered Copilot review and a native
 * Claude triage).
 */
export const PROFILES = ['static', 'scanners', 'secrets', 'agentic'] as const;

/** The rule packs a profile's owner promotes before planning: the packs this package ships, by name. */
export const PROFILE_PACKS: Readonly<Record<(typeof PROFILES)[number], readonly string[]>> = Object.freeze({
  static: ['foundation-preview'],
  scanners: ['pattern', 'advisories', 'infrastructure', 'ci', 'secrets'],
  secrets: ['secrets'],
  agentic: ['secrets', 'pattern'],
});

/** The pipeline `init --profile <profile>` writes. */
export function profilePipeline(profile: string): PipelineDefinition {
  switch (profile) {
    case 'scanners': {
      const checks = [
        tool('patterns', 'pattern-semgrep', families(PATTERN_SUPPORTED_RULES)),
        tool('advisories', 'advisories-osv', families(OSV_SUPPORTED_RULES)),
        tool('infrastructure', 'iac-trivy', families(TRIVY_SUPPORTED_RULES)),
        tool('ci', 'ci-zizmor', families(ZIZMOR_SUPPORTED_RULES)),
        tool('secrets', 'secrets-gitleaks', families(GITLEAKS_SUPPORTED_RULES)),
      ];
      return pipeline([...checks, report(checks.map((c) => c.id))]);
    }
    case 'secrets':
      return pipeline([tool('secrets', 'secrets-gitleaks', families(GITLEAKS_SUPPORTED_RULES)), report(['secrets'])]);
    case 'agentic':
      // The plan's example, as this build can plan it: the secret and pattern scanners, the walkthrough, a brokered
      // Copilot general review over their outputs, and the report. No stage or skill pack is named (none ships yet),
      // and the native Claude triage waits until the runner is turned on (a later profile adds it).
      return pipeline(
        [
          { ...tool('secrets', 'secrets-gitleaks', families(GITLEAKS_SUPPORTED_RULES)), required: true },
          {
            id: 'patterns',
            kind: 'tool',
            adapter: 'pattern-semgrep',
            rules: 'pack:builtin:pattern',
            needs: ['capture', 'parse'],
          },
          { id: 'walk', kind: 'builtin', operation: 'walkthrough', needs: ['parse'], fanOut: 'per-entry' },
          {
            id: 'review',
            kind: 'agent',
            mode: 'brokered',
            runner: 'copilot-cli',
            model: 'gpt-6-luna',
            needs: [
              { stage: 'walk', output: 'walkthrough' },
              { stage: 'patterns', output: 'findings' },
            ],
            after: ['secrets'],
            // One general review of the run (planner/pipeline.ts maps per-run to the general review).
            fanOut: 'per-run',
            budget: { turns: 3, tokens: 20000, seconds: 120 },
          },
          report(['secrets', 'patterns', 'review', 'walk']),
        ],
        { 'review.hosted-api': false },
      );
    default:
      return pipeline([tool('preview', PREVIEW_DETECTOR_ID, [PREVIEW_RULE]), report(['preview'])]);
  }
}
