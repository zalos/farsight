// One written call, several implementations — swarm 2026-09-23, blocker 3.
//
// A1.6 resolves an interface-typed call to every production implementer and stamps each
// edge `technique: 'interface'` with the others in `resolution.alternatives`. The walk
// visits them all (they are all real code), but the band used to draw them as a row of
// sequential steps with no word saying they were alternatives — so a provably dead
// transport sat on the happy path "when no exception thrown".
//
// In-memory fixtures (core has no parser dependency). Runs against the built package:
// `pnpm build` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, journey, journeySummary, journeyChoices, screensFor } from '../dist/index.js';
import type { GraphNode, GraphEdge } from '../dist/index.js';

const R = 'app';
const node = (id: string, kind: GraphNode['kind'], name: string, extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, kind, name, tags: [], ...extra }) as GraphNode;
const fn = (name: string, path: string, line: number, extra: Partial<GraphNode> = {}): GraphNode =>
  node(`${R}::${path}::${name}`, 'function', name, { loc: { repo: R, path, line }, ...extra });
const edge = (kind: GraphEdge['kind'], from: string, to: string, line?: number): GraphEdge =>
  ({ id: `${kind}|${from}|${to}`, kind, from, to, ...(line != null ? { meta: { line } } : {}) });
/** the shape A1.6 writes: one edge per implementer, the others named as alternatives */
const ifaceEdge = (from: string, to: string, line: number, iface: string, alternatives: string[]): GraphEdge =>
  ({
    id: `calls|${from}|${to}`, kind: 'calls', from, to,
    meta: { line, via: 'interface', iface },
    resolution: { status: 'heuristic', technique: 'interface', confidence: 'MEDIUM', alternatives, note: `3 classes implement ${iface}` },
  }) as GraphEdge;

const P = 'notify.ts';
const T = 'transport.ts';
const id = (path: string, name: string) => `${R}::${path}::${name}`;

/**
 * A screen whose action calls `Notifier.send`, which at one line calls
 * `this.transport.send(...)` — three classes implement `EmailTransport`, a
 * fourth (the test double) was set aside. The file transport writes a table,
 * so there is a subtree to re-parent; the ACS transport only throws.
 */
function threeTransports(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    node(`${R}::page::/invite`, 'page', '/invite', { loc: { repo: R, path: 'ui/invite.tsx', line: 1 } }),
    fn('Notifier.send', P, 10, { facets: { business: { label: 'Sends a templated email and keeps a record of it.' } } } as Partial<GraphNode>),
    fn('FileEmailTransport.send', T, 40, { facets: { business: { label: 'Delivers emails to a local folder.' } } } as Partial<GraphNode>),
    fn('LogEmailTransport.send', T, 80, { facets: { business: { label: 'Shows outgoing emails in the server log.' } } } as Partial<GraphNode>),
    fn('AcsEmailTransport.send', T, 120, { facets: { business: { label: 'Placeholder for the production mail service; refuses to start until it is wired.' } } } as Partial<GraphNode>),
    node(`${R}::table::outbox`, 'table', 'outbox', { loc: { repo: R, path: 'db/schema.sql', line: 3 } }),
  ];
  const alts = (self: string) => ['FileEmailTransport.send', 'LogEmailTransport.send', 'AcsEmailTransport.send', 'FakeEmailTransport.send']
    .filter((n) => n !== self).map((n) => id(T, n));
  const edges: GraphEdge[] = [
    edge('calls', `${R}::page::/invite`, id(P, 'Notifier.send'), 4),
    ifaceEdge(id(P, 'Notifier.send'), id(T, 'FileEmailTransport.send'), 52, 'EmailTransport', alts('FileEmailTransport.send')),
    ifaceEdge(id(P, 'Notifier.send'), id(T, 'LogEmailTransport.send'), 52, 'EmailTransport', alts('LogEmailTransport.send')),
    ifaceEdge(id(P, 'Notifier.send'), id(T, 'AcsEmailTransport.send'), 52, 'EmailTransport', alts('AcsEmailTransport.send')),
    edge('writes', id(T, 'FileEmailTransport.send'), `${R}::table::outbox`, 44),
  ];
  return { nodes, edges };
}

