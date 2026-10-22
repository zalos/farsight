// PR 16: Nest request controls from a real capture → parse → analyze flow. Every case is an original synthetic tree
// copied into a temporary Git repository, captured into a real store and parsed by the public parser from the captured
// bytes; the pack reads the same bytes back. Nothing is installed and no target code runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureSnapshot } from '../dist/snapshot/index.js';
import { parseSnapshot } from '../dist/snapshot/parser.js';
import { analyzeNest, NEST_PACK, NEST_REASON_CODES, type NestAnalysis } from '../dist/frameworks/nest/index.js';
import { validateEnvelope } from '../dist/validate.js';
import { commitRepo, needsStore, openCaptureStore, scratch } from './snapshot-helpers.ts';

const HERE = import.meta.dirname;
const E2 = join(HERE, 'fixtures/framework-feasibility/sources/nest-validation');
const APP = join(HERE, 'fixtures/nest/app');

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  // `name.ts.fixture` here, `name.fixture.ts` in the accepted E2 corpus: either way the real name has no `.fixture`.
  for (const f of readdirSync(dir)) if (f.includes('.fixture')) out[f.replace('.fixture', '')] = readFileSync(join(dir, f), 'utf8');
  return out;
}

interface Run { analysis: NestAnalysis; text: Record<string, string> }

async function run(t: any, files: Record<string, string | null>, base = APP): Promise<Run> {
  const dir = scratch(t, 'sentinel-nest-');
  const root = join(dir, 'repo');
  const merged: Record<string, string> = { ...tree(base) };
  for (const [k, v] of Object.entries(files)) { if (v === null) delete merged[k]; else merged[k] = v; }
  commitRepo(root, merged);
  const { store } = await openCaptureStore(t, dir);
  const { snapshot } = await captureSnapshot(store, { mode: 'working-copy', sources: [{ sourceId: 'app', repositoryId: 'example/app', root }] });
  const work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const parsed = await parseSnapshot(store, {
    snapshotId: snapshot.id, workDir: work, selection: { gitignore: true, testFiles: 'include' },
    limits: { maxFiles: 200, maxFileBytes: 65536, maxTotalBytes: 1 << 20, maxEntries: 10000, maxDurationMs: 60000 },
  });
  const graph = (parsed.sources[0]!.artifact as any).graph;
  const analysis = await analyzeNest({ snapshot, sourceId: 'app', graph, readArtifact: id => store.readArtifact(id) });
  return { analysis, text: merged };
}

const fact = (a: NestAnalysis, surface: string, property: string) =>
  a.controls.facts.find(f => f.surfaceId === `app::route::${surface}` && f.property === property);
const surface = (a: NestAnalysis, s: string) => a.scope.surfaces.find(x => x.surfaceId === `app::route::${s}`)!;
const CODES = new Set<string>(NEST_REASON_CODES);
const reasons = (a: NestAnalysis) => {
  for (const f of a.controls.frontiers) assert.ok(CODES.has(f.reasonCode), f.reasonCode);
  for (const f of a.controls.facts) if (f.reasonCode) assert.ok(CODES.has(f.reasonCode), f.reasonCode);
  return a.controls.frontiers.map(f => f.reasonCode);
};

/** Every evidence span quotes exactly the bytes it names, in UTF-8. */
function assertSpans(r: Run) {
  for (const f of r.analysis.controls.facts) for (const e of f.evidence) {
    const bytes = Buffer.from(r.text[e.relativePath]!, 'utf8');
    assert.ok(e.span && e.span.endByte <= bytes.length && e.span.startByte < e.span.endByte, `${e.relativePath} span`);
  }
}
const quote = (r: Run, e: { relativePath: string; span?: { startByte: number; endByte: number } }) =>
  Buffer.from(r.text[e.relativePath]!, 'utf8').subarray(e.span!.startByte, e.span!.endByte).toString('utf8');

test('E2: a declared body schema validates only where a ValidationPipe is registered', needsStore, async t => {
  const r = await run(t, {}, E2);
  const a = r.analysis;
  assert.equal(validateEnvelope('controls', a.controls).ok, true);
  assert.deepEqual(a.controls.framework, { id: 'nest', version: '10.4.15' });
  const validated = fact(a, 'POST /users/validated', 'input-validation')!;
  assert.equal(validated.verdict, 'applies');
  assert.ok(validated.evidence.some(e => quote(r, e).startsWith('new ValidationPipe')));
  assert.ok(validated.evidence.some(e => quote(r, e).startsWith('@Body() dto: CreateUserDto')));
  // The same DTO with its class-validator rules and no pipe: the schema is declared, nothing enforces it.
  const unvalidated = fact(a, 'POST /users/unvalidated', 'input-validation')!;
  assert.equal(unvalidated.verdict, 'does-not-apply');
  assert.ok(unvalidated.evidence.some(e => quote(r, e).startsWith('NestFactory.create(AppModule')));
  // The health handler on the HTTP adapter bypasses the chain: named as a frontier, never one of these surfaces.
  assert.deepEqual(reasons(a), ['sentinel.nest.adapterRouteNotModeled']);
  for (const s of ['POST /users/validated', 'POST /users/unvalidated']) {
    assert.equal(fact(a, s, 'authentication')!.verdict, 'does-not-apply');
    assert.equal(fact(a, s, 'authorization')!.verdict, 'does-not-apply');
  }
  assertSpans(r);
});

test('a multipart reader only parses: the upload stays unvalidated, and Parse*Pipe is parsing, not validation', needsStore, async t => {
  const r = await run(t, {});
  const a = r.analysis;
  const upload = fact(a, 'POST /orders/import', 'input-validation')!;
  assert.equal(upload.verdict, 'does-not-apply');
  assert.ok(upload.evidence.some(e => quote(r, e) === "FileInterceptor('file')"));
  const chain = surface(a, 'POST /orders/import').chain;
  assert.deepEqual(chain.map(b => [b.stage, b.scope, b.name, b.effect]), [['interceptor', 'method', 'FileInterceptor', 'parsing']]);
  const byId = surface(a, 'GET /orders/:param').chain;
  assert.deepEqual(byId.map(b => [b.stage, b.scope, b.name, b.effect, b.parameter]), [['pipe', 'parameter', 'ParseIntPipe', 'parsing', 0]]);
  assert.equal(fact(a, 'GET /orders/:param', 'input-validation'), undefined, 'a number parameter is not a schema input');
  assert.equal(fact(a, 'POST /orders', 'input-validation')!.verdict, 'does-not-apply');
  assertSpans(r);
});

