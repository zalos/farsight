// What a middleware function certainly does on a request that reaches it, read from its body. Three shapes are read:
//
// - a refusal: `if (<condition on the request>) <respond 401 or 403>; next();` — the request is refused with that
//   status when the condition holds and passed on otherwise. It is evidence that a conditional refusal runs at that
//   position, not that a principal is authenticated or a permission checked: the condition reads a value the client
//   may control, and neither the status nor the function's name establishes either property.
// - a pass-through: statements that do not touch the response, never write to or hand on the request, then `next()`.
// - an error handler: four parameters. Express calls it only with an error, so it holds no position on the normal
//   path; whether it may resume routing with next() is read, because a resumed request has skipped the ordinary
//   layers between the error and the handler.
//
// Anything else — an async function, an early next('route') or next('router'), a third-party or unresolved function,
// a response that is not one literal status, a condition that calls application code — is unknown.
import type { At, BoundArg, ExpressReason, Value } from './model.js';
import { identifierName, memberPath, numberValue, stringValue, unwrap, walk, type JsNode } from './syntax.js';

export type Property = 'authentication' | 'authorization';

export type Effect =
  | { readonly kind: 'refusal'; readonly property: Property; readonly at: At[] }
  | { readonly kind: 'pass-through'; readonly at: At[] }
  /** An error handler; `resumes` when it may call next() without an error, returning the request to normal routing. */
  | { readonly kind: 'error-only'; readonly resumes: boolean; readonly at: At[] }
  /** `mayHandleErrors`: the layer could be an error handler that resumes (its parameters are not known). */
  | { readonly kind: 'unknown'; readonly reason: ExpressReason; readonly mayHandleErrors: boolean; readonly at: At[] };

/** Request getters Express 4 defines as plain values, which a pass-through may read and hand to a logger. */
const REQUEST_VALUES = new Set(['method', 'url', 'originalUrl', 'path', 'baseUrl', 'hostname', 'ip', 'protocol']);
const RESPONSE_ENDS = new Set(['json', 'send', 'end']);
const STATUS_PROPERTY: Record<number, Property> = { 401: 'authentication', 403: 'authorization' };

export function effectOf(v: Value): Effect {
  switch (v.kind) {
    case 'builtin':
      // Express's own body parsers and static server: they parse or serve, and never refuse for these properties.
      return v.inert ? { kind: 'pass-through', at: [v.at] } : { kind: 'unknown', reason: 'sentinel.express.middlewareEffectUnknown', mayHandleErrors: false, at: [v.at] };
    case 'foreign': return { kind: 'unknown', reason: 'sentinel.express.middlewareThirdParty', mayHandleErrors: true, at: [v.at] };
    case 'function': return functionEffect(v);
    case 'object': return { kind: 'unknown', reason: 'sentinel.express.registrationUnsupported', mayHandleErrors: true, at: [v.obj.at] };
    case 'unknown': return { kind: 'unknown', reason: 'sentinel.express.middlewareUnresolved', mayHandleErrors: true, at: [v.at] };
    default: return { kind: 'unknown', reason: 'sentinel.express.middlewareUnresolved', mayHandleErrors: true, at: [] };
  }
}

