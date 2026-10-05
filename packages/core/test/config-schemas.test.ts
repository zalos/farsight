// The JSON Schemas for farsight.config.json and the design manifest (docs/proposals/round-2026-10-05.md §6):
// every config file and every design manifest under examples/ validates, a wrong one does not, the
// schemas name the fields the types and the loader know (CONFIG_FIELDS), and their $ids sit under
// https://farsight.dev/schemas/ like the frozen contracts'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FIELDS, isDesignManifest } from '../dist/index.js';
import { validate } from './validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const schema = (name: string) => JSON.parse(readFileSync(join(root, 'schemas', name), 'utf8')) as Record<string, unknown>;

/** Every file under examples/ the predicate keeps (node_modules and dot-dirs skipped). */
function walk(dir: string, keep: (rel: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, keep, out);
    else if (keep(relative(root, abs))) out.push(abs);
  }
  return out;
}
const examples = join(root, 'examples');

test('every farsight.config.json under examples/ validates against schemas/farsight-config.schema.json', () => {
  const s = schema('farsight-config.schema.json');
  const files = walk(examples, (rel) => rel.endsWith('/farsight.config.json'));
  assert.ok(files.length >= 7, `found ${files.length} config files`);
  for (const f of files) assert.deepEqual(validate(JSON.parse(readFileSync(f, 'utf8')), s), [], relative(root, f));
});

test('every design manifest under examples/ validates against schemas/farsight-design.schema.json', () => {
  const s = schema('farsight-design.schema.json');
  // a manifest is a JSON file under a design folder that reads as one (screens[] with ids)
  const files = walk(examples, (rel) => rel.endsWith('.json') && rel.includes('/design/'))
    .filter((f) => isDesignManifest(JSON.parse(readFileSync(f, 'utf8'))));
  assert.ok(files.length >= 4, `found ${files.length} manifests`);
  for (const f of files) assert.deepEqual(validate(JSON.parse(readFileSync(f, 'utf8')), s), [], relative(root, f));
});

test('a wrong config does not validate: an unknown field, a bad store kind, a string where a list goes', () => {
  const s = schema('farsight-config.schema.json');
  const errs = validate({ glosary: {}, stores: [{ name: 'X', kind: 'cloud' }], plumbing: 'src/**', $schema: 'https://farsight.dev/schemas/farsight-config.schema.json' }, s);
  assert.ok(errs.some((e) => e.includes('unexpected property "glosary"')), errs.join('\n'));
  assert.ok(errs.some((e) => e.includes('$.stores[0].kind')), errs.join('\n'));
  assert.ok(errs.some((e) => e.includes('$.plumbing')), errs.join('\n'));
  assert.ok(!errs.some((e) => e.includes('$schema')), 'an editor key is allowed');
});

test('a wrong manifest does not validate: no screens, a flow without its screens, a persona as a number', () => {
  const s = schema('farsight-design.schema.json');
  assert.ok(validate({ name: 'x' }, s).some((e) => e.includes('missing required "screens"')));
  const errs = validate({ screens: [{ id: 'A' }], flows: [{ id: 'f', name: 'F', persona: 3 }], storylines: [{ id: 's', name: 'S' }] }, s);
  assert.ok(errs.some((e) => e.includes('$.flows[0]: missing required "screens"')), errs.join('\n'));
  assert.ok(errs.some((e) => e.includes('$.flows[0].persona')), errs.join('\n'));
  assert.ok(errs.some((e) => e.includes('$.storylines[0]: missing required "journeys"')), errs.join('\n'));
});

test('the config schema names exactly the fields the loader reads, and both $ids sit under farsight.dev/schemas', () => {
  const c = schema('farsight-config.schema.json');
  assert.deepEqual(Object.keys(c.properties as object).sort(), [...CONFIG_FIELDS].sort());
  for (const [name, s] of [['farsight-config.schema.json', c], ['farsight-design.schema.json', schema('farsight-design.schema.json')]] as const) {
    assert.equal(s.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(s.$id, `https://farsight.dev/schemas/${name}`);
  }
});