test('a global ValidationPipe, or one bound as APP_PIPE, validates every DTO body', needsStore, async t => {
  const g = await run(t, {
    'main.ts': readFileSync(join(APP, 'main.ts.fixture'), 'utf8')
      .replace("import { NestFactory } from '@nestjs/core';", "import { NestFactory } from '@nestjs/core';\nimport { ValidationPipe } from '@nestjs/common';")
      .replace('await app.listen', 'app.useGlobalPipes(new ValidationPipe({ whitelist: true }));\n  await app.listen'),
  });
  assert.equal(fact(g.analysis, 'POST /orders', 'input-validation')!.verdict, 'applies');
  assert.equal(surface(g.analysis, 'POST /orders').chain[0]!.registeredBy, 'use-global');
  // The upload has no DTO: a validator over a file the pack cannot see a schema for stays unknown.
  assert.equal(fact(g.analysis, 'POST /orders/import', 'input-validation')!.reasonCode, 'sentinel.nest.dtoUnresolved');
  const p = await run(t, {
    'app.module.ts': `import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { OrdersController } from './orders.controller';

@Module({ controllers: [OrdersController], providers: [{ provide: APP_PIPE, useClass: ValidationPipe }] })
export class AppModule {}
`,
  });
  assert.equal(fact(p.analysis, 'POST /orders', 'input-validation')!.verdict, 'applies');
  assert.equal(surface(p.analysis, 'POST /orders').chain[0]!.registeredBy, 'app-provider');
  // Options the pack cannot read leave the validator's effect unknown.
  const o = await run(t, {
    'orders.controller.ts': readFileSync(join(APP, 'orders.controller.ts.fixture'), 'utf8')
      .replace('ParseIntPipe, Post,', 'ParseIntPipe, Post, UsePipes, ValidationPipe,')
      .replace('  @Post()\n', '  @Post()\n  @UsePipes(new ValidationPipe(options))\n')
      .replace("@Controller('orders')", "const options = { whitelist: true };\n\n@Controller('orders')"),
  });
  assert.equal(fact(o.analysis, 'POST /orders', 'input-validation')!.reasonCode, 'sentinel.nest.validationOptionsUnknown');
});

test('demo: a global guard is placed first in every chain, its effect is never inferred, and a factory binding is a gap', needsStore, async t => {
  const r = await run(t, {
    'auth.guard.ts': `import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return Boolean(context.switchToHttp().getRequest().headers.authorization);
  }
}
`,
    'main.ts': readFileSync(join(APP, 'main.ts.fixture'), 'utf8')
      .replace("import { AppModule } from './app.module';", "import { AppModule } from './app.module';\nimport { AuthGuard } from './auth.guard';")
      .replace('await app.listen', 'app.useGlobalGuards(new AuthGuard());\n  await app.listen'),
    'app.module.ts': `import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OrdersController } from './orders.controller';
import { AuthGuard } from './auth.guard';

@Module({ controllers: [OrdersController], providers: [{ provide: APP_GUARD, useFactory: () => new AuthGuard() }] })
export class AppModule {}
`,
  });
  const a = r.analysis;
  // Known scope: the guard is global, local, and first.
  for (const s of a.scope.surfaces) {
    assert.deepEqual([s.chain[0]!.stage, s.chain[0]!.scope, s.chain[0]!.name, s.chain[0]!.origin, s.chain[0]!.effect], ['guard', 'global', 'AuthGuard', 'local', 'access-control-unresolved']);
  }
  assert.deepEqual(a.scope.globals.map(b => b.name), ['AuthGuard']);
  // The gap: the factory binding is a frontier, and the name AuthGuard proves nothing.
  assert.ok(reasons(a).includes('sentinel.nest.unknownFactory'));
  for (const f of a.controls.facts.filter(f => f.property === 'authentication' || f.property === 'authorization')) {
    assert.equal(f.verdict, 'unknown');
  }
  // A frontier anywhere in the registration graph leaves even the unvalidated body unknown.
  assert.equal(fact(a, 'POST /orders', 'input-validation')!.verdict, 'unknown');
  assert.equal(fact(a, 'POST /orders', 'input-validation')!.reasonCode, 'sentinel.nest.unknownFactory');
});

test('dynamic modules, middleware, custom decorators and inherited controllers stay explicit frontiers', needsStore, async t => {
  const dyn = await run(t, {
    'app.module.ts': `import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OrdersController } from './orders.controller';

@Module({ imports: [ConfigModule.forRoot()], controllers: [OrdersController] })
export class AppModule {}
`,
  });
  assert.ok(reasons(dyn.analysis).includes('sentinel.nest.dynamicModule'));
  assert.ok(dyn.analysis.controls.facts.every(f => f.verdict === 'unknown'));

  const mw = await run(t, { 'main.ts': readFileSync(join(APP, 'main.ts.fixture'), 'utf8').replace('await app.listen', 'app.use((req: unknown, res: unknown, next: () => void) => next());\n  await app.listen') });
  assert.ok(reasons(mw.analysis).includes('sentinel.nest.middlewareNotModeled'));
  assert.ok(mw.analysis.controls.facts.every(f => f.verdict === 'unknown'));

  const custom = await run(t, {
    'roles.decorator.ts': `import { applyDecorators, UseGuards } from '@nestjs/common';
import { RolesGuard } from './roles.guard';

export const Admin = () => applyDecorators(UseGuards(RolesGuard));
`,
    'roles.guard.ts': `export class RolesGuard {
  canActivate(): boolean {
    return true;
  }
}
`,
    'orders.controller.ts': readFileSync(join(APP, 'orders.controller.ts.fixture'), 'utf8')
      .replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { Admin } from './roles.decorator';")
      .replace('  @Post()\n', '  @Post()\n  @Admin()\n'),
  });
  assert.deepEqual(surface(custom.analysis, 'POST /orders').frontiers, ['sentinel.nest.customDecorator']);
  assert.equal(fact(custom.analysis, 'POST /orders', 'authorization')!.reasonCode, 'sentinel.nest.customDecorator');
  assert.equal(fact(custom.analysis, 'GET /orders/:param', 'authorization')!.verdict, 'does-not-apply', 'the frontier is the surface\'s own');

  const inherited = await run(t, {
    'base.controller.ts': `export class BaseController {
  ping() {
    return 'pong';
  }
}
`,
    'orders.controller.ts': readFileSync(join(APP, 'orders.controller.ts.fixture'), 'utf8')
      .replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { BaseController } from './base.controller';")
      .replace('export class OrdersController {', 'export class OrdersController extends BaseController {'),
  });
  for (const s of inherited.analysis.scope.surfaces) assert.ok(s.frontiers.includes('sentinel.nest.inheritedController'));
  assert.ok(inherited.analysis.controls.facts.every(f => f.verdict === 'unknown'));
});

test('a guard bound at controller and method scope is ordered global → controller → method and never proves access control', needsStore, async t => {
  const r = await run(t, {
    'session.guard.ts': `export class SessionGuard {
  canActivate(): boolean {
    return true;
  }
}
`,
    'orders.controller.ts': readFileSync(join(APP, 'orders.controller.ts.fixture'), 'utf8')
      .replace('ParseIntPipe, Post,', 'ParseIntPipe, Post, UseGuards,')
      .replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { SessionGuard } from './session.guard';\nimport { ThrottleGuard } from 'external-throttle';")
      .replace("@Controller('orders')", "@UseGuards(SessionGuard)\n@Controller('orders')")
      .replace('  @Post()\n', '  @Post()\n  @UseGuards(ThrottleGuard)\n'),
  });
  const chain = surface(r.analysis, 'POST /orders').chain;
  assert.deepEqual(chain.slice(0, 2).map(b => [b.scope, b.name, b.origin]), [['controller', 'SessionGuard', 'local'], ['method', 'ThrottleGuard', 'external']]);
  assert.equal(fact(r.analysis, 'POST /orders', 'authentication')!.reasonCode, 'sentinel.nest.guardEffectUnresolved');
  assert.equal(fact(r.analysis, 'POST /orders', 'authentication')!.order, 0);
});

