// farsight-work v1 pin: every closed set is asserted against an explicit
// literal list AND against the schema file's enums, and a representative
// document validates. Growing a set means editing all three on purpose.
// Runs against the built package: `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORK_SCHEMA, WORK_PROVIDERS, WORK_TYPES, STATE_CATEGORIES, BODY_FORMATS, LINK_KINDS, ESTIMATE_UNITS,
  WORK_ACTIONS, PRINCIPALS, INTENT_STATES, workItemId,
} from '../dist/index.js';
import type { WorkItem, WorkListDocument } from '../dist/index.js';
import { validate } from '../../core/test/validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'schemas', 'farsight-work-v1.schema.json'), 'utf8'));
const enumOf = (def: string) => [...(schema.$defs[def].enum as string[])].sort();
const sorted = (xs: readonly string[]) => [...xs].sort();

const PINS: [string, readonly string[], string[]][] = [
  ['provider', WORK_PROVIDERS, ['jira', 'azure-devops', 'fixture']],
  ['workType', WORK_TYPES, ['epic', 'feature', 'story', 'task', 'bug', 'other']],
  ['stateCategory', STATE_CATEGORIES, ['todo', 'in-progress', 'done', 'removed']],
  ['bodyFormat', BODY_FORMATS, ['markdown', 'html', 'adf', 'wiki']],
  ['linkKind', LINK_KINDS, ['parent', 'child', 'relates', 'blocks', 'blocked-by', 'duplicates', 'other']],
  ['estimateUnit', ESTIMATE_UNITS, ['points', 'hours', 'days']],
  ['workAction', WORK_ACTIONS, ['comment', 'edit', 'assign', 'transition', 'link', 'label', 'create']],
];

for (const [def, exported, literal] of PINS) {
  test(`farsight-work v1: ${def} is the closed set, in code and in the schema file`, () => {
    assert.deepEqual(sorted(exported), sorted(literal));
    assert.deepEqual(enumOf(def), sorted(literal));
  });
}

test('farsight-work v1: principals and outbox states are closed sets', () => {
  assert.deepEqual(sorted(PRINCIPALS), ['agent', 'human']);
  assert.deepEqual(sorted(INTENT_STATES), sorted(['queued', 'applying', 'confirmed', 'conflict', 'denied', 'failed']));
});

test('farsight-work v1: the schema identity', () => {
  assert.equal(WORK_SCHEMA, 'farsight-work v1');
  assert.equal(schema.properties.schema.const, 'farsight-work v1');
  assert.equal(workItemId('acme-jira', 'ACME-123'), 'work::acme-jira::ACME-123');
});

const person = { id: 'acc-1', name: 'Ada' };
const item: WorkItem = {
  id: workItemId('src', 'INV-1'), source: 'src', provider: 'jira', key: 'INV-1', url: 'https://x.atlassian.net/browse/INV-1',
  type: { name: 'Story', category: 'story' }, title: 'Submit an invoice',
  body: { format: 'adf', raw: { type: 'doc' }, text: 'as a contractor' },
  state: { name: 'In Progress', category: 'in-progress', since: '2026-09-01T00:00:00Z' },
  priority: { name: 'High', rank: 2 }, assignee: person, reporter: { ...person, email: 'a@x' },
  labels: ['billing'], area: 'Portal', iteration: { name: 'Sprint 4' }, parent: workItemId('src', 'INV-0'),
  links: [{ kind: 'blocks', target: workItemId('src', 'INV-2'), native: 'Blocks' }],
  estimate: { value: 3, unit: 'points' },
  created: '2026-09-01T00:00:00Z', updated: '2026-09-02T00:00:00Z', revision: '2026-09-02T00:00:00Z',
  comments: [{ id: 'c1', author: person, created: '2026-09-02T00:00:00Z', body: { format: 'markdown', raw: 'hi', text: 'hi' } }],
  history: [{ at: '2026-09-02T00:00:00Z', by: person, field: 'status', from: 'To Do', to: 'In Progress' }],
  fields: { estimate: 3 }, raw: { key: 'INV-1' },
};

test('farsight-work v1: a representative list document validates', () => {
  const doc: WorkListDocument = { schema: WORK_SCHEMA, generatedAt: '2026-09-30T00:00:00Z', sources: ['src'], items: [item] };
  assert.deepEqual(validate(JSON.parse(JSON.stringify(doc)), schema), []);
});

test('farsight-work v1: the schema refuses an invented category and a missing field', () => {
  const bad = JSON.parse(JSON.stringify({ schema: WORK_SCHEMA, generatedAt: 'x', sources: [], items: [item] }));
  bad.items[0].state.category = 'resolved';
  delete bad.items[0].revision;
  const errors = validate(bad, schema);
  assert.ok(errors.some((e) => e.includes('not in enum')));
  assert.ok(errors.some((e) => e.includes('missing required "revision"')));
});
