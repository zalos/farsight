/** Join generated Spring delegate implementations to the operations already read by the spec pass. */
import {
  buildIndex,
  operationDrift,
  t,
  type GraphFragment,
  type GraphNode,
  type ReconcileOptions,
  type RouteGap,
} from '@farsight/core';
import { globToRegExp } from '../shared/files.js';

const RESPONSE_ENTITY = /\bResponseEntity\s*</;
const classKey = (node: GraphNode, name = node.name) => `${node.loc?.repo}\0${node.loc?.path}\0${name}`;

export interface DelegateDriftContext extends Pick<ReconcileOptions, 'guardNames' | 'validators'> {
  /** Kept by the spec pass, including documents that only declare security schemes. */
  securityByApi?: ReadonlyMap<string, boolean>;
}

/** In place; unmatched overrides are gaps, never invented routes. Without a spec there is nothing to join. */
export function joinDelegates(fragment: GraphFragment, globs: string[], drift: DelegateDriftContext = {}): RouteGap[] {
  if (!globs.length) return [];
  const patterns = globs.map(globToRegExp);
  const classes = new Map<string, GraphNode>();
  for (const node of fragment.nodes) {
    if (node.kind !== 'class' || node.lang !== 'java' || !node.loc) continue;
    if (!node.tags.some((tag) => tag.startsWith('implements:') && patterns.some((re) => re.test(tag.slice(11)))))
      continue;
    classes.set(classKey(node), node);
    if (!node.tags.includes('controller')) node.tags.push('controller');
  }
  if (!classes.size) return [];
  const operations = new Map<string, GraphNode[]>();
  for (const node of fragment.nodes) {
    const operation = node.contract?.spec?.operationId;
    if (node.kind !== 'route' || !operation || (node.loc && node.loc.repo !== fragment.repo)) continue;
    const list = operations.get(operation) ?? [];
    list.push(node);
    operations.set(operation, list);
  }
  if (!fragment.nodes.some((n) => n.kind === 'api' || (n.kind === 'route' && n.contract?.spec))) return [];

  const candidates = new Map<string, GraphNode[]>();
  for (const fn of fragment.nodes) {
    if (fn.kind !== 'function' || fn.lang !== 'java' || !fn.loc || !fn.signature || !RESPONSE_ENTITY.test(fn.signature))
      continue;
    if (
      !/@(?:java\.lang\.)?Override\b/.test(fn.signature) ||
      !/\bpublic\b/.test(fn.signature) ||
      /\bstatic\b/.test(fn.signature)
    )
      continue;
    const dot = fn.name.lastIndexOf('.');
    if (dot < 0 || !classes.has(classKey(fn, fn.name.slice(0, dot)))) continue;
    const method = fn.name.slice(dot + 1);
    const list = candidates.get(method) ?? [];
    list.push(fn);
    candidates.set(method, list);
  }
  const keys = new Set(fragment.edges.map((e) => `${e.kind}\0${e.from}\0${e.to}`));
  const ids = new Set(fragment.edges.map((e) => e.id));
  let seq = fragment.edges.length;
  const nextId = () => {
    while (ids.has(`dlg${seq}`)) seq++;
    const id = `dlg${seq++}`;
    ids.add(id);
    return id;
  };
  const gates = new Map<string, typeof fragment.edges>();
  for (const e of fragment.edges) {
    if (e.kind !== 'guards' && e.kind !== 'validates') continue;
    const list = gates.get(e.to) ?? [];
    list.push(e);
    gates.set(e.to, list);
  }
  const joined: GraphNode[] = [];
  const gaps: RouteGap[] = [];
  for (const [method, handlers] of candidates) {
    const routes = operations.get(method) ?? [];
    for (const fn of handlers) {
      if (routes.length !== 1 || handlers.length !== 1) {
        const key =
          routes.length > 1 || handlers.length > 1 ? 'config.delegate.ambiguous' : 'config.delegate.unmatched';
        gaps.push({
          kind: 'delegate-unmatched',
          path: fn.loc!.path,
          line: fn.loc!.line,
          name: fn.name,
          text: t(key, 'professional').replace('{name}', fn.name).replace('{method}', method),
        });
        continue;
      }
      const route = routes[0]!;
      const callKey = `calls\0${route.id}\0${fn.id}`;
      if (!keys.has(callKey)) {
        fragment.edges.push({
          id: nextId(),
          kind: 'calls',
          from: route.id,
          to: fn.id,
          resolution: {
            status: 'resolved',
            technique: 'annotation-scan',
            confidence: 'HIGH',
            note: `${fn.name.slice(0, fn.name.lastIndexOf('.'))} implements a delegate interface named by farsight.config.json → frameworks.spring.delegates; ${method} is the spec's operationId`,
          },
        });
        keys.add(callKey);
      }
      // The same one-hop propagation as an ordinary controller: grant evidence stays on the route.
      for (const gate of gates.get(fn.id) ?? []) {
        const key = `${gate.kind}\0${gate.from}\0${route.id}`;
        if (keys.has(key)) continue;
        fragment.edges.push({
          ...gate,
          id: nextId(),
          to: route.id,
          meta: { ...gate.meta, via: 'handler', handler: fn.id },
        });
        keys.add(key);
      }
      if (route.contract) {
        route.contract.status = 'both';
        joined.push(route);
      }
      route.tags = route.tags.filter((tag) => tag !== 'spec-only');
      route.loc ??= { ...fn.loc! };
      if (route.lang === 'openapi') route.lang = 'java';
    }
  }
  // Reuse the normal controller drift rules after every handler and gate has been joined.
  const index = buildIndex(fragment.nodes, fragment.edges);
  for (const route of joined) {
    const contract = route.contract!;
    const match = /^([A-Z]+) (.+)$/.exec(route.name);
    if (!match) continue;
    const specUsesSecurity =
      drift.securityByApi?.get(contract.apiId) ??
      fragment.nodes.some((n) => n.contract?.apiId === contract.apiId && !!n.contract.security?.length);
    contract.drift = operationDrift(
      { method: match[1]!, path: match[2]!, normPath: match[2]!, routeId: route.id, contract },
      route,
      index,
      specUsesSecurity,
      drift,
    );
  }
  return gaps;
}