test('only the exact captured Nest version is supported; anything else leaves every fact unknown', needsStore, async t => {
  const r = await run(t, { 'package.json': readFileSync(join(APP, 'package.json.fixture'), 'utf8').replaceAll('"10.4.15"', '"^10.4.15"') });
  assert.equal(r.analysis.controls.framework.version, null);
  assert.ok(reasons(r.analysis).includes('sentinel.nest.versionUnresolved'));
  assert.ok(r.analysis.controls.facts.every(f => f.verdict === 'unknown' && f.evidence.length === 0));
  const other = await run(t, { 'package.json': readFileSync(join(APP, 'package.json.fixture'), 'utf8').replaceAll('"10.4.15"', '"10.4.14"') });
  assert.ok(reasons(other.analysis).includes('sentinel.nest.versionUnsupported'));
  // A lockfile's resolved version wins over the manifest's pin.
  const locked = await run(t, {
    'package.json': readFileSync(join(APP, 'package.json.fixture'), 'utf8').replaceAll('"10.4.15"', '"^10.0.0"'),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@nestjs/common': { version: '10.4.15' }, 'node_modules/@nestjs/core': { version: '10.4.15' }, 'node_modules/class-validator': { version: '0.14.1' } } }),
  });
  assert.equal(locked.analysis.scope.framework.provenance, 'package-lock.json');
  assert.equal(fact(locked.analysis, 'POST /orders', 'input-validation')!.verdict, 'does-not-apply');
});

test('evidence spans are UTF-8 byte offsets of the captured bytes, and the analysis is deterministic', needsStore, async t => {
  const files = {
    'orders.controller.ts': readFileSync(join(APP, 'orders.controller.ts.fixture'), 'utf8')
      .replace("@Controller('orders')", "// Bestellungen — für Kund😀innen\n@Controller('orders')")
      .replace('  @Post()\n', '  // Änderung ✓\n  @Post()\n'),
  };
  const r = await run(t, files);
  const upload = fact(r.analysis, 'POST /orders/import', 'input-validation')!;
  assert.ok(upload.evidence.some(e => quote(r, e) === "FileInterceptor('file')"));
  assert.ok(upload.evidence.some(e => quote(r, e) === '@UploadedFile() file: Express.Multer.File'));
  assertSpans(r);
  const again = await run(t, files);
  assert.deepEqual(again.analysis.controls.facts.map(f => [f.id, f.verdict]), r.analysis.controls.facts.map(f => [f.id, f.verdict]));
  assert.equal(again.analysis.controls.registrationDigest, r.analysis.controls.registrationDigest);
  assert.equal(again.analysis.controls.packDigest, r.analysis.controls.packDigest);
  assert.ok(Object.isFrozen(r.analysis.controls.facts));
});

test('the support manifest names the one supported version and never infers a guard\'s effect', () => {
  assert.equal(NEST_PACK.versions['@nestjs/common'], '10.4.15');
  assert.equal(NEST_PACK.guardEffect, 'never-inferred');
});

test('a name proves nothing: a local ValidationPipe, an unresolved provider and an unregistered controller stay unknown', needsStore, async t => {
  const ctl = readFileSync(join(APP, 'orders.controller.ts.fixture'), 'utf8');
  const shadow = await run(t, {
    'validation.pipe.ts': `export class ValidationPipe {
  transform(value: unknown) {
    return value;
  }
}
`,
    'orders.controller.ts': ctl.replace('ParseIntPipe, Post,', 'ParseIntPipe, Post, UsePipes,')
      .replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { ValidationPipe } from './validation.pipe';")
      .replace('  @Post()\n', '  @Post()\n  @UsePipes(new ValidationPipe())\n'),
  });
  const b = surface(shadow.analysis, 'POST /orders').chain[0]!;
  assert.deepEqual([b.name, b.origin, b.effect], ['ValidationPipe', 'local', 'unknown']);
  assert.equal(fact(shadow.analysis, 'POST /orders', 'input-validation')!.reasonCode, 'sentinel.nest.pipeEffectUnresolved');

  const di = await run(t, {
    'app.module.ts': `import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { OrdersController } from './orders.controller';
import { StrictPipe } from './strict.pipe';

@Module({ controllers: [OrdersController], providers: [{ provide: APP_PIPE, useClass: StrictPipe }] })
export class AppModule {}
`,
  });
  assert.equal(surface(di.analysis, 'POST /orders').chain[0]!.origin, 'unresolved');
  assert.equal(fact(di.analysis, 'POST /orders', 'input-validation')!.reasonCode, 'sentinel.nest.pipeEffectUnresolved');

  const unregistered = await run(t, { 'app.module.ts': "import { Module } from '@nestjs/common';\n\n@Module({})\nexport class AppModule {}\n" });
  for (const s of unregistered.analysis.scope.surfaces) assert.deepEqual(s.frontiers, ['sentinel.nest.controllerNotRegistered']);
  assert.ok(unregistered.analysis.controls.facts.every(f => f.verdict === 'unknown'));

  const param = await run(t, {
    'orders.controller.ts': ctl.replace('ParseIntPipe, Post,', 'ParseIntPipe, Post, ValidationPipe,').replace('@Body() dto', '@Body(new ValidationPipe()) dto'),
  });
  const v = fact(param.analysis, 'POST /orders', 'input-validation')!;
  assert.equal(v.verdict, 'applies');
  assert.equal(surface(param.analysis, 'POST /orders').chain[0]!.scope, 'parameter');
  // A validator beside a pipe the pack cannot model, or under a frontier, is not known to validate what arrives.
  const mixed = await run(t, {
    'orders.controller.ts': ctl.replace('ParseIntPipe, Post,', 'ParseIntPipe, Post, ValidationPipe,')
      .replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { TrimPipe } from './trim.pipe';")
      .replace('@Body() dto', '@Body(TrimPipe, new ValidationPipe()) dto'),
    'trim.pipe.ts': 'export class TrimPipe {\n  transform(value: unknown) {\n    return value;\n  }\n}\n',
  });
  assert.equal(fact(mixed.analysis, 'POST /orders', 'input-validation')!.reasonCode, 'sentinel.nest.pipeEffectUnresolved');
});

// ---- review regressions: a registration counts only where it certainly runs, on the application, under its own name

const ctlText = () => readFileSync(join(APP, 'orders.controller.ts.fixture'), 'utf8');
/** A bootstrap with `body` after the create; `head` goes above the function, `call` invokes it. */
function mainWith(body: string, head = '', call = 'bootstrap();', params = '') {
  return `import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
${head}
async function bootstrap(${params}) {
  const app = await NestFactory.create(AppModule);
${body}
  await app.listen(3000);
}
${call}
`;
}
const validation = (a: NestAnalysis) => fact(a, 'POST /orders', 'input-validation')!;

