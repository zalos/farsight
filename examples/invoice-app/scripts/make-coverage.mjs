#!/usr/bin/env node
// Regenerate this fixture's run artefacts:  pnpm build && node examples/invoice-app/scripts/make-coverage.mjs
//
// `coverage/coverage-final.json` used to pin istanbul line numbers by hand, so
// editing `src/server/invoiceService.ts` above line 58 silently broke the observed
// edges (docs/AI-HANDOFF.md, "invoice-app tests fixture debt"). It is generated
// here instead: the declaration lines come from the same oxc parse the graph uses
// (`ingestRepo` from packages/parsers/dist), so a hit's line *is* the node's line
// and the match stays `name+line`.
//
// Deterministic: no timestamps, no run ids, sorted keys. Two runs over an unchanged
// tree write byte-identical files.
//
// It also stamps `farsight.sourceDigest` into all three JSON reports — the digest
// `farsight digest --repo invoice-app` prints — so the reports prove "unchanged
// since the run" and `freshness` reads `unchanged` instead of `unknown`. The reports
// live under coverage/ and e2e/ as JSON, which the source walk does not read, so
// stamping them never moves the digest they carry.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestRepo, repoContentDigest } from '../../../packages/parsers/dist/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = 'invoice-app';

/**
 * The scripted run this fixture stands for: the unit suite exercises the service,
 * so `listInvoices` and `createInvoice` ran and `finalizeInvoice` did not (a function
 * a report shows with zero calls must produce no edge). Nothing else is measured —
 * that is deliberate, so the whole-scope exactness rule has a file it never looked at.
 */
const MEASURED = 'src/server/invoiceService.ts';
const HITS = { listInvoices: 3, createInvoice: 1, finalizeInvoice: 0 };

const fragment = await ingestRepo(root, { repoName: REPO, tests: false, openapi: false, design: false });
const source = readFileSync(join(root, MEASURED), 'utf8').split('\n');

const fnMap = {};
const f = {};
const statementMap = {};
const s = {};
let fnId = 0;
let stmtId = 0;

// sorted by name so the file is stable whatever order the adapter emitted
for (const name of Object.keys(HITS).sort()) {
  const node = fragment.nodes.find((n) => n.kind === 'function' && n.name === name && n.loc?.path === MEASURED);
  if (!node) throw new Error(`${MEASURED} no longer declares ${name} — update HITS in scripts/make-coverage.mjs`);
  const { line, endLine } = node.loc;
  if (!line || !endLine) throw new Error(`${MEASURED}::${name} has no line span — the adapter changed; nothing can be generated from it`);
  const declText = source[line - 1] ?? '';
  const declColumn = Math.max(declText.indexOf(name), 0);
  const id = String(fnId++);
  fnMap[id] = {
    name,
    decl: { start: { line, column: declColumn }, end: { line, column: declColumn + name.length } },
    loc: { start: { line, column: declText.length }, end: { line: endLine, column: (source[endLine - 1] ?? '').length } },
  };
  f[id] = HITS[name];
  // statement granularity is one source line inside the body — enough for the `lines`
  // count an observed edge carries; istanbul's real boundaries are finer
  for (let ln = line + 1; ln < endLine; ln++) {
    const text = source[ln - 1] ?? '';
    // a statement line, rather than a blank or a comment
    if (!text.trim() || /^\s*(\/\/|\/\*|\*)/.test(text)) continue;
    const sid = String(stmtId++);
    statementMap[sid] = {
      start: { line: ln, column: text.length - text.trimStart().length },
      end: { line: ln, column: text.length },
    };
    s[sid] = HITS[name];
  }
}

const sourceDigest = repoContentDigest(root, {});
const farsight = { sourceDigest, repo: REPO };

const coverage = {
  [MEASURED]: { path: MEASURED, statementMap, s, fnMap, f, branchMap: {}, b: {} },
  farsight,
};
writeFileSync(join(root, 'coverage/coverage-final.json'), `${JSON.stringify(coverage, null, 2)}\n`);

// the two reports a runner wrote get the same stamp, so the three can never drift
for (const rel of ['coverage/vitest-results.json', 'e2e/results.json']) {
  const abs = join(root, rel);
  const doc = JSON.parse(readFileSync(abs, 'utf8'));
  doc.farsight = farsight;
  writeFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`);
}

console.log(`invoice-app sourceDigest ${sourceDigest}`);
console.log(`  coverage/coverage-final.json  ${Object.keys(fnMap).length} functions, ${Object.values(f).filter(Boolean).length} reached`);
console.log('  coverage/vitest-results.json, e2e/results.json stamped');
