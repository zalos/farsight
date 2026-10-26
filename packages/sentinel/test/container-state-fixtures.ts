// Test-only delayed daemon visibility. Never supplies affirmative OOM evidence and never alters ownership.
import type { DockerRunner } from '../dist/execution/isolation.js';

export function delayedOomInspects(real: DockerRunner) {
  let terminalReads = 0;
  const started = performance.now();
  const observations: Array<{
    status: string;
    exitCode: number | null;
    rawOomKilled: boolean;
    masked: boolean;
    observedAtMs: number;
    inspectMs: number;
  }> = [];
  const runner: DockerRunner = {
    ...real,
    run: async (args, signal) => {
      const beforeInspect = performance.now();
      const answer = await real.run(args, signal);
      if (args[0] !== 'inspect' || !args.includes('--format') || answer.exitCode !== 0) return answer;
      const container = JSON.parse(answer.stdout.toString('utf8'));
      const state = container.State;
      const terminal137 = state?.Status === 'exited' && state?.ExitCode === 137;
      // Hide the first two terminal observations, not the first two *true* values. Otherwise a real daemon's
      // initial false flags compound the injected delay and can consume all four production observations.
      const mask = terminal137 && ++terminalReads <= 2;
      if (observations.length < 16)
        observations.push({
          status: String(state?.Status ?? '').slice(0, 32),
          exitCode: typeof state?.ExitCode === 'number' ? state.ExitCode : null,
          rawOomKilled: state?.OOMKilled === true,
          masked: mask,
          observedAtMs: Math.round(performance.now() - started),
          inspectMs: Math.round(performance.now() - beforeInspect),
        });
      return mask
        ? { ...answer, stdout: Buffer.from(JSON.stringify({ ...container, State: { ...state, OOMKilled: false } })) }
        : answer;
    },
  };
  return { runner, observations, terminalReads: () => terminalReads };
}
