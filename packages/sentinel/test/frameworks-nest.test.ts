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
