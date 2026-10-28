// Sentinel's import matrix, measured with the boundaries rule in eslint.config.mjs (docs/proposals/sentinel-v2 K-1).
// The rule is an error and every upward import that existed when it arrived is frozen in eslint-suppressions.json,
// file by file with its count, so `pnpm lint` fails on any new one. A count cannot see an upward import replaced by
// another in the same file, so this test holds the exact set as well, and fails on:
//   - an upward import (importing file → imported module) added, removed or replaced: the set must equal
//     import-matrix.json's `upward` exactly,
//   - a folder or root file of packages/sentinel/src that SENTINEL_LAYERS gives no layer,
//   - the rule and the layer table disagreeing about which imports point up,
//   - a folder joining the import cycle that import-matrix.json does not list.
// It also plants imports and lints them the way `pnpm lint` does. `SENTINEL_IMPORT_MATRIX=write` rewrites
// import-matrix.json from the measured matrix: paid debt is removed that way; new debt is a change the lead approves.
// `pnpm lint:boundaries` prints every frozen site.
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
const debt: { about?: string; upward: string[]; cycle: string[] } = JSON.parse(readFileSync(DEBT_FILE, 'utf8'));

const RULE = 'boundaries/dependencies';
const UP = /^sentinel layers: (\S+) → (\S+) points up/;
const EDGE = /^edge (\S+) → (\S+) \| (\S+) \| (\S+)$/;
type Sites = Map<string, string[]>; // "from → to" → file:line of each import

/** The configured layer rule and, beside it, the same plugin with no policy, which reports every edge. */
function measuring(): ESLint {
  return new ESLint({
    cwd: root,
    cache: false,
    ruleFilter: ({ ruleId }) => ruleId === RULE || ruleId === 'every-edge/dependencies',
    overrideConfig: {
      files: [`${SRC}/**/*.ts`],
      plugins: { 'every-edge': boundaries },
      rules: {
        'every-edge/dependencies': [
          'warn',
          {
            default: 'disallow',
            policies: [],
            message: 'edge {{from.type}} → {{to.type}} | {{to.elementPath}} | {{to.internalPath}}',
          },
        ],
      },
    },
  });
}

/** The layer rule as `pnpm lint` runs it: the repository's config and its suppressions file, nothing overridden. */
const asLint = () =>
  new ESLint({ cwd: root, cache: false, applySuppressions: true, ruleFilter: ({ ruleId }) => ruleId === RULE });

const pointsUp = (edge: string) => {
  const [from, to] = edge.split(' → ') as [string, string];
  return LAYERS[from]! < LAYERS[to]!;
};

/** The imported module of an edge message: a folder element's file, or a root file element itself. */
const moduleOf = (elementPath: string, internalPath: string) =>
  (elementPath.endsWith('.ts') ? elementPath : `${elementPath}/${internalPath}`).slice(SRC.length + 1);