test('SOL: a registration that cannot run, or runs on another binding, is never protection', needsStore, async t => {
  const reachable = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());') });
  assert.equal(validation(reachable.analysis).verdict, 'applies', 'the near neighbour: unconditional, before listen');
  const dead = await run(t, { 'main.ts': mainWith('  if (false) app.useGlobalPipes(new ValidationPipe());') });
  assert.deepEqual(dead.analysis.scope.globals, []);
  assert.equal(validation(dead.analysis).verdict, 'unknown');
  assert.equal(validation(dead.analysis).reasonCode, 'sentinel.nest.registrationNotFollowed');
  const tried = await run(t, { 'main.ts': mainWith('  try {\n    app.useGlobalPipes(new ValidationPipe());\n  } catch {}') });
  assert.equal(validation(tried.analysis).reasonCode, 'sentinel.nest.registrationNotFollowed');
  const late = await run(t, { 'main.ts': mainWith('  await app.init();\n  app.useGlobalPipes(new ValidationPipe());') });
  assert.equal(validation(late.analysis).reasonCode, 'sentinel.nest.registrationNotFollowed', 'after initialization');
  const afterExit = await run(t, { 'main.ts': mainWith('  if (process.env.SKIP) return;\n  app.useGlobalPipes(new ValidationPipe());') });
  assert.equal(validation(afterExit.analysis).reasonCode, 'sentinel.nest.registrationNotFollowed', 'after a possible return');
  const unrelated = await run(t, { 'main.ts': mainWith('', 'function configure(app: { useGlobalPipes(p: unknown): void }) {\n  app.useGlobalPipes(new ValidationPipe());\n}') });
  assert.deepEqual(unrelated.analysis.scope.globals, [], 'a parameter named app is another binding');
  assert.equal(validation(unrelated.analysis).reasonCode, 'sentinel.nest.registrationNotFollowed');
  const escapes = await run(t, { 'main.ts': mainWith('  configure(app);', 'function configure(target: { useGlobalPipes(p: unknown): void }) {\n  target.useGlobalPipes(new ValidationPipe());\n}') });
  assert.ok(reasons(escapes.analysis).includes('sentinel.nest.applicationEscapes'));
  assert.equal(validation(escapes.analysis).verdict, 'unknown');
  const notRun = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', '', 'export { bootstrap };') });
  assert.ok(reasons(notRun.analysis).includes('sentinel.nest.bootstrapNotInvoked'));
  assert.equal(validation(notRun.analysis).verdict, 'unknown');
  const chained = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', '', 'bootstrap().catch(() => process.exit(1));') });
  assert.equal(validation(chained.analysis).verdict, 'applies', 'invoked through a promise chain');
});

test('SOL: a name rebound in a nested scope is not the import, while an aliased import is', needsStore, async t => {
  const param = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', '', 'bootstrap(class {\n  transform(value: unknown) {\n    return value;\n  }\n});', 'ValidationPipe: new () => unknown') });
  const b = param.analysis.scope.globals[0]!;
  assert.deepEqual([b.name, b.origin, b.effect], ['ValidationPipe', 'unresolved', 'unknown']);
  assert.equal(validation(param.analysis).reasonCode, 'sentinel.nest.pipeEffectUnresolved');
  const local = await run(t, { 'main.ts': mainWith('  const ValidationPipe = class {\n    transform(value: unknown) {\n      return value;\n    }\n  };\n  app.useGlobalPipes(new ValidationPipe());') });
  assert.equal(validation(local.analysis).reasonCode, 'sentinel.nest.pipeEffectUnresolved');
  const aliased = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new Check());').replace("import { ValidationPipe } from '@nestjs/common';", "import { ValidationPipe as Check } from '@nestjs/common';") });
  assert.equal(validation(aliased.analysis).verdict, 'applies');
  const ns = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new common.ValidationPipe());').replace("import { ValidationPipe } from '@nestjs/common';", "import * as common from '@nestjs/common';") });
  assert.equal(validation(ns.analysis).verdict, 'applies', 'a namespace import');
});

test('SOL: conditional validation, weakening options and missing decorator metadata are never applies', needsStore, async t => {
  const dto = readFileSync(join(APP, 'create-order.dto.ts.fixture'), 'utf8');
  const global = { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());') };
  const conditional = await run(t, { ...global, 'create-order.dto.ts': dto.replace("import { IsInt, IsString, Min } from 'class-validator';", "import { IsInt, IsString, Min, ValidateIf } from 'class-validator';").replace('  @IsString()\n', '  @ValidateIf(() => false)\n  @IsString()\n') });
  assert.equal(validation(conditional.analysis).reasonCode, 'sentinel.nest.dtoConditional');
  const optional = await run(t, { ...global, 'create-order.dto.ts': dto.replace("import { IsInt, IsString, Min } from 'class-validator';", "import { IsInt, IsOptional, IsString, Min } from 'class-validator';").replace('  @IsString()\n', '  @IsOptional()\n  @IsString()\n') });
  assert.equal(validation(optional.analysis).reasonCode, 'sentinel.nest.dtoConditional');
  const grouped = await run(t, { ...global, 'create-order.dto.ts': dto.replace('  @IsString()\n', "  @IsString({ groups: ['create'] })\n") });
  assert.equal(validation(grouped.analysis).reasonCode, 'sentinel.nest.dtoConditional');
  const skipping = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe({ skipMissingProperties: true }));') });
  assert.equal(validation(skipping.analysis).reasonCode, 'sentinel.nest.validationOptionsUnknown');
  const safe = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));') });
  assert.equal(validation(safe.analysis).verdict, 'applies');
  assert.ok(validation(safe.analysis).evidence.some(e => quote(safe, e) === '"emitDecoratorMetadata": true'), 'the metadata setting is cited');
  const off = await run(t, { ...global, 'tsconfig.json': '{ "compilerOptions": { "experimentalDecorators": true, "emitDecoratorMetadata": false } }\n' });
  assert.equal(validation(off.analysis).reasonCode, 'sentinel.nest.decoratorMetadataOff');
  const unset = await run(t, { ...global, 'tsconfig.json': '{ "compilerOptions": { "experimentalDecorators": true } }\n' });
  assert.equal(validation(unset.analysis).reasonCode, 'sentinel.nest.decoratorMetadataOff');
  const inherited = await run(t, { ...global, 'tsconfig.json': '{ "extends": "./tsconfig.base.json" }\n' });
  assert.equal(validation(inherited.analysis).reasonCode, 'sentinel.nest.decoratorMetadataUnknown');
  const none = await run(t, { ...global, 'tsconfig.json': null });
  assert.equal(validation(none.analysis).reasonCode, 'sentinel.nest.decoratorMetadataUnknown');
  const swc = await run(t, { ...global, 'nest-cli.json': '{ "compilerOptions": { "builder": "swc" } }\n' });
  assert.equal(validation(swc.analysis).reasonCode, 'sentinel.nest.decoratorMetadataUnknown');
  // Without metadata nothing validates either way: a surface with no pipe is still does-not-apply.
  assert.equal(fact(off.analysis, 'POST /orders/import', 'input-validation')!.verdict, 'unknown', 'a global validator over an upload has no DTO');
});

