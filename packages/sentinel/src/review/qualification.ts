// Per-runner qualification records: what was measured for one pinned CLI profile on one platform, written here by
// hand from the controls and the live acceptance, never at run time. A profile whose record is complete (every
// control passed and its one live acceptance passed) runs where its release gate asks for qualification; a profile
// without a complete record is an experiment the owner opens with the runner's flag (`policy/features.ts`).
// Qualification establishes that the installed bytes and their confinement were measured; it is not a login check,
// and it says nothing about the quality of what a model answers.

export type QualificationControl = 'isolation' | 'zeroContact' | 'replay';

export interface RunnerQualificationRecord {
  /** The pinned profile, which names its runner, version, mode and platform. */
  readonly profileId: string;
  readonly platform: 'darwin-arm64';
  /** Each control as last measured: the sandbox refusals, no contact outside the fixed proxy, recorded wires. */
  readonly controls: Readonly<Record<QualificationControl, 'passed' | 'not-run'>>;
  /** The one owner-approved live run: when it passed, on which model and budget; or why it has not run. */
  readonly liveAcceptance:
    | Readonly<{ state: 'passed'; at: string; model: string; budget: string }>
    | Readonly<{ state: 'pending'; reason: string }>;
}

const passed = Object.freeze({ isolation: 'passed', zeroContact: 'passed', replay: 'passed' } as const);

/** Every record, in a fixed order. A profile id with no record here is unqualified. */
export const RUNNER_QUALIFICATIONS: readonly RunnerQualificationRecord[] = Object.freeze([
  Object.freeze({
    profileId: 'copilot-1.0.103-darwin-arm64-seatbelt-v6',
    platform: 'darwin-arm64' as const,
    controls: passed,
    liveAcceptance: Object.freeze({
      state: 'passed' as const,
      at: '2026-10-23',
      model: 'gpt-6-luna',
      budget: '3 turns · 120 s',
    }),
  }),
  Object.freeze({
    profileId: 'copilot-1.0.105-darwin-arm64-native-v1',
    platform: 'darwin-arm64' as const,
    controls: passed,
    liveAcceptance: Object.freeze({
      state: 'passed' as const,
      at: '2026-10-28T02:56:49Z',
      model: 'gpt-6-luna',
      budget: '3 turns · 120 s · 20000 tokens',
    }),
  }),
  Object.freeze({
    profileId: 'claude-code-2.1.282-darwin-arm64-native-v1',
    platform: 'darwin-arm64' as const,
    controls: passed,
    liveAcceptance: Object.freeze({
      state: 'pending' as const,
      reason: 'waiting for the owner to store his long-lived token under the adopted keychain reference',
    }),
  }),
]);

/** This process's platform in the records' words, or null where no record can apply. */
export const currentPlatform = (): RunnerQualificationRecord['platform'] | null =>
  process.platform === 'darwin' && process.arch === 'arm64' ? 'darwin-arm64' : null;

/** The record for a profile on this platform, or undefined. */
export function runnerQualification(profileId: string): RunnerQualificationRecord | undefined {
  const platform = currentPlatform();
  return RUNNER_QUALIFICATIONS.find((r) => r.profileId === profileId && r.platform === platform);
}

/** Complete on this platform: every control passed and the live acceptance passed. */
export function runnerQualified(profileId: string): boolean {
  const r = runnerQualification(profileId);
  return (
    r !== undefined && r.liveAcceptance.state === 'passed' && Object.values(r.controls).every((c) => c === 'passed')
  );
}
