// Every §3 row for Azure DevOps, against recorded ExampleProject items (Scrum process)
// plus synthetic CMMI / Agile shapes for the rows ExampleProject does not exercise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mapWorkItem, mapComment, mapUpdates, typeInfo, typeCategory, linkKind, person, splitTags, fieldMap,
  STATE_CATEGORY_MAP, schemaType,
} from '../dist/index.js';
import type { MapContext } from '../dist/index.js';
import { WORK_SCHEMA } from '@farsight/work';
import { validate } from '../../core/test/validate.ts';
import { rec, FIX } from './fake.ts';

const schema = JSON.parse(readFileSync(join(FIX, '..', '..', '..', '..', '..', 'schemas', 'farsight-work-v1.schema.json'), 'utf8'));

function ctx(extra: Partial<MapContext> = {}): MapContext {
  const types = new Map([['ExampleProject', new Map(rec('workitemtypes').value.map((t: any) => [t.name, typeInfo(t)]))]]);
  const iters = new Map([['ExampleProject', new Map([['ExampleProject\\Sprint 1', { start: '2026-05-01T00:00:00Z', end: '2026-05-15T00:00:00Z' }]])]]);
  const fm = fieldMap(rec('fields').value);
  const fields = new Map<string, string[]>();
  for (const f of fm) if (f.canonical) fields.set(f.canonical, [...(fields.get(f.canonical) ?? []), f.id]);
  return { sourceId: 'example-azdo', org: 'https://dev.azure.com/example-org', types: types as any, iterations: iters, fields, ...extra };
}
const raw = (id: number) => structuredClone(rec('batch').value.find((v: any) => v.id === id));

test('map: state.category comes from the type\'s own states[].category, never the name', () => {
  assert.deepEqual(STATE_CATEGORY_MAP, { Proposed: 'todo', InProgress: 'in-progress', Resolved: 'in-progress', Completed: 'done', Removed: 'removed' });
  const pbi = mapWorkItem(raw(350), ctx());
  assert.deepEqual(pbi.state, { name: 'New', category: 'todo', since: '2026-05-07T23:34:21.427Z' });
  // CMMI: *Resolved* sits in InProgress for a Requirement and in Resolved for a Bug — both in-progress, name kept
  const cmmi = new Map([
    ['Requirement', typeInfo({ name: 'Requirement', states: [{ name: 'Resolved', category: 'InProgress' }, { name: 'Closed', category: 'Completed' }] })],
    ['Bug', typeInfo({ name: 'Bug', states: [{ name: 'Resolved', category: 'Resolved' }, { name: 'Closed', category: 'Completed' }] })],
    ['Odd', typeInfo({ name: 'Odd', states: [{ name: 'Done', category: 'InProgress' }, { name: 'Cut', category: 'Removed' }] })],
  ]);
  const c = ctx({ types: new Map([['ExampleProject', cmmi]]) });
  const as = (type: string, state: string) => { const r = raw(352); r.fields['System.WorkItemType'] = type; r.fields['System.State'] = state; return mapWorkItem(r, c).state; };
  assert.deepEqual([as('Requirement', 'Resolved').category, as('Bug', 'Resolved').category], ['in-progress', 'in-progress']);
  assert.equal(as('Bug', 'Resolved').name, 'Resolved');
  assert.equal(as('Odd', 'Done').category, 'in-progress', 'a state named Done in InProgress is in progress');
  assert.equal(as('Odd', 'Cut').category, 'removed');
  assert.equal(as('Bug', 'Closed').category, 'done');
});

test('map: a state its type does not define (Epic 349 in "To Do") is marked, not guessed', () => {
  const epic = mapWorkItem(raw(349), ctx());
  assert.equal(epic.state.name, 'To Do');
  assert.equal(epic.fields.stateUndefinedByType, true);
  assert.equal(epic.type.category, 'epic');
});

test('map: type.category per §3, including the Scrum process ExampleProject runs', () => {
  const want: Record<string, string> = {
    Epic: 'epic', Feature: 'feature', 'User Story': 'story', 'Product Backlog Item': 'story', Requirement: 'story',
    Task: 'task', Bug: 'bug', Issue: 'bug', Impediment: 'other', 'Test Case': 'other', 'Code Review Request': 'other',
  };
  for (const [name, cat] of Object.entries(want)) assert.equal(typeCategory(name), cat, name);
  assert.deepEqual(rec('workitemtypes').value.map((t: any) => schemaType(typeInfo(t))).filter((t: any) => t.category !== 'other').map((t: any) => `${t.name}=${t.category}`),
    ['Task=task', 'Bug=bug', 'Epic=epic', 'Feature=feature', 'Product Backlog Item=story']);
});

