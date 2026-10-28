// Sentinel's import matrix, measured with the boundaries rule in eslint.config.mjs and held against its known debt
// (docs/proposals/sentinel-v2 K-1). The rule is report-only: the matrix grew without layers, and 18 folders import
// each other in one cycle. This test is the gate instead. It fails on:
//   - a folder or root file of packages/sentinel/src that SENTINEL_LAYERS gives no layer,
//   - an upward edge (a folder importing a higher layer) that import-matrix.json does not list as known debt,
//   - a folder joining the import cycle that import-matrix.json does not list,
//   - the rule and this test disagreeing about which edges point up.
// Debt that disappears is reported, not failed; `SENTINEL_IMPORT_MATRIX=prune` rewrites import-matrix.json without
// it. Adding debt is a hand edit to that file, so it shows in review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import boundaries from 'eslint-plugin-boundaries';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = 'packages/sentinel/src';
const config = await import(pathToFileURL(join(root, 'eslint.config.mjs')).href);
const LAYERS: Readonly<Record<string, number>> = config.SENTINEL_LAYERS;
const DEBT_FILE = fileURLToPath(new URL('./import-matrix.json', import.meta.url));
const debt: { upward: string[]; cycle: string[] } = JSON.parse(readFileSync(DEBT_FILE, 'utf8'));

const UP = /^sentinel layers: (\S+) → (\S+) points up/;
const EDGE = /^edge (\S+) → (\S+)$/;
type Sites = Map<string, string[]>; // "from → to" → file:line of each import

/** Lints with the configured layer rule and, beside it, the same plugin with no policy, which reports every edge. */
function linter(): ESLint {
  return new ESLint({
    cwd: root,
    cache: false,
    ruleFilter: ({ ruleId }) => ruleId === 'boundaries/dependencies' || ruleId === 'every-edge/dependencies',
    overrideConfig: {
      files: [`${SRC}/**/*.ts`],
      plugins: { 'every-edge': boundaries },
      rules: {
        'every-edge/dependencies': [
          'warn',
          { default: 'disallow', policies: [], message: 'edge {{from.type}} → {{to.type}}' },
        ],
      },
    },
  });
}

function collect(results: ESLint.LintResult[]): { up: Sites; edges: Sites } {
  const up: Sites = new Map(),
    edges: Sites = new Map();
  for (const r of results)
    for (const m of r.messages) {
      const layered = m.ruleId === 'boundaries/dependencies';
      if (!layered && m.ruleId !== 'every-edge/dependencies') continue;
      const into = layered ? up : edges;
      const pair = (layered ? UP : EDGE).exec(m.message);
      assert.ok(pair, `${r.filePath}:${m.line}: an unexpected message: ${m.message}`);
      const key = `${pair[1]} → ${pair[2]}`;
      into.set(key, [...(into.get(key) ?? []), `${r.filePath.slice(root.length)}:${m.line}`]);
    }
  return { up, edges };
}

/** The folders in an import cycle: every strongly connected component with more than one member (Tarjan). */
function cycleMembers(edges: Iterable<string>): string[] {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const [from, to] = e.split(' → ') as [string, string];
    next.set(from, [...(next.get(from) ?? []), to]);
    if (!next.has(to)) next.set(to, []);
  }
  let index = 0;
  const order = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    on = new Set<string>(),
    members: string[] = [];
  const visit = (v: string) => {
    order.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of next.get(v)!) {
      if (!order.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, order.get(w)!));
    }
    if (low.get(v) === order.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) members.push(...component);
    }
  };
  for (const v of next.keys()) if (!order.has(v)) visit(v);
  return members.sort();
}

const pointsUp = (edge: string) => {
  const [from, to] = edge.split(' → ') as [string, string];
  return LAYERS[from]! < LAYERS[to]!;
};
const listed = (sites: Sites, keys: string[]) =>
  keys.map((k) => `${k} (${sites.get(k)!.slice(0, 3).join(', ')}${sites.get(k)!.length > 3 ? ', …' : ''})`).join('; ');

const measured = collect(await linter().lintFiles([SRC]));

test('every folder and root file of the package has a layer', () => {
  const entries = readdirSync(join(root, SRC), { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.name.endsWith('.ts'))
    .map((e) => e.name);
  const unlayered = entries.filter((name) => !(name in LAYERS));
  assert.deepEqual(unlayered, [], `give each a layer in eslint.config.mjs SENTINEL_LAYERS: ${unlayered.join(', ')}`);
  for (const nested of Object.keys(LAYERS).filter((n) => n.includes('/')))
    assert.ok(nested.split('/')[0]! in LAYERS, `${nested} is inside a layered folder`);
});

test('the boundaries rule reports exactly the edges that point up', () => {
  const computed = [...measured.edges.keys()].filter(pointsUp).sort();
  assert.ok(measured.edges.size > 100, `only ${measured.edges.size} edges were measured: is the resolver loaded?`);
  assert.deepEqual([...measured.up.keys()].sort(), computed);
});

test('no new upward edge: every import that points up is known debt', (t) => {
  const known = new Set(debt.upward);
  const added = [...measured.up.keys()].filter((e) => !known.has(e)).sort();
  assert.deepEqual(
    added,
    [],
    `imports point down only (docs/proposals/sentinel-v2/README.md §6): ${listed(measured.up, added)}`,
  );
  const gone = debt.upward.filter((e) => !measured.up.has(e));
  if (gone.length)
    t.diagnostic(`known debt that is gone (SENTINEL_IMPORT_MATRIX=prune removes it): ${gone.join('; ')}`);
  t.diagnostic(`${measured.up.size} upward edges over ${[...measured.up.values()].flat().length} imports, all known`);
});

test('the import cycle has no new member', (t) => {
  const members = cycleMembers(measured.edges.keys());
  const known = new Set(debt.cycle);
  const joined = members.filter((m) => !known.has(m));
  assert.deepEqual(joined, [], `these joined the import cycle: ${joined.join(', ')}`);
  assert.ok(!members.includes('kernel'), 'the kernel imports nothing from the package');
  t.diagnostic(`${members.length} folders in the cycle: ${members.join(', ')}`);
  if (process.env.SENTINEL_IMPORT_MATRIX === 'prune') {
    const pruned = {
      ...debt,
      upward: debt.upward.filter((e) => measured.up.has(e)),
      cycle: debt.cycle.filter((m) => members.includes(m)),
    };
    writeFileSync(DEBT_FILE, `${JSON.stringify(pruned, null, 2)}\n`);
  }
});

test('a planted upward import is reported and is not known debt; a downward one is not reported', async () => {
  const lint = async (file: string, code: string) =>
    collect(await linter().lintText(code, { filePath: join(root, SRC, file) })).up;
  const up = await lint(
    'kernel/planted.ts',
    "import { openStore } from '../store/index.js';\nexport const o = openStore;\n",
  );
  assert.deepEqual([...up.keys()], ['kernel → store']);
  assert.ok(!debt.upward.includes('kernel → store'));
  const down = await lint(
    'store/planted.ts',
    "import { digestOf } from '../kernel/digest.js';\nexport const d = digestOf;\n",
  );
  assert.equal(down.size, 0);
});