function collect(results: ESLint.LintResult[]): { up: Sites; edges: Sites; upward: string[]; flagged: number } {
  const up: Sites = new Map(),
    edges: Sites = new Map(),
    upward = new Set<string>();
  let flagged = 0;
  for (const r of results)
    for (const m of r.messages) {
      const layered = m.ruleId === RULE;
      if (!layered && m.ruleId !== 'every-edge/dependencies') continue;
      const pair = (layered ? UP : EDGE).exec(m.message);
      assert.ok(pair, `${r.filePath}:${m.line}: an unexpected message: ${m.message}`);
      const key = `${pair[1]} → ${pair[2]}`;
      const site = `${r.filePath.slice(root.length)}:${m.line}`;
      if (layered) {
        flagged++;
        up.set(key, [...(up.get(key) ?? []), site]);
        continue;
      }
      edges.set(key, [...(edges.get(key) ?? []), site]);
      if (pointsUp(key))
        upward.add(`${r.filePath.slice(root.length + SRC.length + 1)} → ${moduleOf(pair[3]!, pair[4]!)}`);
    }
  return { up, edges, upward: [...upward].sort(), flagged };
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

const measured = collect(await measuring().lintFiles([SRC]));

test('every folder and root file of the package has a layer', () => {
  const entries = readdirSync(join(root, SRC), { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.name.endsWith('.ts'))
    .map((e) => e.name);
  const unlayered = entries.filter((name) => !(name in LAYERS));
  assert.deepEqual(unlayered, [], `give each a layer in eslint.config.mjs SENTINEL_LAYERS: ${unlayered.join(', ')}`);
  for (const nested of Object.keys(LAYERS).filter((n) => n.includes('/')))
    assert.ok(nested.split('/')[0]! in LAYERS, `${nested} is inside a layered folder`);
});

test('the boundaries rule reports exactly the imports the layer table says point up', (t) => {
  const computed = [...measured.edges.keys()].filter(pointsUp).sort();
  assert.ok(measured.edges.size > 100, `only ${measured.edges.size} edges were measured: is the resolver loaded?`);
  assert.deepEqual([...measured.up.keys()].sort(), computed);
  const sites = computed.reduce((n, pair) => n + measured.edges.get(pair)!.length, 0);
  assert.equal(measured.flagged, sites, 'the rule flags every upward import site, and only those');
  t.diagnostic(`${measured.up.size} upward folder pairs over ${sites} imports`);
});

const upwardDiff = (upward: readonly string[]) => {
  const known = new Set(debt.upward),
    now = new Set(upward);
  return { added: upward.filter((e) => !known.has(e)), removed: debt.upward.filter((e) => !now.has(e)) };
};

test('the upward imports are exactly the known debt: none added, removed or replaced', (t) => {
  const { added, removed } = upwardDiff(measured.upward);
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    'import-matrix.json lists every upward import (file → module); SENTINEL_IMPORT_MATRIX=write rewrites it',
  );
  t.diagnostic(`${measured.upward.length} upward imports (file → module), all known`);
});

test('the import cycle has no new member', (t) => {
  const members = cycleMembers(measured.edges.keys());
  const known = new Set(debt.cycle);
  const joined = members.filter((m) => !known.has(m));
  assert.deepEqual(joined, [], `these joined the import cycle: ${joined.join(', ')}`);
  assert.ok(!members.includes('kernel'), 'the kernel imports nothing from the package');
  const left = debt.cycle.filter((m) => !members.includes(m));
  if (left.length) t.diagnostic(`left the cycle (SENTINEL_IMPORT_MATRIX=write removes them): ${left.join(', ')}`);
  t.diagnostic(`${members.length} folders in the cycle: ${members.join(', ')}`);
  if (process.env.SENTINEL_IMPORT_MATRIX === 'write')
    writeFileSync(DEBT_FILE, `${JSON.stringify({ ...debt, upward: measured.upward, cycle: members }, null, 2)}\n`);
});

test('as pnpm lint runs it, an upward import fails in a new file and as one more import on a frozen file', async () => {
  const errors = async (file: string, code: string) =>
    (await asLint().lintText(code, { filePath: join(root, SRC, file) }))
      .flatMap((r) => r.messages)
      .filter((m) => m.ruleId === RULE && m.severity === 2)
      .map((m) => UP.exec(m.message)?.slice(1).join(' → '));
  // A new file: nothing of it is frozen.
  assert.deepEqual(
    await errors('kernel/planted.ts', "import { openStore } from '../store/index.js';\nexport const o = openStore;\n"),
    ['kernel → store'],
  );
  // store/ledger.ts has frozen store → evidence imports: the file as it is passes, one more fails.
  const ledger = readFileSync(join(root, SRC, 'store/ledger.ts'), 'utf8');
  assert.deepEqual(await errors('store/ledger.ts', ledger), [], 'the frozen sites pass as they are');
  const more = await errors('store/ledger.ts', `import '../evidence/accept.js';\n${ledger}`);
  assert.ok(
    more.length > 1 && more.every((e) => e === 'store → evidence'),
    `one more frozen-pair import fails: ${more}`,
  );
  // A downward import is never reported.
  assert.deepEqual(
    await errors('store/planted.ts', "import { digestOf } from '../kernel/digest.js';\nexport const d = digestOf;\n"),
    [],
  );
});

test('an upward import replaced by another in the same file passes the count but not the snapshot', async () => {
  const file = 'store/ledger.ts';
  const ledger = readFileSync(join(root, SRC, file), 'utf8');
  const swapped = ledger.replace("from '../evidence/abandon.js'", "from '../evidence/audit.js'");
  assert.notEqual(swapped, ledger, 'the fixture import is still there');
  // The count is unchanged, so lint with the suppressions passes ...
  const lintErrors = (await asLint().lintText(swapped, { filePath: join(root, SRC, file) }))
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === RULE && m.severity === 2);
  assert.deepEqual(lintErrors, []);
  // ... and the exact set of upward imports is what catches it.
  const planted = collect(await measuring().lintText(swapped, { filePath: join(root, SRC, file) })).upward;
  const others = measured.upward.filter((e) => !e.startsWith(`${file} → `));
  assert.deepEqual(upwardDiff([...others, ...planted].sort()), {
    added: ['store/ledger.ts → evidence/audit.ts'],
    removed: ['store/ledger.ts → evidence/abandon.ts'],
  });
});
