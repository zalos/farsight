import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Unit tests and their CLI children must never enroll settings in real user state.
const state = mkdtempSync(join(tmpdir(), 'echo-unit-state-'));
try {
  const files = readdirSync('test').filter(name => name.endsWith('.test.ts')).map(name => join('test', name));
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--test', ...files], {
    stdio: 'inherit', env: { ...process.env, XDG_STATE_HOME: state },
  });
  process.exitCode = result.status ?? 1;
} finally { rmSync(state, { recursive: true, force: true }); }