test('SOL: stacked decorators register bottom to top, each decorator’s arguments in order', needsStore, async t => {
  const r = await run(t, {
    'trim.pipe.ts': 'export class TrimPipe {\n  transform(value: unknown) {\n    return value;\n  }\n}\n',
    'audit.guard.ts': 'export class AuditGuard {\n  canActivate(): boolean {\n    return true;\n  }\n}\n',
    'orders.controller.ts': ctlText().replace('ParseIntPipe, Post,', 'ParseIntPipe, Post, UseGuards, UsePipes, ValidationPipe,')
      .replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { TrimPipe } from './trim.pipe';\nimport { AuditGuard } from './audit.guard';\nimport { ThrottleGuard } from 'external-throttle';")
      .replace('  @Post()\n', '  @Post()\n  @UsePipes(new ValidationPipe(), DefaultValuePipe)\n  @UsePipes(TrimPipe)\n  @UseGuards(AuditGuard)\n  @UseGuards(ThrottleGuard)\n')
      .replace('ParseIntPipe, Post,', 'ParseIntPipe, DefaultValuePipe, Post,'),
  });
  const chain = surface(r.analysis, 'POST /orders').chain.map(b => `${b.stage}:${b.name}`);
  assert.deepEqual(chain, ['guard:ThrottleGuard', 'guard:AuditGuard', 'pipe:TrimPipe', 'pipe:ValidationPipe', 'pipe:DefaultValuePipe']);
  assert.equal(validation(r.analysis).reasonCode, 'sentinel.nest.pipeEffectUnresolved', 'the unmodeled pipe runs first');
});

test('SOL: a DTO whose rules are not constraints, or live in code the pack does not read, is not validated', needsStore, async t => {
  const global = { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());') };
  const allowOnly = await run(t, { ...global, 'create-order.dto.ts': "import { Allow } from 'class-validator';\n\nexport class CreateOrderDto {\n  @Allow()\n  sku!: string;\n}\n" });
  assert.equal(validation(allowOnly.analysis).reasonCode, 'sentinel.nest.dtoWithoutRules', 'Allow only exempts a property from whitelisting');
  const allowAndRule = await run(t, { ...global, 'create-order.dto.ts': "import { Allow, IsString } from 'class-validator';\n\nexport class CreateOrderDto {\n  @Allow()\n  note!: string;\n\n  @IsString()\n  sku!: string;\n}\n" });
  assert.equal(validation(allowAndRule.analysis).verdict, 'applies', 'the near neighbour: a real constraint beside it');
  const custom = await run(t, { ...global, 'create-order.dto.ts': "import { Validate } from 'class-validator';\nimport { SkuRule } from './sku.rule';\n\nexport class CreateOrderDto {\n  @Validate(SkuRule)\n  sku!: string;\n}\n", 'sku.rule.ts': 'export class SkuRule {\n  validate(): boolean {\n    return true;\n  }\n}\n' });
  assert.equal(validation(custom.analysis).verdict, 'unknown');
  assert.equal(validation(custom.analysis).reasonCode, 'sentinel.nest.dtoConditional');
  const nested = await run(t, { ...global, 'create-order.dto.ts': "import { IsString, ValidateNested } from 'class-validator';\n\nexport class CreateOrderDto {\n  @IsString()\n  sku!: string;\n\n  @ValidateNested()\n  address!: object;\n}\n" });
  assert.equal(validation(nested.analysis).reasonCode, 'sentinel.nest.dtoConditional');
});

test('SOL: an interceptor the pack does not model can answer before the pipes, so validation is not established', needsStore, async t => {
  const ctl = ctlText().replace('ParseIntPipe, Post,', 'ParseIntPipe, Post, UseInterceptors,');
  const echo = `import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { of } from 'rxjs';

@Injectable()
export class EchoInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, _next: CallHandler) {
    return of(context.switchToHttp().getRequest().body);
  }
}
`;
  const shortCircuit = await run(t, {
    'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());'), 'echo.interceptor.ts': echo,
    'orders.controller.ts': ctl.replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { EchoInterceptor } from './echo.interceptor';")
      .replace('  @Post()\n', '  @Post()\n  @UseInterceptors(EchoInterceptor)\n'),
  });
  assert.equal(validation(shortCircuit.analysis).verdict, 'unknown');
  assert.equal(validation(shortCircuit.analysis).reasonCode, 'sentinel.nest.interceptorEffectUnresolved');
  const serializer = await run(t, {
    'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());'),
    'orders.controller.ts': ctl.replace('ParseIntPipe, Post, UseInterceptors,', 'ClassSerializerInterceptor, ParseIntPipe, Post, UseInterceptors,')
      .replace('  @Post()\n', '  @Post()\n  @UseInterceptors(ClassSerializerInterceptor)\n'),
  });
  assert.equal(validation(serializer.analysis).verdict, 'applies', 'the near neighbour: a framework interceptor that calls the handler');
  // Without a validator, unmodeled code that may check the input leaves "no validation" unproven too.
  const noPipe = await run(t, { 'echo.interceptor.ts': echo, 'orders.controller.ts': ctl.replace("import { CreateOrderDto } from './create-order.dto';", "import { CreateOrderDto } from './create-order.dto';\nimport { EchoInterceptor } from './echo.interceptor';").replace('  @Post()\n', '  @Post()\n  @UseInterceptors(EchoInterceptor)\n') });
  assert.equal(validation(noPipe.analysis).reasonCode, 'sentinel.nest.interceptorEffectUnresolved');
});

test('SOL: versions are those of the project that owns the files, not the repository root', needsStore, async t => {
  const app = tree(APP);
  const under = (prefix: string, extra: Record<string, string> = {}) => {
    const out: Record<string, string | null> = Object.fromEntries(Object.keys(app).map(k => [k, null]));
    for (const [k, v] of Object.entries(app)) out[`${prefix}/${k}`] = v;
    for (const [k, v] of Object.entries(extra)) out[k] = v;
    return out;
  };
  const root = app['package.json']!;
  const nine = root.replaceAll('"10.4.15"', '"9.4.3"');
  const nested = await run(t, under('apps/api', { 'package.json': root, 'apps/api/package.json': nine }));
  assert.equal(nested.analysis.controls.framework.version, null, 'the controllers belong to the Nest 9 project');
  assert.ok(nested.analysis.controls.frontiers.some(f => f.scopeId === 'app:apps/api/package.json' && f.reasonCode === 'sentinel.nest.versionUnsupported'));
  assert.ok(nested.analysis.controls.facts.every(f => f.verdict === 'unknown'));
  const hoisted = await run(t, under('apps/api', { 'package.json': root, 'apps/api/package.json': '{ "name": "api", "private": true }\n' }));
  assert.equal(hoisted.analysis.controls.framework.version, '10.4.15', 'the near neighbour: a nested manifest without Nest belongs to the root project');
  const lockfile = JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/@nestjs/common': { version: '10.4.15' }, 'node_modules/@nestjs/core': { version: '10.4.15' }, 'node_modules/class-validator': { version: '0.14.1' },
    'apps/api/node_modules/@nestjs/common': { version: '9.4.3' },
  } });
  const nestedInstall = await run(t, under('apps/api', { 'package.json': root, 'apps/api/package.json': root.replaceAll('"10.4.15"', '"^9.0.0"'), 'package-lock.json': lockfile }));
  assert.equal(nestedInstall.analysis.controls.framework.version, null, 'its own install of @nestjs/common shadows the hoisted one');
});