test('one call site with three implementations is one marker, not three steps in a row', () => {
  const { nodes, edges } = threeTransports();
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/invite`;
  const j = journey(index, entry);

  // nothing is dropped from the walk: all three implementations are still steps, so the
  // spliced code view and `full:true` still show every one of them
  const walked = j.steps.map((s) => index.byId.get(s.nodeId)!.name);
  assert.deepEqual(walked, ['/invite', 'Notifier.send', 'FileEmailTransport.send', 'outbox', 'LogEmailTransport.send', 'AcsEmailTransport.send']);

  const choices = journeyChoices(index, j);
  const groups = [...new Set(choices.values())];
  assert.equal(groups.length, 1, 'one written call — one choice');
  const c = groups[0]!;
  assert.equal(c.label, 'EmailTransport.send', 'drawn as the call the source writes, never as one implementation');
  assert.equal(c.words, 'Email transport · Send', 'and in plain words for a register that prints no identifiers');
  assert.deepEqual(c.candidates.map((x) => x.name), ['FileEmailTransport.send', 'LogEmailTransport.send', 'AcsEmailTransport.send']);
  assert.deepEqual(c.candidates.map((x) => x.words), ['File email transport', 'Log email transport', 'Acs email transport'],
    'the member is in the group\'s name, so a candidate spells only its owner');
  assert.deepEqual(c.setAside, ['FakeEmailTransport.send'], 'the twin the resolution knew of and did not draw is named, not hidden');
  assert.equal(c.iface, 'EmailTransport');
  assert.equal(c.technique, 'interface');
  assert.equal(c.confidence, 'MEDIUM');
  assert.deepEqual(c.at, { nodeId: id(P, 'Notifier.send'), name: 'Notifier.send', path: P, line: 52 },
    'the call site is the one location certainly on the path');
  assert.equal(choices.size, 3, 'every candidate can be asked about — a step printer needs all three');

  const sum = journeySummary(index, j, screensFor(index, entry));
  const markers = sum.segments.flatMap((sg) => sg.markers);
  const named = markers.map((m) => m.name);
  assert.deepEqual(named, ['Sends a templated email and keeps a record of it.', 'EmailTransport.send', 'outbox'],
    'the three implementations are one marker; AcsEmailTransport.send is not drawn as a step that ran');
  assert.equal(markers.filter((m) => m.choice).length, 1);
  assert.equal(sum.counts.choices, 1, 'and the count says how many such places there are');

  // a candidate's authored sentence may not speak for the group
  const head = markers.find((m) => m.choice)!;
  assert.equal(head.title, undefined, 'the three say different things — none of them is the marker\'s words');
  assert.equal(head.business, undefined);
  assert.equal(head.nodeId, id(T, 'FileEmailTransport.send'), 'the marker is anchored on the first candidate\'s step');
  assert.deepEqual(head.choice!.candidates.map((x) => x.title), [
    'Delivers emails to a local folder.',
    'Shows outgoing emails in the server log.',
    'Placeholder for the production mail service; refuses to start until it is wired.',
  ], 'each candidate keeps its own words — that is how a reader sees the placeholder');

  // what a candidate reached hangs under the call, not under a marker nobody drew
  const outbox = markers.find((m) => m.kind === 'record')!;
  assert.equal(outbox.under, head.stepOrder, 'the table the file transport writes still shows, under the call');
});

test('the denominator does not shrink: every candidate stays coverable', () => {
  const { nodes, edges } = threeTransports();
  // one test node, so the coverage fold runs at all
  nodes.push(node(`${R}::test::t1`, 'test', 'sends an invite', {
    loc: { repo: R, path: 'test/notify.test.ts', line: 1 },
    test: { file: 'test/notify.test.ts', level: 'unit', kind: 'case' },
  } as Partial<GraphNode>));
  edges.push({ id: `covers|${R}::test::t1|${id(P, 'Notifier.send')}`, kind: 'covers', from: `${R}::test::t1`, to: id(P, 'Notifier.send'), meta: { evidence: 'declared' } } as GraphEdge);
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/invite`;
  const sum = journeySummary(index, journey(index, entry), screensFor(index, entry));
  const seg = sum.coverage!.segments[0]!;
  // /invite · Notifier.send · the three transports — the table is not a coverable kind.
  // Folding three implementations into one marker must not quietly drop two nodes a test
  // could reach (one denominator per scope).
  assert.equal(seg.metric.denominator, 5, 'the band draws one place; the denominator still counts all three implementations');
});

test('two calls written on one line stay two steps — only a recorded ambiguity is a choice', () => {
  const nodes: GraphNode[] = [
    node(`${R}::page::/x`, 'page', '/x', { loc: { repo: R, path: 'ui/x.tsx', line: 1 } }),
    fn('handle', 'x.ts', 10), fn('first', 'x.ts', 20), fn('second', 'x.ts', 30),
  ];
  const edges: GraphEdge[] = [
    edge('calls', `${R}::page::/x`, id('x.ts', 'handle'), 4),
    edge('calls', id('x.ts', 'handle'), id('x.ts', 'first'), 12),
    edge('calls', id('x.ts', 'handle'), id('x.ts', 'second'), 12),
  ];
  const index = buildIndex(nodes, edges);
  const entry = `${R}::page::/x`;
  const sum = journeySummary(index, journey(index, entry), screensFor(index, entry));
  const markers = sum.segments.flatMap((sg) => sg.markers);
  assert.deepEqual(markers.map((m) => m.name), ['handle', 'first', 'second'], 'a sequence on one line is a sequence');
  assert.equal(sum.counts.choices, 0);
});

test('the header counts call sites, not the markers a repeated call draws', () => {
  // `choiceAt` is keyed by step order, so one written call the walk reaches twice
  // yielded two entries and the header said "4 places" where the reference app's submission flow
  // has 2. JourneyChoice.id is the call site's own identity; the count uses it.
  const base = threeTransports();
  // a second action that calls the same Notifier.send — one written call, reached twice
  const nodes = [...base.nodes, node(`${R}::page::/resend`, 'page', '/resend', { loc: { repo: R, path: 'ui/resend.tsx', line: 1 } })];
  const edges = [...base.edges, edge('calls', `${R}::page::/resend`, id(P, 'Notifier.send'), 7)];
  const ix = buildIndex(nodes, edges);
  const j = journey(ix, `${R}::page::/invite`, {});
  const ch = journeyChoices(ix, j);
  const sites = new Set([...ch.values()].map((c) => c.id));
  assert.ok(sites.size >= 1, 'the fixture must actually produce a choice');
  const sum = journeySummary(ix, j, screensFor(ix, j));
  assert.equal(sum.counts.choices, sites.size, 'the count is call sites, never the markers they drew');
  assert.ok(sum.counts.choices <= ch.size, 'a repeated site never inflates the count');
});