test('map: Person.id is the descriptor (fallback id); the feed\'s "Name <email>" string is read too', () => {
  const pbi = mapWorkItem(raw(350), ctx());
  assert.deepEqual(pbi.reporter, { id: 'aad.MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAx', name: 'Pat Reviewer', email: 'pat.reviewer@example.com' });
  assert.deepEqual(person({ id: 'g-1', displayName: 'No Descriptor' }), { id: 'g-1', name: 'No Descriptor' });
  assert.deepEqual(person('Jane Doe <jane@x.test>'), { id: 'jane@x.test', name: 'Jane Doe', email: 'jane@x.test' });
  assert.equal(person(undefined), undefined);
});

test('map: parent from the Hierarchy-Reverse relation, else System.Parent; links keep the native rel', () => {
  const r = raw(352);
  r.relations = [
    { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/example-org/_apis/wit/workItems/349' },
    { rel: 'System.LinkTypes.Related', url: 'https://dev.azure.com/example-org/_apis/wit/workItems/350' },
    { rel: 'System.LinkTypes.Dependency-forward', url: 'https://dev.azure.com/example-org/_apis/wit/workItems/351' },
    { rel: 'Hyperlink', url: 'https://example.test/spec' },
  ];
  const it = mapWorkItem(r, ctx());
  assert.equal(it.parent, 'work::example-azdo::349');
  assert.deepEqual(it.links.map((l) => [l.kind, l.target, l.native]), [
    ['parent', 'work::example-azdo::349', 'System.LinkTypes.Hierarchy-Reverse'],
    ['relates', 'work::example-azdo::350', 'System.LinkTypes.Related'],
    ['blocks', 'work::example-azdo::351', 'System.LinkTypes.Dependency-forward'],
    ['other', 'https://example.test/spec', 'Hyperlink'],
  ]);
  const p = raw(352); p.fields['System.Parent'] = 349;
  assert.equal(mapWorkItem(p, ctx()).parent, 'work::example-azdo::349');
  assert.equal(mapWorkItem(raw(352), ctx()).parent, undefined, 'ExampleProject items carry no parent');
  for (const [rel, kind] of [['System.LinkTypes.Hierarchy-Forward', 'child'], ['System.LinkTypes.Dependency-Reverse', 'blocked-by'], ['System.LinkTypes.Duplicate-Reverse', 'duplicates'], ['System.LinkTypes.Duplicate-Forward', 'other'], ['AttachedFile', 'other']]) {
    assert.equal(linkKind(rel!), kind, rel);
  }
  // attachments are relations too: 351 carries three
  assert.deepEqual(mapWorkItem(raw(351), ctx()).links.map((l) => l.native), ['AttachedFile', 'AttachedFile', 'AttachedFile']);
});

test('map: tags, area, iteration with the team\'s dates, estimate from Effort / StoryPoints / RemainingWork', () => {
  const r = raw(352);
  r.fields['System.Tags'] = 'portal; UX ;;finance';
  r.fields['System.IterationPath'] = 'ExampleProject\\Sprint 1';
  r.fields['Microsoft.VSTS.Scheduling.Effort'] = 5;
  const it = mapWorkItem(r, ctx());
  assert.deepEqual(it.labels, ['portal', 'UX', 'finance']);
  assert.equal(it.area, 'ExampleProject');
  assert.deepEqual(it.iteration, { name: 'ExampleProject\\Sprint 1', start: '2026-05-01T00:00:00Z', end: '2026-05-15T00:00:00Z' });
  assert.deepEqual(it.estimate, { value: 5, unit: 'points' });
  assert.equal(it.fields.estimate, 5);
  assert.deepEqual(mapWorkItem(raw(352), ctx()).iteration, { name: 'ExampleProject' }, 'the root iteration has no dates');
  const t = raw(352); t.fields['Microsoft.VSTS.Scheduling.RemainingWork'] = 3.5;
  assert.deepEqual(mapWorkItem(t, ctx()).estimate, { value: 3.5, unit: 'hours' });
  const sp = raw(352); sp.fields['Microsoft.VSTS.Scheduling.StoryPoints'] = 8; sp.fields['Microsoft.VSTS.Scheduling.Effort'] = 2;
  assert.deepEqual(mapWorkItem(sp, ctx({ fields: new Map([['estimate', ['Microsoft.VSTS.Scheduling.StoryPoints']]]) })).estimate, { value: 8, unit: 'points' });
  assert.deepEqual(splitTags(undefined), []);
});

test('map: fieldMap finds what the project has and a settings pin is declared', () => {
  const fm = fieldMap(rec('fields').value, { estimate: 'Custom.Size' });
  const est = fm.filter((f) => f.canonical === 'estimate');
  assert.deepEqual(est, [{ id: 'Custom.Size', name: 'Custom.Size', canonical: 'estimate', origin: 'declared' }]);
  const found = fieldMap(rec('fields').value).filter((f) => f.canonical === 'estimate' || f.canonical === 'remaining');
  assert.deepEqual(found.map((f) => `${f.canonical}:${f.id}:${f.origin}`), [
    'estimate:Microsoft.VSTS.Scheduling.Effort:found', 'remaining:Microsoft.VSTS.Scheduling.RemainingWork:found',
  ], 'ExampleProject (Scrum) has Effort and RemainingWork, no StoryPoints');
});

test('map: body is the HTML description with a markdown-ish text; markdown when multilineFieldsFormat says so', () => {
  const it = mapWorkItem(raw(350), ctx());
  assert.equal(it.body!.format, 'html');
  assert.equal(it.body!.raw, raw(350).fields['System.Description']);
  assert.match(it.body!.text, /^\*\*Info Required/);
  const md = raw(352); md.multilineFieldsFormat = { 'System.Description': 'Markdown' }; md.fields['System.Description'] = '# Hi\n\n- a';
  assert.deepEqual(mapWorkItem(md, ctx()).body, { format: 'markdown', raw: '# Hi\n\n- a', text: '# Hi\n\n- a' });
  assert.equal(mapWorkItem(raw(349), ctx()).body, undefined);
});

test('map: revision = rev, key/url/dates/priority, raw verbatim, and the four ExampleProject items validate against farsight-work v1', () => {
  const items = rec('batch').value.map((r: any) => mapWorkItem(structuredClone(r), ctx()));
  assert.deepEqual(items.map((i: any) => `${i.key}@${i.revision}`), ['349@1', '350@9', '351@15', '352@4']);
  const i352 = items[3];
  assert.equal(i352.id, 'work::example-azdo::352');
  assert.equal(i352.url, 'https://dev.azure.com/example-org/ExampleProject/_workitems/edit/352');
  assert.equal(i352.title, 'Landing page');
  assert.equal(i352.created, '2026-05-07T23:52:54.957Z');
  assert.deepEqual(i352.priority, { name: '2', rank: 2 });
  assert.deepEqual(i352.raw, rec('batch').value[3]);
  const doc = JSON.parse(JSON.stringify({ schema: WORK_SCHEMA, generatedAt: '2026-09-30T00:00:00.000Z', sources: ['example-azdo'], items }));
  assert.deepEqual(validate(doc, schema), []);
});

test('map: comments (7.2-preview HTML, markdown) and updates → history, bookkeeping fields dropped', () => {
  const c = mapComment(rec('comments72-350').comments[0]);
  assert.equal(c.author.name, 'Pat Reviewer');
  assert.deepEqual(c.body, { format: 'html', raw: '<div>Need to have a way to check duplicates</div>', text: 'Need to have a way to check duplicates' });
  assert.equal(mapComment({ id: 2, text: '**x**', format: 'markdown', createdBy: { descriptor: 'd', displayName: 'D' }, createdDate: '2026-01-01T00:00:00Z' }).body.format, 'markdown');
  const h = mapUpdates(rec('updates-352').value);
  assert.ok(h.length > 0);
  assert.ok(!h.some((x) => ['System.Rev', 'System.Watermark', 'System.ChangedDate', 'System.AuthorizedDate'].includes(x.field)));
  const desc = h.find((x) => x.field === 'System.Description' && x.to)!;
  assert.doesNotMatch(desc.to!, /<li>/, 'HTML fields are rendered as text in history');
  assert.ok(h.every((x, n) => n === 0 || x.at >= h[n - 1]!.at), 'oldest first');
  const rel = mapUpdates(rec('updates-351').value).filter((x) => x.field === 'relations');
  assert.ok(rel.length >= 3 && rel.every((x) => /^AttachedFile /.test(x.to ?? x.from ?? '')));
});