// ---- third review: decorators the pack cannot prove harmless, per-file dependency resolution, rewritten code

test('SOL: a DTO decorator that is not class-validator’s own is never treated as harmless', needsStore, async t => {
  const global = { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());') };
  const dto = readFileSync(join(APP, 'create-order.dto.ts.fixture'), 'utf8');
  const never = await run(t, { ...global,
    'never.ts': "import { ValidateIf } from 'class-validator';\n\nexport const Never = () => ValidateIf(() => false);\n",
    'create-order.dto.ts': dto.replace("import { IsInt, IsString, Min } from 'class-validator';", "import { IsInt, IsString, Min } from 'class-validator';\nimport { Never } from './never';").replace('  @IsString()\n', '  @Never()\n  @IsString()\n').replace('  @IsInt()\n', '  @Never()\n  @IsInt()\n'),
  });
  assert.equal(validation(never.analysis).verdict, 'unknown');
  assert.equal(validation(never.analysis).reasonCode, 'sentinel.nest.dtoConditional');
  const transformer = await run(t, { ...global, 'create-order.dto.ts': dto.replace("import { IsInt, IsString, Min } from 'class-validator';", "import { IsInt, IsString, Min } from 'class-validator';\nimport { Transform } from 'class-transformer';").replace('  @IsString()\n', '  @Transform(() => undefined)\n  @IsString()\n') });
  assert.equal(validation(transformer.analysis).reasonCode, 'sentinel.nest.dtoConditional');
  const options = await run(t, { ...global, 'create-order.dto.ts': dto.replace('  @IsString()\n', '  @IsString(SKU_OPTIONS)\n').replace('export class', 'const SKU_OPTIONS = {};\n\nexport class') });
  assert.equal(validation(options.analysis).reasonCode, 'sentinel.nest.dtoConditional', 'options the pack cannot read could hold groups');
  const literals = await run(t, { ...global, 'create-order.dto.ts': dto.replace('  @Min(1)\n', "  @Min(1, { message: 'at least one' })\n") });
  assert.equal(validation(literals.analysis).verdict, 'applies', 'the near neighbour: literal constraints and a message');
});

test('SOL: each dependency resolves from the file that loads it, and the pipe and the DTO must share one supported copy', needsStore, async t => {
  const global = { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());') };
  const app = tree(APP);
  const moved = {
    ...global, 'create-order.dto.ts': null, 'dto/create-order.dto.ts': app['create-order.dto.ts']!,
    'orders.controller.ts': ctlText().replace("from './create-order.dto'", "from './dto/create-order.dto'"),
  };
  const own = await run(t, { ...moved, 'dto/package.json': '{ "name": "dto", "private": true, "dependencies": { "class-validator": "0.13.2" } }\n' });
  assert.equal(validation(own.analysis).reasonCode, 'sentinel.nest.classValidatorUnsupported', 'the DTO registers with its own class-validator 0.13.2');
  const plain = await run(t, { ...moved, 'dto/package.json': '{ "name": "dto", "private": true }\n' });
  assert.equal(validation(plain.analysis).verdict, 'applies', 'the near neighbour: a manifest that does not declare it resolves on up');
  const ranged = await run(t, { ...moved, 'dto/package.json': '{ "name": "dto", "private": true, "dependencies": { "class-validator": "^0.14.0" } }\n' });
  assert.equal(validation(ranged.analysis).reasonCode, 'sentinel.nest.classValidatorUnsupported', 'a range without a lockfile is unresolved');
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/@nestjs/common': { version: '10.4.15' }, 'node_modules/@nestjs/core': { version: '10.4.15' }, 'node_modules/class-validator': { version: '0.14.1' },
    'dto/node_modules/class-validator': { version: '0.14.1' },
  } });
  const twoCopies = await run(t, { ...moved, 'dto/package.json': '{ "name": "dto", "private": true, "dependencies": { "class-validator": "^0.14.0" } }\n', 'package-lock.json': lock });
  assert.equal(validation(twoCopies.analysis).reasonCode, 'sentinel.nest.classValidatorUnsupported', 'the same version, but another copy than the pipe loads');
  const hoisted = await run(t, { ...moved, 'dto/package.json': '{ "name": "dto", "private": true, "dependencies": { "class-validator": "^0.14.0" } }\n', 'package-lock.json': lock.replace(',"dto/node_modules/class-validator":{"version":"0.14.1"}', '') });
  assert.equal(validation(hoisted.analysis).verdict, 'applies', 'the near neighbour: one hoisted copy');
});

test('SOL: replacing the application’s methods, or the framework’s, invalidates what the calls appear to register', needsStore, async t => {
  const mutated = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes = () => app;\n  app.useGlobalPipes(new ValidationPipe());') });
  assert.ok(reasons(mutated.analysis).includes('sentinel.nest.applicationMutated'));
  assert.equal(validation(mutated.analysis).verdict, 'unknown');
  const prototype = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', 'ValidationPipe.prototype.transform = async (value: unknown) => value;') });
  assert.ok(reasons(prototype.analysis).includes('sentinel.nest.frameworkMutated'));
  assert.equal(validation(prototype.analysis).verdict, 'unknown');
  const defined = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', "Object.defineProperty(ValidationPipe.prototype, 'transform', { value: (v: unknown) => v });") });
  assert.ok(reasons(defined.analysis).includes('sentinel.nest.frameworkMutated'));
  const metadata = await run(t, { 'main.ts': mainWith("  Reflect.defineMetadata('design:paramtypes', [Object], app, 'x');\n  app.useGlobalPipes(new ValidationPipe());") });
  assert.ok(reasons(metadata.analysis).includes('sentinel.nest.frameworkMutated'));
  const reads = await run(t, { 'main.ts': mainWith('  const port = app.getHttpServer;\n  app.useGlobalPipes(new ValidationPipe());') });
  assert.equal(validation(reads.analysis).verdict, 'applies', 'the near neighbour: reading a member changes nothing');
});

