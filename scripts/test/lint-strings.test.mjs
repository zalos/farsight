import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function lint(files) {
  const root = mkdtempSync(join(tmpdir(), 'farsight-lint-strings-'));
  const write = (path, source) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  try {
    write('package.json', JSON.stringify({ type: 'module' }));
    write(
      'packages/core/dist/strings.js',
      `export const STRINGS = ${JSON.stringify({
        'map.head.title': { hud: 'Journey', professional: 'Journey' },
        'map.legend.title': { hud: 'Legend', professional: 'Legend' },
      })};\n`,
    );
    write('packages/server/public/viewer.html', '');
    for (const [path, source] of Object.entries(files)) write(`packages/server/public/app/${path}`, source);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(new URL('../lint-strings.mjs', import.meta.url), join(root, 'scripts/lint-strings.mjs'));
    const result = spawnSync(process.execPath, ['scripts/lint-strings.mjs'], { cwd: root, encoding: 'utf8' });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const realShapes = [
  [
    'command prose with its pragma on the closing call line',
    'lib/copy-doors.js',
    `return out(
  mcp('describe_node', { node_id: id }),
  curl(origin, '/api/deps/where?package=' + encodeURIComponent(name)),
  'farsight deps where ' + shellQuote(name),
); // str:ok a command line, not prose
`,
  ],
  [
    'source prose with its pragma on the closing object line',
    'lib/map-lanes-model.js',
    `const counts = {
  built: {
    n: built,
    source: SRC + ' → stages by screen · state',
  }, // str:ok a Counted's source: where the number was read, for the tip's from line
};
`,
  ],
  [
    'region label with its catalog call on the next line',
    'surfaces/map.js',
    `return (
  '<div class="map-jhead" hidden role="region" aria-label="' +
  esc(t('map.head.title')) +
  '"></div>'
);
`,
  ],
  [
    'dialog label with its catalog call on the next line',
    'surfaces/map.js',
    `return (
  '<div class="map-legend" hidden role="dialog" aria-label="' +
  esc(t('map.legend.title')) +
  '"></div>'
);
`,
  ],
];

for (const [name, path, source] of realShapes) {
  test(`RULE 1 permits ${name}`, () => {
    const result = lint({ [path]: source });
    assert.equal(result.status, 0, result.output);
  });
}

test('RULE 1 permits a pragma on a following block boundary', () => {
  const result = lint({
    'shell.js': `const label = {
  text: 'A raw chrome message',
} // str:ok retained source text
`,
  });
  assert.equal(result.status, 0, result.output);
});

for (const [name, source, line = 1] of [
  ['untranslated prose', "const label = 'A raw chrome message';\n"],
  ['a catalog call in the next statement', "const label = 'A raw chrome message';\nt('map.head.title');\n"],
  ['a pragma in the next statement', "const label = 'A raw chrome message';\nconst count = 1; // str:ok a count\n"],
  ['a catalog call after a blank line', "const label = 'A raw chrome message' +\n\n  t('map.head.title');\n"],
  ['a pragma after a blank line', "const label = 'A raw chrome message' +\n\n  ''; // str:ok a command\n"],
  [
    'a catalog call beyond the eight-line bound',
    "const label = 'A raw chrome message' +\n" + '  // continuation\n'.repeat(7) + "  t('map.head.title');\n",
  ],
  [
    'a catalog call after a completed block without a semicolon',
    "if (label === 'A raw chrome message') {} // unrelated comment\nel.title = t('map.head.title');\n",
  ],
  [
    'a catalog call inside a block whose head contains prose',
    "if (label === 'A raw chrome message') { // unrelated comment\n  el.title = t('map.head.title');\n}\n",
  ],
  [
    'a catalog call inside an else-if body',
    "if (ready) {\n} else if (label === 'A raw chrome message') {\n  el.title = t('map.head.title');\n}\n",
    2,
  ],
  [
    'a catalog call in a function body after a prose default parameter',
    "function render(label = 'A raw chrome message') {\n  el.title = t('map.head.title');\n}\n",
  ],
  [
    'a catalog call after a multiline prose default parameter',
    "function render(\n  label = 'A raw chrome message',\n) {\n  el.title = t('map.head.title');\n}\n",
    2,
  ],
  [
    'a catalog call after a prose case label',
    "switch (label) {\n  case 'A raw chrome message': // unrelated comment\n    el.title = t('map.head.title');\n}\n",
    2,
  ],
  [
    'a catalog call beyond a default label',
    "switch (label) {\n  case 'x':\n    el.title = 'A raw chrome message'\n  default:\n    el.title = t('map.head.title');\n}\n",
    3,
  ],
  [
    'a catalog call after a completed block containing a quoted URL',
    "if (label === 'A raw chrome message' && origin === 'https://example.test') {}\nel.title = t('map.head.title');\n",
  ],
]) {
  test(`RULE 1 still rejects ${name}`, () => {
    const result = lint({ 'shell.js': source });
    assert.equal(result.status, 1, result.output);
    assert.ok(result.output.includes(`RULE1 shell.js:${line} raw prose literal outside t():`), result.output);
  });
}
