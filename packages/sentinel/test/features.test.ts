import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS,
  FEATURE_FLAG_NAMES,
  FEATURE_FLAGS,
  FEATURE_OFF_REASON,
  FeatureFlagError,
  effectivePolicy,
  featureEnabled,
  featureOf,
  featureState,
  featureStates,
  parseSettings,
} from '../dist/index.js';
import type { SettingsEnvelope } from '../dist/index.js';
import { STRINGS } from '@farsight/core/dist/strings.js';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const settingsFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./contracts/valid/settings.json', import.meta.url)), 'utf8'),
) as SettingsEnvelope;
const settings = (extra: Partial<SettingsEnvelope>): SettingsEnvelope =>
  parseSettings(Buffer.from(JSON.stringify({ ...settingsFixture, ...extra })));

test('the registry names exactly the four gated features, each with its setting and default', () => {
  assert.deepEqual(
    [...FEATURE_FLAG_NAMES],
    ['stage.host-scripts', 'runner.claude-cli', 'runner.copilot-cli', 'review.hosted-api'],
  );
  assert.deepEqual(
    FEATURE_FLAGS.map((f) => [f.name, f.setting, f.default]),
    [
      ['stage.host-scripts', 'hostScripts', false],
      ['runner.claude-cli', 'nativeClaudeReviewEnabled', false],
      ['runner.copilot-cli', null, true],
      ['review.hosted-api', 'hostedApiReviewEnabled', false],
    ],
  );
  assert.ok(Object.isFrozen(FEATURE_FLAGS) && FEATURE_FLAGS.every((f) => Object.isFrozen(f)));
});

test('with no adopted settings every feature takes its default', () => {
  for (const given of [null, DEFAULT_SETTINGS]) {
    assert.deepEqual(
      featureStates(given).map((f) => [f.name, f.enabled, f.source]),
      [
        ['stage.host-scripts', false, 'default'],
        ['runner.claude-cli', false, 'default'],
        ['runner.copilot-cli', true, 'default'],
        ['review.hosted-api', false, 'default'],
      ],
    );
  }
  // The effective policy of untrusted settings falls back to the defaults, so a changed file turns nothing on.
  const untrusted = effectivePolicy({
    trust: 'changed',
    settings: settings({ hostScripts: true, hostedApiReviewEnabled: true, nativeClaudeReviewEnabled: true }),
    settingsDigest: null,
    repoConfig: null,
    repoConfigDigest: null,
  });
  assert.deepEqual(
    FEATURE_FLAG_NAMES.filter((name) => featureEnabled(untrusted.settings, name)),
    ['runner.copilot-cli'],
  );
});

test('the old settings booleans are read as aliases, with the meaning they always had', () => {
  const on = settings({ hostScripts: true, nativeClaudeReviewEnabled: true, hostedApiReviewEnabled: true });
  assert.deepEqual(
    featureStates(on).map((f) => [f.name, f.enabled, f.source]),
    [
      ['stage.host-scripts', true, 'settings'],
      ['runner.claude-cli', true, 'settings'],
      ['runner.copilot-cli', true, 'default'],
      ['review.hosted-api', true, 'settings'],
    ],
  );
  const off = settings({ hostScripts: false, nativeClaudeReviewEnabled: false, hostedApiReviewEnabled: false });
  assert.deepEqual(
    featureStates(off).map((f) => [f.name, f.enabled, f.source]),
    [
      ['stage.host-scripts', false, 'settings'],
      ['runner.claude-cli', false, 'settings'],
      ['runner.copilot-cli', true, 'default'],
      ['review.hosted-api', false, 'settings'],
    ],
  );
  // Exactly as the readers before the registry: only an explicit `true` enables a feature that defaults off.
  for (const name of ['stage.host-scripts', 'runner.claude-cli', 'review.hosted-api'] as const) {
    const setting = featureOf(name)!.setting!;
    for (const value of [undefined, false, true]) {
      const given = value === undefined ? settings({}) : settings({ [setting]: value });
      assert.equal(featureEnabled(given, name), given[setting] === true, `${name} with ${String(value)}`);
    }
  }
  assert.equal(featureOf('hostedApiReviewEnabled')?.name, 'review.hosted-api');
  assert.equal(featureOf('nativeClaudeReviewEnabled')?.name, 'runner.claude-cli');
  assert.equal(featureOf('hostScripts')?.name, 'stage.host-scripts');
  assert.equal(featureOf('runner.copilot-cli')?.setting, null);
  for (const name of ['hostedReviewSecretScan', 'review', '', 'constructor', '__proto__'])
    assert.equal(featureOf(name), undefined, name);
});

