// The full report through the public command path, over a real canonical four-engine run (the same inert original
// fixtures, synthetic offline advisory archive and existing pinned Linux images/checks as cli-scanners-e2e). The
// report reads accepted evidence only; an application graph places findings only after the owner confirms exactly
// it and only while the tree still holds the captured bytes; HTML is one offline file in either disclosure profile;
// compare labels a later run's findings against an earlier one's. Nothing is acquired; no network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scannerFixture } from './cli-scanners-helpers.ts';
import { unlock } from './snapshot-helpers.ts';
import { VALUE, GENERIC_VALUE, absent } from './secrets-helpers.ts';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../../../examples/invoice-app', import.meta.url));
const skip = process.env.SENTINEL_ISOLATION !== '1' && 'requires existing pinned local Linux images and checks; no acquisition during tests';

test('public CLI: full report, owner-confirmed context, offline HTML in both disclosures, and compare, from accepted evidence', { skip }, async t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'sentinel-cli-full-report-')));
  t.after(() => { unlock(dir); rmSync(dir, { recursive: true, force: true }); });
  const f = scannerFixture(dir);
  // An application with journeys beside the scanner fixtures, so a confirmed graph can place findings on screens.
  cpSync(EXAMPLE, join(f.ws, 'app'), { recursive: true, filter: src => !src.includes('node_modules') });
  writeFileSync(join(f.ws, 'app', 'src', 'lookup.ts'), 'export function lookupInvoice(id: string) { return db.query("SELECT * FROM invoices WHERE id = " + id); }\n');
  // Synthetic secrets for the fifth engine: a value in content, identical bytes in two files, and a source file whose
  // name is the value and whose code the pattern scanner also flags. None may reach any output.
  writeFileSync(join(f.ws, 'service.env'), `SENTINEL_SYNTHETIC_TOKEN=${VALUE}\n`);
  writeFileSync(join(f.ws, 'first.txt'), `api_key = "${GENERIC_VALUE}"\n`);
  writeFileSync(join(f.ws, 'second.txt'), `api_key = "${GENERIC_VALUE}"\n`);
  writeFileSync(join(f.ws, 'src', `${VALUE}.ts`), 'export function named(id: string) { return db.query("SELECT * FROM named WHERE id = " + id); }\n');
  // The store id keys the withheld-location HMAC. It is not secret, but no report output needs or carries it.
  let storeId = '';
  const clean = (text: string, where: string) => { for (const v of [VALUE, GENERIC_VALUE, ...(storeId ? [storeId] : [])]) absent(text, where, v); };
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, XDG_STATE_HOME: join(dir, 'state') };
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: f.ws, env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 << 20 });
    clean(r.stdout, `${args[0]} stdout`); clean(r.stderr, `${args[0]} stderr`);
    let body: any;
    try { body = JSON.parse(r.stdout); } catch { assert.fail(`command ${args.join(' ')} returned no typed result (${r.status}): ${r.stderr.slice(0, 2000)}`); }
    return { status: r.status, body };
  };
  const raw = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: f.ws, env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 << 20 });
    clean(r.stdout, `${args[0]} rendering`); clean(r.stderr, `${args[0]} stderr`);
    return r;
  };
  assert.equal(cli('init', '--profile', 'scanners').status, 0);
  assert.equal(cli('settings', 'adopt', '--confirm').status, 0);
  for (const id of ['pattern-semgrep', 'advisories-osv', 'iac-trivy', 'ci-zizmor', 'secrets-gitleaks']) assert.equal(cli('assets', 'adopt-tool', id, '--confirm').status, 0, id);
  for (const pack of ['pattern', 'foundation-preview', 'advisories', 'infrastructure', 'ci', 'secrets']) assert.equal(cli('rules', 'promote', `builtin:${pack}`, '--confirm').status, 0, pack);
  assert.equal(cli('assets', 'adopt-database', 'osv:npm', '--license', 'MIT', '--manifest', f.manifest, '--archive', f.db.path, '--confirm').status, 0);
  assert.equal(cli('assets', 'adopt-database', 'trivy-checks', '--manifest', f.trivyManifest, '--archive', f.checks.path, '--confirm').status, 0);
  const first = cli('plan').body.facts.runId as string;
  {
    const { openStore } = await import('../dist/store/index.js');
    const { workspaceOf } = await import('../dist/service/local.js');
    const store = await openStore(workspaceOf(f.ws, env).storePath);
    try { storeId = store.storeId; } finally { store.close(); }
    assert.ok(storeId.length >= 8);
  }
  assert.equal(cli('run', first, '--confirm').status, 2);

  // The minimal report is unchanged, and its flags do not leak into it.
  assert.equal(cli('report', first).body.facts.report.schema, 'sentinel-scanner-report/draft-1');
  assert.equal(cli('report', first, '--disclosure', 'private').body.reasonCode, 'sentinel.args.unexpectedArgument');

  // The full report: findings from every engine, every planned check covered or a gap, partial coverage said so.
  const full = cli('report', first, '--full');
  assert.equal(full.status, 0, JSON.stringify(full.body));
  assert.equal(full.body.outcome, 'answered', 'a report is never a policy result');
  assert.deepEqual(full.body.facts.limitations, ['sentinel.service.policyNotEvaluated']);
  assert.equal(full.body.facts.disclosure, 'shareable', 'shareable unless the owner asks for private');
  assert.equal(full.body.facts.completeness, 'partial');
  assert.ok(full.body.facts.gaps > 0, 'the fixture\'s partial coverage is a gap, not a pass');
  assert.equal(full.body.facts.context, null);
  const doc = JSON.parse(raw('report', first, '--full', '--format', 'json').stdout);
  assert.equal(doc.schema, 'sentinel-report/draft-1');
  // One finding family per engine: pattern (SQL), OSV (dependencies), Trivy (infrastructure), zizmor (CI).
  const families = new Set(doc.findings.map((x: any) => x.ruleFamilyId.split('.').slice(0, 2).join('.')));
  for (const prefix of ['sentinel.sql', 'sentinel.secrets', 'sentinel.deps', 'sentinel.iac', 'sentinel.ci']) assert.ok(families.has(prefix), `${prefix}: ${[...families]}`);
  // Secrets: withheld, never placed, two findings for the identical files; the secret-named file's pattern finding is
  // reported with its location withheld too.
  const secretFindings = doc.findings.filter((x: any) => x.ruleFamilyId.startsWith('sentinel.secrets.'));
  assert.ok(secretFindings.length >= 4 && secretFindings.every((x: any) => x.evidence.every((e: any) => e.state === 'withheld' && !e.location)));
  const dup = new Set(secretFindings.flatMap((x: any) => x.evidence.map((e: any) => e.content)));
  assert.ok(secretFindings.length > dup.size, 'identical bytes in two files stay two findings');
  assert.ok(doc.findings.some((x: any) => x.ruleFamilyId.startsWith('sentinel.sql') && x.evidence.some((e: any) => e.state === 'withheld' && e.reasonCode === 'sentinel.report.withheld.secret')),
    'the pattern finding in the secret-named file keeps its location withheld');
  assert.equal(doc.counts.findings.n, doc.findings.length);
  assert.ok(doc.counts.plannedChecks.n >= doc.gaps.length);
  assert.ok(doc.findings.every((x: any) => x.evidence.every((e: any) => e.state === 'withheld' && !e.excerpt
    && (e.reasonCode === 'sentinel.report.withheld.shareable' ? !!e.location : e.reasonCode === 'sentinel.report.withheld.secret' && !e.location))), 'shareable: locations, no excerpts; secret locations not even that');
  assert.ok(doc.findings.every((x: any) => x.place.binding === 'unavailable'), 'no context, no place');
  for (const g of doc.gaps) assert.ok(g.reasonCode && g.explanation.business && g.explanation.code, g.checkId);
  for (const c of Object.values(doc.counts) as any[]) assert.ok(c.unit && c.scope && c.source, JSON.stringify(c));
  assert.ok(doc.definitions.some((d: any) => d.key === 'sentinel.count.findings' && d.text.business && d.text.code), 'both registers travel with the report');

  // Private embeds excerpts; shareable does not. Both are one offline HTML file with no script or external load.
  const shareable = join(dir, 'shareable.html');
  const priv = join(dir, 'private.html');
  assert.equal(cli('report', first, '--full', '--format', 'html', '--out', shareable).status, 0);
  assert.equal(cli('report', first, '--full', '--format', 'html', '--disclosure', 'private', '--out', priv).status, 0);
  const again = cli('report', first, '--full', '--format', 'html', '--out', shareable);
  assert.deepEqual([again.status, again.body.reasonCode], [3, 'sentinel.report.outExists'], 'never replaces a file');
  const sh = readFileSync(shareable, 'utf8');
  const pv = readFileSync(priv, 'utf8');
  clean(sh, 'shareable html'); clean(pv, 'private html');
  for (const html of [sh, pv]) {
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /@media print/);
    assert.doesNotMatch(html, /<script|<link |src="http|href="http|@import/i);
  }
  assert.ok(!sh.includes('SELECT * FROM users WHERE id = '), 'shareable carries no source excerpt');
  assert.ok(pv.includes('SELECT * FROM users WHERE id = '), 'private carries the cited excerpt');
  assert.ok(raw('report', first, '--full', '--format', 'sarif').stdout.includes('"version": "2.1.0"'));

  // An owner graph of the application, built from the tree as captured: shown first, then confirmed.
  const { ingestRepo } = await import('../../parsers/dist/index.js');
  const fragment = await ingestRepo(f.ws, { repoName: 'workspace' });
  const graphPath = join(dir, 'graph.json');
  writeFileSync(graphPath, JSON.stringify({ nodes: fragment.nodes, edges: fragment.edges, meta: fragment.meta }));
  const shown = cli('report', first, '--full', '--context', graphPath);
  assert.deepEqual([shown.status, shown.body.outcome], [4, 'awaiting-confirmation'], JSON.stringify(shown.body));
  assert.match(shown.body.facts.contextIntent, /^sha256:/);
  const placed = cli('report', first, '--full', '--context', graphPath, '--confirm');
  assert.equal(placed.status, 0, JSON.stringify(placed.body));
  assert.equal(placed.body.facts.context.binding, 'matched', JSON.stringify(placed.body.facts.context));
  const placedDoc = JSON.parse(readFileSync(await (async () => {
    const out = join(dir, 'placed.json');
    assert.equal(cli('report', first, '--full', '--format', 'json', '--context', graphPath, '--confirm', '--out', out).status, 0);
    clean(readFileSync(out, 'utf8'), 'placed report');
    return out;
  })(), 'utf8'));
  assert.ok(placedDoc.findings.some((x: any) => x.place.binding === 'matched' && x.place.context), 'a finding placed through the confirmed context');
  assert.ok(placedDoc.artifactClosure.length > doc.artifactClosure.length, 'the context and its receipt travel with the report');

  // A graph of a tree that changed after the capture does not bind, whatever the owner confirms.
  writeFileSync(join(f.ws, 'app', 'src', 'lookup.ts'), 'export const changed = 1;\n');
  const drifted = cli('report', first, '--full', '--context', graphPath, '--confirm');
  assert.equal(drifted.status, 0);
  assert.equal(drifted.body.facts.context.binding, 'mismatched');
  assert.ok(drifted.body.facts.context.reasons.includes('sentinel.place.inputMismatch'));

  // Compare: the fixed file, planned and run again, against the first run.
  writeFileSync(join(f.ws, 'src', 'bad.ts'), f.files['src/good.ts']!);
  const second = cli('plan').body.facts.runId as string;
  assert.notEqual(second, first);
  assert.equal(cli('run', second, '--confirm').status, 2);
  const compared = cli('compare', second, first);
  assert.equal(compared.status, 0, JSON.stringify(compared.body));
  const cmp = compared.body.facts.comparison;
  assert.ok(cmp.current.length > 0 && cmp.current.every((o: any) => o.label && o.reasonCode));
  assert.ok(cmp.historical.length > 0, 'what the second run no longer finds is kept with a reason');
  const cmpDoc = JSON.parse(raw('compare', second, first, '--format', 'json').stdout);
  assert.equal(cmpDoc.baseline.reportId, JSON.parse(raw('report', first, '--full', '--format', 'json').stdout).id);
  assert.ok(cmpDoc.historical.every((h: any) => h.label && h.reasonCode));

  // Delivered and regenerated without the source: the report reads the store, never the workspace.
  for (const path of [...Object.keys(f.files), 'service.env', 'first.txt', 'second.txt', `src/${VALUE}.ts`]) rmSync(join(f.ws, path), { force: true });
  rmSync(join(f.ws, 'app'), { recursive: true, force: true });
  const regenerated = JSON.parse(raw('report', first, '--full', '--format', 'json').stdout);
  assert.deepEqual({ ...regenerated, evaluatedAt: null }, { ...doc, evaluatedAt: null });
  assert.ok(existsSync(shareable) && readFileSync(shareable, 'utf8') === sh, 'the delivered file stands alone');
  void resolve;
});
