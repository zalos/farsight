// The canonical plan over an ordinary workspace: Sentinel's own store is the only folder left out, so the framework
// inspection reads the whole application, `.farsight` included, and states its answers without a capture gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameworkFixture } from './framework-canonical-helpers.ts';
import { needsStore } from './snapshot-helpers.ts';
import { ORDER } from './express-fixtures.ts';
import { openSnapshot } from '../dist/snapshot/materialize.js';

async function facts(f: any) {
  const pub = f.store.ledger.getPublication(f.admitted.plan.units[0])!;
  const out: Record<string, string> = {};
  for (const o of pub.outputs) {
    const v = JSON.parse((await f.store.readArtifact(o.id)).toString());
    for (const x of v.facts ?? [])
      out[`${x.surfaceId} ${x.property}`] = `${x.verdict}${x.reasonCode ? ` ${x.reasonCode}` : ''}`;
  }
  return out;
}
async function inspection(f: any) {
  const pub = f.store.ledger.getPublication(f.admitted.plan.units[0])!;
  const frontiers: string[] = [];
  let checks: any[] = [];
  for (const o of pub.outputs) {
    const v = JSON.parse((await f.store.readArtifact(o.id)).toString());
    for (const x of v.frontiers ?? []) frontiers.push(`${x.scopeId} ${x.reasonCode}`);
    if (o.schema === 'sentinel-driver-report/draft-1') checks = v.checks;
  }
  return { frontiers, checks };
}
const boundaries = async (f: any) =>
  (await openSnapshot(f.store, f.admitted.plan.pins.snapshotId)).snapshot.entries
    .filter((e: any) => e.kind === 'directory-boundary')
    .map((e: any) => `${e.relativePath} ${e.reasonCode}`);

test(
  'the default canonical layout reads the whole Express application: no capture gap, the store alone left out',
  needsStore,
  async (t) => {
    const f = await frameworkFixture(t, ORDER);
    assert.deepEqual(await boundaries(f), [
      '.farsight/sentinel/store sentinel.capture.excludedStore',
      '.git sentinel.capture.excludedGitInternals',
    ]);
    const entry = (await openSnapshot(f.store, f.admitted.plan.pins.snapshotId)).snapshot.entries.find(
      (e: any) => e.relativePath === '.farsight/sentinel/settings.json',
    );
    assert.equal(entry?.disposition, 'included', 'settings are ordinary captured source');
    const got = await facts(f);
    // The modeled answers: no control before the handler, and a refusal the pack cites but cannot prove.
    assert.equal(got['workspace::route::GET /reports authentication'], 'does-not-apply');
    assert.equal(got['workspace::route::GET /reports authorization'], 'does-not-apply');
    assert.equal(got['workspace::route::GET /account authentication'], 'unknown sentinel.express.refusalUnproven');
    assert.equal(got['workspace::route::POST /account authorization'], 'unknown sentinel.express.refusalUnproven');
    assert.equal(
      Object.values(got).some((v) => v.includes('sourceIncomplete')),
      false,
      JSON.stringify(got),
    );
  },
);

test(
  "arbitrary .farsight source, and an older build's scratch folder, are captured source with an honest effect",
  needsStore,
  async (t) => {
    const route = (path: string) =>
      `import express from 'express';\nconst app = express();\napp.get('${path}', (req, res) => { res.json({}); });\nexport default app;\n`;
    const f = await frameworkFixture(t, {
      ...ORDER,
      'src/extra.ts': route('/src-extra'),
      '.farsight/custom/extra.ts': route('/custom'),
      '.farsight/sentinel/scratch/w-old/copy.ts': route('/stale-copy'),
    });
    const got = await facts(f);
    assert.equal(got['workspace::route::GET /src-extra authentication'], 'does-not-apply');
    // The Express pack reads both files and finds their routes. Farsight's code parser lists no hidden folder, so
    // neither route is in the graph: each is a cited frontier, never a fact and never silently omitted.
    assert.equal(
      Object.keys(got).some((k) => k.includes('/custom') || k.includes('/stale-copy')),
      false,
    );
    const { frontiers, checks } = await inspection(f);
    assert.ok(
      frontiers.includes('workspace:.farsight/custom/extra.ts#L3 sentinel.express.routeNotInGraph'),
      frontiers.join('\n'),
    );
    assert.ok(
      frontiers.includes('workspace:.farsight/sentinel/scratch/w-old/copy.ts#L3 sentinel.express.routeNotInGraph'),
      frontiers.join('\n'),
    );
    assert.ok(
      checks.length > 0 &&
        checks.every((c: any) => c.state === 'partial' && c.reasons.includes('sentinel.express.routeNotInGraph')),
      JSON.stringify(checks),
    );
  },
);