test('framework mutations through local aliases leave validation unknown', needsStore, async t => {
  for (const mutation of [
    'const Alias = ValidationPipe; Alias.prototype.transform = async (v: unknown) => v;',
    'const Alias = ValidationPipe; Object.assign(Alias.prototype, { transform: async (v: unknown) => v });',
    'const Alias = ValidationPipe; const Other = Alias; Other["prototype"]["transform"] = async (v: unknown) => v;',
    'const Alias = ValidationPipe as typeof ValidationPipe; (Alias as any).prototype.transform = async (v: unknown) => v;',
    'const Alias = process.env.FAKE ? class {} : ValidationPipe; Object.assign(Alias.prototype, { transform: (v: unknown) => v });',
    'let Alias; Alias = ValidationPipe; Reflect.defineProperty(Alias.prototype, "transform", { value: (v: unknown) => v });',
  ]) {
    const r = await run(t, { 'main.ts': mainWith(`  ${mutation}\n  app.useGlobalPipes(new ValidationPipe());`) });
    assert.equal(validation(r.analysis).verdict, 'unknown', mutation);
    assert.ok(reasons(r.analysis).includes('sentinel.nest.frameworkMutated'), mutation);
  }
  const local = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', `
const Alias = ValidationPipe;
function unrelated(Alias: { prototype: { transform: unknown } }) {
  Alias.prototype.transform = (v: unknown) => v;
}`) });
  assert.equal(validation(local.analysis).verdict, 'applies', 'a parameter shadowing the alias is another object');
});

test('global ValidationPipe dependencies resolve from the registration file and actual installed copy', needsStore, async t => {
  const nested = Object.fromEntries(Object.entries(tree(APP)).filter(([p]) => p !== 'package.json' && p !== 'main.ts').map(([p, text]) => [`nested/${p}`, text]));
  const pkg = readFileSync(join(APP, 'package.json.fixture'), 'utf8');
  const files = {
    'app.module.ts': null, 'orders.controller.ts': null, 'create-order.dto.ts': null, ...nested,
    'package.json': pkg.replaceAll('0.14.1', '0.13.2'), 'nested/package.json': pkg,
    'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());').replace("from './app.module'", "from './nested/app.module'"),
  };
  const unpinned = await run(t, files);
  assert.equal(validation(unpinned.analysis).verdict, 'unknown');
  assert.equal(validation(unpinned.analysis).reasonCode, 'sentinel.nest.classValidatorUnsupported');
  const installs: Record<string, { version: string }> = {};
  for (const prefix of ['', 'nested/']) for (const name of ['@nestjs/common', '@nestjs/core', 'class-validator']) {
    installs[`${prefix}node_modules/${name}`] = { version: name === 'class-validator' ? (prefix ? '0.14.1' : '0.13.2') : '10.4.15' };
  }
  const locked = await run(t, { ...files, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: installs }) });
  assert.equal(validation(locked.analysis).verdict, 'unknown');
  assert.equal(validation(locked.analysis).reasonCode, 'sentinel.nest.classValidatorUnsupported');
  // Supported versions in separate installs still register decorator metadata in different copies.
  installs['node_modules/class-validator'] = { version: '0.14.1' };
  const copies = await run(t, { ...files, 'package.json': pkg, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: installs }) });
  assert.equal(validation(copies.analysis).verdict, 'unknown');
  assert.equal(validation(copies.analysis).reasonCode, 'sentinel.nest.classValidatorUnsupported');
  // Hoisting both the pipe dependency and DTO decorators to one supported copy restores the positive control.
  delete installs['nested/node_modules/class-validator'];
  const shared = await run(t, { ...files, 'package.json': pkg, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: installs }) });
  assert.equal(validation(shared.analysis).verdict, 'applies');
});

// These fixtures are captured and parsed, never executed. Constructors can reach writes through syntax this pack
// deliberately does not interpret. A named frontier must replace both validation credit and absence claims.
const frameworkEscapeCases = {
  'sequence initializer': 'const Alias = (Date.now(), ValidationPipe); Alias.prototype.transform = async (v: unknown) => v;',
  'object destructuring': 'const { Alias } = { Alias: ValidationPipe }; Alias.prototype.transform = async (v: unknown) => v;',
  'ordinary function parameter': 'function disable(Pipe: any) { Pipe.prototype.transform = async (v: unknown) => v; } disable(ValidationPipe);',
  'array storage': 'const aliases = [ValidationPipe]; aliases[0].prototype.transform = async (v: unknown) => v;',
  'returned constructor': 'function getPipe() { return ValidationPipe; } const Alias = getPipe(); Alias.prototype.transform = async (v: unknown) => v;',
  'object member assignment': 'const holder: any = {}; holder.pipe = ValidationPipe; holder.pipe.prototype.transform = async (v: unknown) => v;',
  'typed alias parameter': 'const Alias = ValidationPipe as typeof ValidationPipe; function disable(Pipe: any) { Pipe.prototype.transform = async (v: unknown) => v; } disable(Alias);',
  'default parameter': 'function disable(Pipe = ValidationPipe) { Pipe.prototype.transform = async (v: unknown) => v; } disable();',
  'class field storage': 'class Holder { pipe = ValidationPipe; } new Holder().pipe.prototype.transform = async (v: unknown) => v;',
  'for-of aggregate': 'for (const Alias of [ValidationPipe]) { Alias.prototype.transform = async (v: unknown) => v; }',
  'direct sequence member write': '(Date.now(), ValidationPipe).prototype.transform = async (v: unknown) => v;',
  'awaited constructor': '(await ValidationPipe).prototype.transform = async (v: unknown) => v;',
  'bound constructor method': 'const Alias = ValidationPipe.bind(null); Alias.prototype.transform = async (v: unknown) => v;',
};
for (const [name, mutation] of Object.entries(frameworkEscapeCases)) {
  test(`framework escape: ${name} leaves validation unknown`, needsStore, async t => {
    const r = await run(t, { 'main.ts': mainWith(`  ${mutation}\n  app.useGlobalPipes(new ValidationPipe());`) });
    assert.equal(validation(r.analysis).verdict, 'unknown');
    assert.ok(reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
    assert.ok(r.analysis.controls.facts.every(f => f.verdict === 'unknown'), 'a possible framework rewrite also prevents false absence');
  });
}

test('framework escape: type and property names do not pass a framework value', needsStore, async t => {
  const r = await run(t, { 'main.ts': mainWith(`
  const names = { ValidationPipe: 'label' };
  const typed = 'label' as unknown as typeof ValidationPipe;
  consume(names.ValidationPipe);
  consume(typed);
  app.useGlobalPipes(new ValidationPipe());`, 'function consume(value: unknown) { return value; }') });
  assert.equal(validation(r.analysis).verdict, 'applies');
  assert.ok(!reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
});

test('framework escape: supported local alias and unrelated shadow retain validation', needsStore, async t => {
  const r = await run(t, { 'main.ts': mainWith(`
  const Alias = ValidationPipe;
  function unrelated(Alias: { prototype: { transform: unknown } }) {
    Alias.prototype.transform = (v: unknown) => v;
  }
  app.useGlobalPipes(new ValidationPipe());`) });
  assert.equal(validation(r.analysis).verdict, 'applies');
  assert.ok(!reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
  assert.ok(!reasons(r.analysis).includes('sentinel.nest.frameworkMutated'));
});

// Runtime reference uses that were not in the earlier syntax list must default to unknown. These are only
// captured source fixtures: no tag, helper, constructor or target module is ever invoked by the test.
const unmodeledUses = {
  'tagged-template argument': 'function disable(_strings: TemplateStringsArray, Pipe: any) { Pipe.prototype.transform = async (v: unknown) => v; } disable`fixture ${ValidationPipe}`;',
  'tagged-template rest argument': 'const disable = (_strings: TemplateStringsArray, ...pipes: any[]) => { pipes[0].prototype.transform = async (v: unknown) => v; }; disable`fixture ${ValidationPipe}`;',
  'tagged-template local alias': 'const Alias = ValidationPipe; function disable(_strings: TemplateStringsArray, Pipe: any) { Pipe.prototype.transform = async (v: unknown) => v; } disable`fixture ${Alias}`;',
  'instance handed to a helper': 'function disable(pipe: any) { Object.getPrototypeOf(pipe).transform = async (v: unknown) => v; } disable(new ValidationPipe());',
  'subclass constructor': 'class Alias extends ValidationPipe {} Object.getPrototypeOf(Alias).prototype.transform = async (v: unknown) => v;',
};
for (const [name, source] of Object.entries(unmodeledUses)) {
  test(`unmodeled framework use: ${name}`, needsStore, async t => {
    const r = await run(t, { 'main.ts': mainWith(`  ${source}\n  app.useGlobalPipes(new ValidationPipe());`) });
    assert.equal(validation(r.analysis).verdict, 'unknown');
    assert.ok(reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
    assert.ok(r.analysis.controls.facts.every(f => f.verdict === 'unknown'));
  });
}
test('unmodeled framework use: a framework re-export is an explicit boundary', needsStore, async t => {
  const r = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());'),
    'framework-export.ts': "export { ValidationPipe } from '@nestjs/common';\n" });
  assert.equal(validation(r.analysis).verdict, 'unknown');
  assert.ok(reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
});
test('unmodeled framework use: scalar tags, discarded reads and property/type names are harmless', needsStore, async t => {
  const r = await run(t, { 'main.ts': mainWith(`
  const fields = { ValidationPipe: 'sku' };
  const scalar = label\`label\`;
  text(fields.ValidationPipe);
  typeof ValidationPipe;
  ValidationPipe;
  app.useGlobalPipes(new ValidationPipe());`, 'function text(x: string) { return x; }\nfunction label(s: TemplateStringsArray) { return s[0]; }') });
  assert.equal(validation(r.analysis).verdict, 'applies');
  assert.ok(!reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
});