test('an off feature carries the off reason; an unknown name is refused, never read as off', () => {
  assert.equal(featureState(null, 'stage.host-scripts').reasonCode, FEATURE_OFF_REASON);
  assert.equal(Object.hasOwn(featureState(null, 'runner.copilot-cli'), 'reasonCode'), false);
  for (const bad of ['stage.anything', 'hostScripts', '', 'constructor', undefined, 3])
    assert.throws(
      () => featureEnabled(null, bad as never),
      (e: unknown) => e instanceof FeatureFlagError && e.code === 'sentinel.feature.unknown',
      String(bad),
    );
});

test('every feature word is in the two-register catalog with a define, and the business register names no flag', () => {
  for (const key of [...FEATURE_FLAGS.map((f) => f.label), FEATURE_OFF_REASON, 'sentinel.feature.unknown']) {
    const entry = STRINGS[key];
    assert.ok(entry, `${key} is in the catalog`);
    assert.ok(entry.hud && entry.professional && entry.define, `${key} has both registers and a define`);
    for (const name of FEATURE_FLAG_NAMES) assert.doesNotMatch(entry.hud, new RegExp(name.replace('.', '\\.')), key);
  }
});

// The lint rule: a gated feature is read through the registry and nowhere else. A read of one of its settings keys in
// any other source file fails here: a property read (`settings.hostScripts`), an element read
// (`settings['hostScripts']`) or a destructuring (`const { hostScripts } = settings`, `({ hostScripts }) =>`). The
// contracts declare the keys; the registry reads them. Writing a key (`{ hostScripts: true }`) is not a read.
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
const KEYS = FEATURE_FLAGS.flatMap((f) => (f.setting === null ? [] : [f.setting]));
/** How many times `text` reads one of the flags' settings keys. */
function flagReads(text: string): number {
  const key = `(?:${KEYS.join('|')})`;
  const patterns = [
    new RegExp(`\\.\\s*${key}\\b`, 'g'),
    new RegExp(`\\[\\s*['"\`]${key}['"\`]\\s*\\]`, 'g'),
    // A destructuring assignment or declaration: `{ …key… } =` (not `==` or `=>`).
    new RegExp(`\\{[^{}]*\\b${key}\\b[^{}]*\\}\\s*=(?![=>])`, 'g'),
    // A destructured parameter: `({ …key… })` or `({ …key… }: Type)`.
    new RegExp(`\\(\\s*\\{[^{}]*\\b${key}\\b[^{}]*\\}\\s*[:),]`, 'g'),
  ];
  return patterns.reduce((n, p) => n + [...text.matchAll(p)].length, 0);
}
// Reads that predate the registry, in files another lane owns. Each is to become a `featureEnabled` call; nothing may
// be added to this list.
const PENDING: Record<string, number> = { 'review/providers/selection.ts': 2 };

test('the flag-read rule sees every spelling of a read and no write', () => {
  for (const read of [
    'if (policy.settings.hostedApiReviewEnabled !== true) fail();',
    "const on = settings['nativeClaudeReviewEnabled'];",
    'const on = settings[ "hostScripts" ];',
    'const { hostScripts } = settings;',
    'const { nativeClaudeReviewEnabled: on, providers } = policy.settings;',
    'let a; ({ hostedApiReviewEnabled: a } = settings);',
    'const f = ({ hostScripts }) => hostScripts;',
    'function f({ hostScripts }: SettingsEnvelope) {}',
    'settings\n  .hostScripts',
  ])
    assert.equal(flagReads(read), 1, read);
  for (const other of [
    'const s = { hostScripts: true };',
    'settings = { ...settings, hostedApiReviewEnabled: false };',
    'x.hostScriptsCount',
    'const nativeClaudeReviewEnabledLabel = 1;',
    'if ({ hostScripts } == x) {}',
  ])
    assert.equal(flagReads(other), 0, other);
});

test('every flag read goes through the registry', () => {
  const found: Record<string, number> = {};
  for (const file of files(src)) {
    const rel = relative(src, file).split('\\').join('/');
    if (rel.startsWith('contracts/') || rel === 'policy/features.ts' || rel === 'schemas.generated.ts') continue;
    const count = flagReads(readFileSync(file, 'utf8'));
    if (count) found[rel] = count;
  }
  for (const [file, count] of Object.entries(found))
    assert.ok(
      PENDING[file] !== undefined && count <= PENDING[file]!,
      `${file} reads a feature setting directly (${count}); use featureEnabled from policy/features.ts`,
    );
});