function functionEffect(v: Extract<Value, { kind: 'function' }>): Effect {
  const fn = v.node;
  const at: At[] = [...v.via, { file: v.file, node: fn }];
  const unknown = (reason: ExpressReason = 'sentinel.express.middlewareEffectUnknown', mayHandleErrors = false): Effect => ({ kind: 'unknown', reason, mayHandleErrors, at });
  const params = fn.params as JsNode[];
  // A default or destructured parameter changes the arity Express reads: whether it is an error handler is unknown.
  if (params.some(p => p.type !== 'Identifier')) return unknown('sentinel.express.middlewareEffectUnknown', true);
  if (params.length === 4) {
    // It stays on the error path only if it never calls next, or calls it with the error it received.
    const [err, , , next] = params.map(p => p.name as string);
    let resumes = false;
    walk(fn.body as JsNode, (n, parents) => {
      if (n.type !== 'Identifier' || n.name !== next) return;
      const p = parents[parents.length - 1];
      const passesError = p?.type === 'CallExpression' && p.callee === n && (p.arguments as JsNode[]).length === 1 && identifierName((p.arguments as JsNode[])[0]) === err;
      if (!passesError) resumes = true;
    });
    return { kind: 'error-only', resumes, at };
  }
  if (fn.async || fn.generator) return unknown();
  if (params.length !== 3 && params.length !== 2) return unknown();
  const [req, res, next] = params.map(p => p.name as string);
  if (!next) return unknown(); // a two-parameter function never passes the request on: it is a handler
  // next('route') / next('router') skip the rest of the route or router: that is not a refusal, and not read.
  let skips = false;
  walk(fn.body as JsNode, n => {
    if (n.type === 'CallExpression' && identifierName(n.callee as JsNode) === next && (n.arguments as JsNode[]).length) {
      const a = stringValue((n.arguments as JsNode[])[0]);
      if (a === 'route' || a === 'router') skips = true;
    }
  });
  if (skips) return unknown('sentinel.express.nextSkip');
  const body = fn.body as JsNode;
  const stmts = body.type === 'BlockStatement' ? body.body as JsNode[] : [{ type: 'ExpressionStatement', start: body.start, end: body.end, expression: body } as JsNode];
  if (!stmts.length) return unknown();
  if (!isNextCall(stmts[stmts.length - 1]!, next)) return unknown();
  const before = stmts.slice(0, -1);
  // A refusal: exactly one `if` with no else, before the final next().
  if (before.length === 1 && before[0]!.type === 'IfStatement' && !before[0]!.alternate) {
    const s = before[0]!;
    const status = refusalStatus(s.consequent as JsNode, res!);
    const property = status !== undefined ? STATUS_PROPERTY[status] : undefined;
    if (!property || !requestCondition(s.test as JsNode, req!, v.bound)) return unknown();
    if (countRefs(fn.body as JsNode, next) !== 1 || countRefs(s.test as JsNode, res!) || countRefs(s.test as JsNode, next)) return unknown();
    return { kind: 'refusal', property, at: [...at, { file: v.file, node: s }] };
  }
  // A pass-through: no response, no write to the request, no request object handed on.
  if (countRefs(fn.body as JsNode, res!) || countRefs(fn.body as JsNode, next) !== 1) return unknown();
  for (const s of before) {
    if (s.type !== 'ExpressionStatement') return unknown();
    const e = unwrap(s.expression as JsNode);
    if (e?.type !== 'CallExpression') return unknown();
    if (!onlyRequestValues(e, req!)) return unknown();
  }
  return { kind: 'pass-through', at };
}

function isNextCall(s: JsNode, next: string): boolean {
  const e = s.type === 'ExpressionStatement' ? unwrap(s.expression as JsNode) : s.type === 'ReturnStatement' ? unwrap(s.argument as JsNode) : undefined;
  return e?.type === 'CallExpression' && identifierName(e.callee as JsNode) === next && (e.arguments as JsNode[]).length === 0;
}

/** The literal status a branch responds with and then stops, or undefined. */
function refusalStatus(branch: JsNode, res: string): number | undefined {
  const stmts = branch.type === 'BlockStatement' ? branch.body as JsNode[] : [branch];
  let response: JsNode | undefined;
  if (stmts.length === 1 && stmts[0]!.type === 'ReturnStatement') response = unwrap(stmts[0]!.argument as JsNode);
  else if (stmts.length === 2 && stmts[0]!.type === 'ExpressionStatement' && stmts[1]!.type === 'ReturnStatement' && !stmts[1]!.argument) response = unwrap(stmts[0]!.expression as JsNode);
  if (response?.type !== 'CallExpression') return undefined;
  const callee = unwrap(response.callee as JsNode);
  if (callee?.type !== 'MemberExpression' || callee.computed) return undefined;
  const method = identifierName(callee.property as JsNode);
  const args = response.arguments as JsNode[];
  // res.sendStatus(N)
  if (method === 'sendStatus' && identifierName(callee.object as JsNode) === res && args.length === 1) return numberValue(args[0]);
  // res.status(N).json(...) | .send(...) | .end(...), with literal bodies only (evaluating them runs no code).
  if (!method || !RESPONSE_ENDS.has(method) || !args.every(literalBody)) return undefined;
  const inner = unwrap(callee.object as JsNode);
  if (inner?.type !== 'CallExpression') return undefined;
  const ic = unwrap(inner.callee as JsNode);
  if (ic?.type !== 'MemberExpression' || identifierName(ic.property as JsNode) !== 'status' || identifierName(ic.object as JsNode) !== res) return undefined;
  const iargs = inner.arguments as JsNode[];
  return iargs.length === 1 ? numberValue(iargs[0]) : undefined;
}

