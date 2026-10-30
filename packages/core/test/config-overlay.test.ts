import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configCounts, configFilesText, STRINGS, countedProblems, type ConfigMeta } from '../dist/index.js';

test('workspace config is counted and described separately from folders', () => {
  const meta: ConfigMeta = {
    files: [
      { path: 'farsight.config.json', dir: '.', root: true, fields: [], ignored: [] },
      {
        path: '.farsight/settings.json → sources[app].config',
        dir: '.',
        root: false,
        from: 'workspace',
        fields: ['tags'],
        ignored: [],
      },
      { path: 'src/farsight.config.json', dir: 'src', root: false, fields: [], ignored: [] },
    ],
    conflicts: [],
    notes: [],
  };
  const counts = configCounts(meta);
  assert.deepEqual(counts.files.breakdown, [
    { key: 'count.part.configRoot', n: 1 },
    { key: 'count.part.configScoped', n: 1 },
    { key: 'count.part.configWorkspace', n: 1 },
  ]);
  assert.deepEqual(countedProblems(counts.files), []);
  const text = configFilesText({ app: meta }).join('\n');
  assert.match(text, /1 from workspace settings/);
  assert.match(text, /workspace settings — the whole source/);
  assert.ok(!text.includes('scoped to ./'));
  for (const kind of ['gateTier', 'decision', 'field']) {
    const entry = STRINGS[`config.conflict.${kind}`];
    assert.ok(entry?.hud && entry.professional && entry.define, kind);
  }
});