test('unmodeled framework use: reassigned local bindings still require proof at their eventual use', needsStore, async t => {
  const head = 'function disable(_strings: TemplateStringsArray, Pipe: any) { Pipe.prototype.transform = async (v: unknown) => v; }';
  const escaped = await run(t, { 'main.ts': mainWith('  let Alias;\n  disable`fixture ${Alias = ValidationPipe}`;\n  app.useGlobalPipes(new ValidationPipe());', head) });
  assert.equal(validation(escaped.analysis).verdict, 'unknown');
  assert.ok(reasons(escaped.analysis).includes('sentinel.nest.frameworkEscapes'));
  const local = await run(t, { 'main.ts': mainWith('  let Alias; Alias = ValidationPipe;\n  app.useGlobalPipes(new ValidationPipe());') });
  assert.equal(validation(local.analysis).verdict, 'applies');
  assert.ok(!reasons(local.analysis).includes('sentinel.nest.frameworkEscapes'));
});

// A local alias is supported only while its binding stays local. Namespace and module boundaries are not
// interprocedural alias proofs; both exported initializers and subsequent live-binding assignments escape.
const boundaryUses = [
  { name: 'exported const', head: "import { Alias } from './binding';", extra: { 'binding.ts': "import { ValidationPipe } from '@nestjs/common';\nexport const Alias = ValidationPipe;\n" }, mutation: 'Alias.prototype.transform = async (v: unknown) => v;' },
  { name: 'exported live binding', head: "import { Alias } from './binding';", extra: { 'binding.ts': "import { ValidationPipe } from '@nestjs/common';\nexport let Alias: any; Alias = ValidationPipe;\n" }, mutation: 'Alias.prototype.transform = async (v: unknown) => v;' },
  { name: 'namespace binding', head: 'namespace Holder { export const Alias = ValidationPipe; }', extra: {}, mutation: 'Holder.Alias.prototype.transform = async (v: unknown) => v;' },
  { name: 'qualified value import', head: "import * as Common from '@nestjs/common';\nimport Alias = Common.ValidationPipe;", extra: {}, mutation: 'Alias.prototype.transform = async (v: unknown) => v;' },
  { name: 'CommonJS module object', head: "const Common = module.require('@nestjs/common');", extra: {}, mutation: 'Common.ValidationPipe.prototype.transform = async (v: unknown) => v;' },
  { name: 'CommonJS framework load', head: "const Common = require('@nestjs/common');", extra: {}, mutation: 'Common.ValidationPipe.prototype.transform = async (v: unknown) => v;' },
  { name: 'aliased module loader', head: "const load = require; const Common = load('@nestjs/common');", extra: {}, mutation: 'Common.ValidationPipe.prototype.transform = async (v: unknown) => v;' },
  { name: 'Node loader factory', head: "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const Common = load('@nestjs/common');", extra: {}, mutation: 'Common.ValidationPipe.prototype.transform = async (v: unknown) => v;' },
  { name: 'dynamic framework import', head: '', extra: {}, mutation: "const Common = await import('@nestjs/common'); Common.ValidationPipe.prototype.transform = async (v: unknown) => v;" },
  { name: 'external value import', head: "import Common = require('@nestjs/common');", extra: {}, mutation: 'Common.ValidationPipe.prototype.transform = async (v: unknown) => v;' },
];
for (const { name, head, extra, mutation } of boundaryUses) {
  test(`framework binding boundary: ${name}`, needsStore, async t => {
    const r = await run(t, { ...extra, 'main.ts': mainWith(`  ${mutation}\n  app.useGlobalPipes(new ValidationPipe());`, head) });
    assert.equal(validation(r.analysis).verdict, 'unknown');
    assert.ok(reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
  });
}
test('framework binding boundary: type-only external import and qualified type do not export the constructor', needsStore, async t => {
  const r = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', "import type Common = require('@nestjs/common');\ntype Alias = typeof Common.ValidationPipe;") });
  assert.equal(validation(r.analysis).verdict, 'applies');
  assert.ok(!reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
});

test('framework binding boundary: a local namespace member name is not the imported constructor', needsStore, async t => {
  const r = await run(t, { 'main.ts': mainWith('  app.useGlobalPipes(new ValidationPipe());', 'namespace Model { export class ValidationPipe {} }\nimport Alias = Model.ValidationPipe;') });
  assert.equal(validation(r.analysis).verdict, 'applies');
  assert.ok(!reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
});

test('framework binding boundary: a shadowed require is an ordinary local helper', needsStore, async t => {
  const r = await run(t, { 'main.ts': mainWith('  require("@nestjs/common");\n  app.useGlobalPipes(new ValidationPipe());', 'function require(name: string) { return name; }') });
  assert.equal(validation(r.analysis).verdict, 'applies');
  assert.ok(!reasons(r.analysis).includes('sentinel.nest.frameworkEscapes'));
});