function literalBody(n: JsNode): boolean {
  const u = unwrap(n);
  if (!u) return false;
  if (stringValue(u) !== undefined || numberValue(u) !== undefined) return true;
  if (u.type === 'Literal') return true;
  if (u.type === 'ObjectExpression') return (u.properties as JsNode[]).every(p => p.type === 'Property' && !p.computed && literalBody(p.value as JsNode));
  if (u.type === 'ArrayExpression') return (u.elements as (JsNode | null)[]).every(e => !!e && literalBody(e));
  return false;
}

/**
 * A condition on one request value: `!v`, `v == null` / `=== undefined` / `=== null`, or `v !== c` / `v != c` with c a
 * literal or a literal factory argument; v is a property read on the request (optionally chained), or
 * `req.get('<literal>')` / `req.header('<literal>')`.
 */
function requestCondition(test: JsNode, req: string, bound: ReadonlyMap<string, BoundArg>): boolean {
  const t = unwrap(test)!;
  if (t.type === 'UnaryExpression' && t.operator === '!') return requestValue(t.argument as JsNode, req);
  if (t.type === 'BinaryExpression' && ['==', '===', '!=', '!=='].includes(t.operator as string)) {
    const [l, r] = [t.left as JsNode, t.right as JsNode];
    const side = requestValue(l, req) ? r : requestValue(r, req) ? l : undefined;
    if (!side) return false;
    const absent = isAbsent(side);
    if (t.operator === '==' || t.operator === '===') return absent;
    if (absent) return false; // `v !== undefined` refuses when present: not read
    const lit = unwrap(side)!;
    if (stringValue(lit) !== undefined || numberValue(lit) !== undefined) return true;
    const name = identifierName(lit);
    return !!name && bound.get(name)?.literal !== undefined;
  }
  return false;
}

const isAbsent = (n: JsNode) => { const u = unwrap(n); return (u?.type === 'Literal' && u.value === null) || identifierName(u) === 'undefined'; };

function requestValue(n: JsNode, req: string): boolean {
  let u = unwrap(n);
  if (u?.type === 'ChainExpression') u = unwrap(u.expression as JsNode);
  if (u?.type === 'CallExpression') {
    const callee = unwrap(u.callee as JsNode);
    const path = memberPath(callee);
    const args = u.arguments as JsNode[];
    return !!path && path.length === 2 && path[0] === req && (path[1] === 'get' || path[1] === 'header') && args.length === 1 && stringValue(args[0]) !== undefined;
  }
  const path = memberPath(u);
  return !!path && path.length >= 2 && path[0] === req;
}

/** A call whose arguments read only plain request values (and nothing of the request handed on whole). */
function onlyRequestValues(call: JsNode, req: string): boolean {
  let ok = true;
  walk(call, (n, parents) => {
    if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression' || (n.type === 'UnaryExpression' && n.operator === 'delete')) ok = false;
    if (n.type !== 'Identifier' || n.name !== req) return;
    const p = parents[parents.length - 1];
    const prop = p?.type === 'MemberExpression' && p.object === n && !p.computed ? identifierName(p.property as JsNode) : undefined;
    const gp = parents[parents.length - 2];
    // `req.method` read as a value, not called and not the object of a further member access.
    if (!prop || !REQUEST_VALUES.has(prop) || (gp?.type === 'CallExpression' && gp.callee === p) || (gp?.type === 'MemberExpression' && gp.object === p)) ok = false;
  });
  return ok;
}

function countRefs(node: JsNode, name: string): number {
  let count = 0;
  walk(node, (n, parents) => {
    if (n.type !== 'Identifier' || n.name !== name) return;
    const p = parents[parents.length - 1];
    if (p?.type === 'MemberExpression' && p.property === n && !p.computed) return;
    if (p?.type === 'Property' && p.key === n && !p.computed && !p.shorthand) return;
    count++;
  });
  return count;
}
