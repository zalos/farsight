// PR 15: the Express pack over original fixtures: capture → public parser → pack. Synthetic sources only; nothing is
// installed, built or run. Registration order, nested mounts, early termination, skipped branches, next('route'),
// error handlers, conditional bypass and exact version scope, each with property-specific evidence or unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { analyzeExpress, EXPRESS_PACK, EXPRESS_REASON_CODES, matchPath, matchMethod } from '../dist/frameworks/express/index.js';
import { validateEnvelope } from '../dist/index.js';
import { capability } from '../dist/capabilities.js';
import { commitRepo, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';
import { AUTH, LOCK, MANIFEST, NESTED, ORDER, expressApp } from './express-fixtures.ts';

const LIMITS = { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20, maxEntries: 10_000, maxDurationMs: 60_000 };

async function pack(t: any, files: Record<string, string>) {
  const dir = scratch(t);
  const root = join(dir, 'repo');
  commitRepo(root, files);
  const fx = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(fx.store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const analysis = await parseSnapshot(fx.store, { snapshotId: snapshot.id, workDir: work, selection: { gitignore: true, testFiles: 'include' }, limits: LIMITS });
  const envelope = await analyzeExpress({ snapshot, sourceId: 'app', analysis: analysis.sources[0]!, readContent: id => fx.store.readArtifact(id) });
  assert.equal(validateEnvelope('controls', envelope).ok, true);
  await assertEvidence(fx, snapshot, envelope);
  return { envelope, snapshot, fx, analysis };
}

const route = (r: string) => `app::route::${r}`;
/** Every fact for a route and property, in order: `order:verdict` or `order:unknown:<reason>`. */
const chain = (env: any, r: string, property: string) => env.facts
  .filter((f: any) => f.surfaceId === route(r) && f.property === property)
  .sort((a: any, b: any) => a.order - b.order)
  .map((f: any) => `${f.order}:${f.verdict === 'unknown' ? `unknown:${f.reasonCode.replace('sentinel.express.', '')}` : f.verdict}`);
const both = (env: any, r: string) => ({ authentication: chain(env, r, 'authentication'), authorization: chain(env, r, 'authorization') });

/** Every resolved fact cites captured bytes: the evidence's content is the snapshot's, and its span is in range. */
async function assertEvidence(fx: any, snapshot: any, env: any) {
  for (const f of env.facts) {
    if (f.verdict !== 'unknown') assert.ok(f.evidence.length > 0, `${f.surfaceId} ${f.property}: resolved facts cite evidence`);
    for (const e of f.evidence) {
      const entry = snapshot.entries.find((x: any) => x.relativePath === e.relativePath && x.sourceId === e.sourceId);
      assert.equal(entry?.content, e.content, `${e.relativePath} is the captured file`);
      const bytes = await fx.store.readArtifact(e.content);
      assert.ok(e.span.startByte >= 0 && e.span.endByte <= bytes.length && e.span.startByte < e.span.endByte, `${e.relativePath} span in range`);
    }
  }
}
async function cited(fx: any, f: any): Promise<string[]> {
  return Promise.all(f.evidence.map(async (e: any) => (await fx.store.readArtifact(e.content)).subarray(e.span.startByte, e.span.endByte).toString('utf8')));
}
const factAt = (env: any, r: string, property: string, order: number) =>
  env.facts.find((f: any) => f.surfaceId === route(r) && f.property === property && f.order === order);

test('registration order: a control registered after a route never clears it, one before it applies', needsStore, async t => {
  const { envelope, fx } = await pack(t, ORDER);
  assert.equal(envelope.framework.id, 'express');
  assert.equal(envelope.framework.version, '4.21.2');
  assert.equal(envelope.capability, 'framework-order');
  // Registered before requireUser: only the JSON body parser runs first.
  assert.deepEqual(both(envelope, 'GET /reports'), { authentication: ['1:does-not-apply'], authorization: ['1:does-not-apply'] });
  // After requireUser: authentication applies at its position; nothing refuses with 403.
  assert.deepEqual(both(envelope, 'GET /account'), { authentication: ['1:applies'], authorization: ['2:does-not-apply'] });
  // The route's own requireRole('owner') runs after the application's layers.
  assert.deepEqual(both(envelope, 'POST /account'), { authentication: ['1:applies'], authorization: ['2:applies'] });
  // The evidence is the refusal itself, the route and the exact version pin, never a name.
  const text = (await cited(fx, factAt(envelope, 'GET /account', 'authentication', 1))).join('\n');
  assert.match(text, /if \(!req\.user\) return res\.status\(401\)/);
  assert.match(text, /app\.get\('\/account'/);
  assert.match(text, /"express": "4\.21\.2"/);
  const admin = (await cited(fx, factAt(envelope, 'POST /account', 'authorization', 2))).join('\n');
  assert.match(admin, /requireRole\('owner'\)/);
  assert.match(admin, /res\.sendStatus\(403\)/);
});

test('nested mounts: each router\'s layers run in order, and an application route below a mount passes its router first', needsStore, async t => {
  const { envelope } = await pack(t, NESTED);
  assert.deepEqual(both(envelope, 'GET /me'), { authentication: ['0:applies'], authorization: ['1:does-not-apply'] });
  assert.deepEqual(both(envelope, 'GET /stats'), { authentication: ['0:applies'], authorization: ['1:applies'] });
  // Express gotcha: the api router's requireUser also runs for /api/health, registered on the app after the mount.
  assert.deepEqual(both(envelope, 'GET /api/health'), { authentication: ['0:applies'], authorization: ['1:does-not-apply'] });
  assert.deepEqual(both(envelope, 'GET /status'), { authentication: ['0:does-not-apply'], authorization: ['0:does-not-apply'] });
});

test('a conditional registration or one made from another module leaves every route of that application unknown', needsStore, async t => {
  const conditional = (await pack(t, expressApp(`import express from 'express';
import { requireUser } from './auth.js';

const app = express();
if (process.env.AUTH !== 'off') app.use(requireUser);
app.get('/account', (req, res) => { res.json({}); });

export default app;
`))).envelope;
  assert.deepEqual(both(conditional, 'GET /account'), { authentication: ['0:unknown:registrationDynamic'], authorization: ['0:unknown:registrationDynamic'] });
  assert.ok(conditional.frontiers.some((f: any) => f.reasonCode === 'sentinel.express.registrationDynamic' && f.scopeId === 'app:src/app.ts'));
  const elsewhere = (await pack(t, expressApp(`import express from 'express';

const app = express();
app.get('/account', (req, res) => { res.json({}); });

export default app;
`, { 'src/server.ts': `import app from './app.js';
import { requireUser } from './auth.js';

app.use(requireUser);
app.listen(3000);
` }))).envelope;
  assert.deepEqual(both(elsewhere, 'GET /account'), { authentication: ['0:unknown:registrationDynamic'], authorization: ['0:unknown:registrationDynamic'] });
  // Near neighbour: the same control registered unconditionally in the application's own module applies.
  const plain = (await pack(t, expressApp(`import express from 'express';
import { requireUser } from './auth.js';

const app = express();
app.use(requireUser);
app.get('/account', (req, res) => { res.json({}); });

export default app;
`))).envelope;
  assert.deepEqual(both(plain, 'GET /account'), { authentication: ['0:applies'], authorization: ['1:does-not-apply'] });
});

test('names establish nothing: a pass-through named like a guard and a library middleware are not protection', needsStore, async t => {
  const env = (await pack(t, expressApp(`import express from 'express';
import passport from 'passport';
import { requireAuth } from './auth.js';

const app = express();
app.get('/named', requireAuth, (req, res) => { res.json({}); });
app.get('/library', passport.authenticate('jwt', { session: false }), (req, res) => { res.json({}); });

export default app;
`, {}, MANIFEST('4.21.2').replace('"express": "4.21.2"', '"express": "4.21.2",\n    "passport": "0.7.0"')))).envelope;
  assert.deepEqual(both(env, 'GET /named'), { authentication: ['1:does-not-apply'], authorization: ['1:does-not-apply'] });
  assert.deepEqual(both(env, 'GET /library'), { authentication: ['0:unknown:middlewareThirdParty'], authorization: ['0:unknown:middlewareThirdParty'] });
});

test('early termination and skips: next(\'route\'), error handlers and an earlier route on the same path', needsStore, async t => {
  const env = (await pack(t, expressApp(`import express from 'express';
import { maybeSkip, requireUser } from './auth.js';

const app = express();
// An error handler runs only with an error: it is not on the path of a request that reaches a handler.
app.use((err, req, res, next) => { next(); });
app.get('/preview', maybeSkip, requireUser, (req, res) => { res.json({}); });
// An earlier route matching every method on the path runs its handlers first.
app.all('/orders', requireUser);
app.get('/orders', (req, res) => { res.json([]); });
// An earlier route that answers the request itself: what it does is not read.
app.get('/catalog/:id', (req, res) => { res.json({}); });
app.get('/catalog/special', requireUser, (req, res) => { res.json({}); });

export default app;
`))).envelope;
  assert.deepEqual(both(env, 'GET /preview'), { authentication: ['0:unknown:nextSkip', '1:applies'], authorization: ['0:unknown:nextSkip'] });
  assert.deepEqual(both(env, 'GET /orders'), { authentication: ['0:applies'], authorization: ['1:does-not-apply'] });
  assert.deepEqual(both(env, 'GET /catalog/special'), {
    authentication: ['0:unknown:middlewareEffectUnknown', '1:applies'], authorization: ['0:unknown:middlewareEffectUnknown'],
  });
});

test('paths: partial, case and trailing-slash matches are decided only when they hold for every request', needsStore, async t => {
  const env = (await pack(t, expressApp(`import express from 'express';
import { requireUser } from './auth.js';

const app = express();
app.use('/ADMIN', requireUser);
app.use('/api/users', requireUser);
app.get('/admin/panel', (req, res) => { res.json({}); });
app.get('/api/:resource', (req, res) => { res.json({}); });
app.get('/apiary', (req, res) => { res.json({}); });
app.get('/trailing/', (req, res) => { res.json({}); });

export default app;
`))).envelope;
  // Express matches paths case-insensitively by default.
  assert.deepEqual(both(env, 'GET /admin/panel'), { authentication: ['0:applies'], authorization: ['1:does-not-apply'] });
  // The /api/users layer runs for some /api/:resource requests only.
  assert.deepEqual(both(env, 'GET /api/:resource'), { authentication: ['0:unknown:layerMatchUnknown'], authorization: ['1:does-not-apply'] });
  // A prefix matches whole segments: /api/users is not a prefix of /apiary.
  assert.deepEqual(both(env, 'GET /apiary'), { authentication: ['0:does-not-apply'], authorization: ['0:does-not-apply'] });
  assert.deepEqual(both(env, 'GET /trailing/'), { authentication: ['0:unknown:pathUnsupported'], authorization: ['0:unknown:pathUnsupported'] });
  assert.equal(matchPath('/api/:id', '/api', true), 'match');
  assert.equal(matchPath('/api', '/api/users', true), 'no-match');
  assert.equal(matchMethod('get', ['head']), 'unknown');
  assert.equal(matchMethod('get', 'all'), 'match');
});

test('version scope is exact: a range needs the npm lockfile, and any other version is unknown', needsStore, async t => {
  const app = `import express from 'express';
import { requireUser } from './auth.js';

const app = express();
app.use(requireUser);
app.get('/account', (req, res) => { res.json({}); });

export default app;
`;
  const cases: [string, Record<string, string>, string | null, string][] = [
    ['an exact pin', {}, '4.21.2', '0:applies'],
    ['a range the lockfile resolves', { 'package.json': MANIFEST('^4.21.0'), 'package-lock.json': LOCK('^4.21.0', '4.21.2') }, '4.21.2', '0:applies'],
    ['a range without a lockfile', { 'package.json': MANIFEST('^4.21.0') }, null, '0:unknown:versionUnresolved'],
    ['a range the lockfile resolves elsewhere', { 'package.json': MANIFEST('^4.21.0'), 'package-lock.json': LOCK('^4.21.0', '4.21.1') }, null, '0:unknown:versionUnsupported'],
    ['a lockfile written for another declaration', { 'package.json': MANIFEST('^4.21.0'), 'package-lock.json': LOCK('^4.20.0', '4.21.2') }, null, '0:unknown:versionUnresolved'],
    ['another exact version', { 'package.json': MANIFEST('4.19.2') }, null, '0:unknown:versionUnsupported'],
    ['Express 5', { 'package.json': MANIFEST('5.1.0') }, null, '0:unknown:versionUnsupported'],
    ['an override', { 'package.json': MANIFEST('4.21.2', ',\n  "overrides": { "express": "5.1.0" }') }, null, '0:unknown:versionUnsupported'],
    ['a path alias for express', { 'tsconfig.json': '{ "compilerOptions": { "paths": { "express": ["./src/fake-express.ts"] } } }\n' }, null, '0:unknown:versionUnresolved'],
  ];
  for (const [name, extra, version, expected] of cases) {
    const files = { ...expressApp(app), ...extra };
    const { envelope } = await pack(t, files);
    assert.equal(envelope.framework.version, version, name);
    assert.deepEqual(chain(envelope, 'GET /account', 'authentication'), [expected], name);
  }
});

test('routers that are not mounted, mounted twice differently, or registered twice are unknown', needsStore, async t => {
  const env = (await pack(t, expressApp(`import express from 'express';
import { requireUser } from './auth.js';
import shared from './routes/shared.js';

const app = express();
app.use('/open', shared);
app.use('/closed', requireUser, shared);

export default app;
`, {
    'src/routes/shared.ts': `import { Router } from 'express';

const router = Router();
router.get('/item', (req, res) => { res.json({}); });

export default router;
`,
    'src/routes/orphan.ts': `import { Router } from 'express';

const router = Router();
router.get('/orphan', (req, res) => { res.json({}); });

export default router;
`,
  }))).envelope;
  assert.deepEqual(both(env, 'GET /item'), { authentication: ['0:unknown:mountsDisagree'], authorization: ['0:unknown:mountsDisagree'] });
  assert.deepEqual(both(env, 'GET /orphan'), { authentication: ['0:unknown:routeNotMounted'], authorization: ['0:unknown:routeNotMounted'] });
  const dup = (await pack(t, expressApp(`import express from 'express';
import api from './routes/api.js';

const app = express();
app.use('/api', api);
app.get('/item', (req, res) => { res.json({}); });

export default app;
`, { 'src/routes/api.ts': `import { Router } from 'express';
import { requireUser } from '../auth.js';

const router = Router();
router.use(requireUser);
router.get('/item', (req, res) => { res.json({}); });

export default router;
` }))).envelope;
  assert.deepEqual(both(dup, 'GET /item'), { authentication: ['0:unknown:surfaceAmbiguous'], authorization: ['0:unknown:surfaceAmbiguous'] });
});

test('a factory with a non-literal argument, an async function or an unresolved import is unknown, not protection', needsStore, async t => {
  const env = (await pack(t, expressApp(`import express from 'express';
import { requireRole } from './auth.js';
import { gate } from './missing.js';

const role = process.env.ROLE;
const app = express();
app.get('/a', requireRole(role), (req, res) => { res.json({}); });
app.get('/b', async (req, res, next) => { if (!req.user) return res.sendStatus(401); next(); }, (req, res) => { res.json({}); });
app.get('/c', gate, (req, res) => { res.json({}); });
app.get('/d', requireRole('admin'), (req, res) => { res.json({}); });

export default app;
`))).envelope;
  assert.deepEqual(both(env, 'GET /a'), { authentication: ['0:unknown:middlewareEffectUnknown'], authorization: ['0:unknown:middlewareEffectUnknown'] });
  assert.deepEqual(both(env, 'GET /b'), { authentication: ['0:unknown:middlewareEffectUnknown'], authorization: ['0:unknown:middlewareEffectUnknown'] });
  assert.deepEqual(both(env, 'GET /c'), { authentication: ['0:unknown:middlewareUnresolved'], authorization: ['0:unknown:middlewareUnresolved'] });
  assert.deepEqual(both(env, 'GET /d'), { authentication: ['1:does-not-apply'], authorization: ['0:applies'] });
});

test('another framework\'s routes are not this pack\'s surfaces, and the envelope is keyed by its inputs', needsStore, async t => {
  const env = (await pack(t, expressApp(`import express from 'express';
import fastify from 'fastify';

const app = express();
app.get('/express', (req, res) => { res.json({}); });
const router = fastify();
router.get('/fastify', async () => ({}));

export default app;
`))).envelope;
  assert.ok(env.facts.some((f: any) => f.surfaceId === route('GET /express')));
  assert.ok(!env.facts.some((f: any) => f.surfaceId === route('GET /fastify')));
  const again = (await pack(t, expressApp(`import express from 'express';
import fastify from 'fastify';

const app = express();
app.get('/express', (req, res) => { res.json({}); });
const router = fastify();
router.get('/fastify', async () => ({}));

export default app;
`))).envelope;
  assert.equal(again.packDigest, env.packDigest);
  assert.equal(again.registrationDigest, env.registrationDigest);
  assert.match(EXPRESS_PACK.implementation, /draft/);
});

test('every reason code is a catalog entry with both registers and a definition, and the capability is a source-only draft', async () => {
  const { STRINGS } = await import('../../core/dist/strings.js');
  for (const code of EXPRESS_REASON_CODES) {
    const e = (STRINGS as any)[code];
    assert.ok(e?.hud && e?.professional && e?.define, code);
  }
  const c = capability('framework-express');
  assert.equal(c?.state, 'available-draft');
  assert.equal(c?.reasonCode, 'sentinel.capability.draftExpress');
  assert.ok(AUTH.includes('Never run'));
});

test('error paths: an error handler after a refusal that may resume routing lets a request past it', needsStore, async t => {
  const body = (handler: string) => expressApp(`import express from 'express';
import { requireUser } from './auth.js';

const app = express();
app.use(express.json());
app.use(requireUser);
// A malformed JSON body raises an error in the parser, which skips requireUser and reaches this handler.
app.use(${handler});
app.get('/account', (req, res) => { res.json({}); });

export default app;
`);
  const resumes = (await pack(t, body('(err, req, res, next) => { next(); }'))).envelope;
  assert.deepEqual(both(resumes, 'GET /account'), { authentication: ['1:unknown:errorPathResumes'], authorization: ['2:does-not-apply'] });
  // Near neighbours: an error handler that answers or passes the error on keeps the request on the error path.
  const answers = (await pack(t, body('(err, req, res, next) => { res.status(400).json({ error: \'bad request\' }); }'))).envelope;
  assert.deepEqual(both(answers, 'GET /account'), { authentication: ['1:applies'], authorization: ['2:does-not-apply'] });
  const passes = (await pack(t, body('(err, req, res, next) => { next(err); }'))).envelope;
  assert.deepEqual(both(passes, 'GET /account'), { authentication: ['1:applies'], authorization: ['2:does-not-apply'] });
  // A library layer after the refusal could be an error handler that resumes.
  const withLibrary: Record<string, string> = body('errorHandler()');
  withLibrary['src/app.ts'] = withLibrary['src/app.ts']!.replace("import { requireUser } from './auth.js';",
    "import { requireUser } from './auth.js';\nimport errorHandler from 'errorhandler';");
  const library = (await pack(t, withLibrary)).envelope;
  assert.deepEqual(both(library, 'GET /account'), {
    authentication: ['1:unknown:errorPathResumes', '2:unknown:middlewareThirdParty'], authorization: ['2:unknown:middlewareThirdParty'],
  });
});
