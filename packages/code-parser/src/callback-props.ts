/**
 * Callback props — the function a parent hands a child component, credited to the child that runs it.
 *
 * A screen that is a form often makes no call of its own: its submit runs `onConfirm(...)`, a prop,
 * and the parent wrote the arrow that calls the API — sometimes two components up, the middle one
 * passing the prop straight through (`<MarkPaidForm onConfirm={onMarkPaid} />`). Read from the
 * parent alone the call is the parent's; read from the child alone it has none. The child is where
 * the person presses the button, so the journey needs the call there.
 *
 * Pass 1 reads, per JSX-bearing function, three facts from its own body (`propFactsOf`):
 * - **uses** — each place it runs one of its props: a call (`onConfirm(x)`, `props.onConfirm(x)`),
 *   a DOM attribute (`<form onSubmit={onConfirm}>`), or a hand-on to a child component — a bare
 *   prop as the attribute value, or a call of the prop inside an arrow given to a child — kept with
 *   the child's tag and attribute so pass 2 can follow it one component further;
 * - **handoffs** — what it hands a child component as an attribute: an arrow's own calls, a
 *   function it names, or a local bound to a call (`const approve = approveState(…)`);
 * - **branched** — the props it decides on (in an `if`, a `?:`, the left of `&&` / `||`).
 *
 * Pass 2 (in tsjs.ts) walks each handoff down the hand-on chain to the component that runs it and
 * emits `calls` edges from that component, technique `callback-prop`. **Never guessed:** every
 * component on the chain must be rendered from exactly one JSX site in the repo — a shared
 * component (a Button, a Dialog) rendered from many places runs a different function at each, so
 * nothing is credited to it, and the use falls back to the last component on the chain that is
 * specific to this site. A value handoff (`approve={approve}`) is credited only when the child
 * decides on it, as `meta.via: 'prop-value'`: the child shows the answer that function computed.
 */
import { walk, isNode, memberChain, type AstNode } from './walk.js';

export interface PropUse {
  prop: string;
  line: number;
  /** set when the prop is handed on to a child component rather than run here */
  via?: { tag: string; attr: string };
}

export interface Handoff {
  tag: string;
  attr: string;
  line: number;
  /** an arrow / function expression: the plain calls in its body, in source order */
  callees?: { name: string; line: number }[];
  /** a bare identifier that is not one of this component's props */
  ident?: string;
  /** that identifier's local binding is a call: `const approve = approveState(…)` */
  boundCall?: string;
}

export interface PropFacts {
  uses: PropUse[];
  handoffs: Handoff[];
  /** prop → the first line the component decides on it */
  branched: Map<string, number>;
}

const isFn = (n: unknown): boolean =>
  isNode(n) && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');

function paramsOfDecl(n: AstNode): AstNode[] {
  const fn = n.type === 'VariableDeclarator' ? (n.init as AstNode | undefined)
    : n.type === 'MethodDefinition' ? (n.value as AstNode | undefined)
    : n;
  return isNode(fn) && Array.isArray(fn.params) ? (fn.params as AstNode[]).filter(isNode) : [];
}

function namesOf(p: unknown): string[] {
  if (!isNode(p)) return [];
  if (p.type === 'Identifier') return [String(p.name)];
  if (p.type === 'ObjectPattern') return ((p.properties as AstNode[]) ?? []).flatMap((q) => namesOf(q.type === 'RestElement' ? q.argument : q.value));
  if (p.type === 'ArrayPattern') return ((p.elements as AstNode[]) ?? []).flatMap((q) => namesOf(q));
  if (p.type === 'AssignmentPattern') return namesOf(p.left);
  if (p.type === 'RestElement') return namesOf(p.argument);
  return [];
}

function jsxTag(opening: AstNode | undefined): string | null {
  const nm = opening?.name as AstNode | undefined;
  return nm && nm.type === 'JSXIdentifier' && typeof nm.name === 'string' ? nm.name : null;
}

/** The facts of one declared function's body; undefined when it has none worth keeping. */
export function propFactsOf(decl: AstNode, body: AstNode | null, line: (offset: number) => number): PropFacts | undefined {
  if (!body) return undefined;
  // the first parameter is the props: `{ onConfirm, busy: isBusy }` or `props`
  const first = paramsOfDecl(decl)[0];
  const p0 = first && first.type === 'AssignmentPattern' ? (first.left as AstNode) : first;
  const locals = new Map<string, string>(); // local name → prop name
  let propsObj: string | undefined;
  if (p0?.type === 'ObjectPattern') {
    for (const q of (p0.properties as AstNode[]) ?? []) {
      if (q.type !== 'Property') continue;
      const key = q.key as AstNode | undefined;
      const prop = key && typeof key.name === 'string' ? key.name : undefined;
      let v = q.value as AstNode | undefined;
      if (v?.type === 'AssignmentPattern') v = v.left as AstNode;
      if (prop && v?.type === 'Identifier') locals.set(String(v.name), prop);
    }
  } else if (p0?.type === 'Identifier') propsObj = String(p0.name);
  /** the prop an expression names: a destructured local or `props.x` */
  const propOf = (n: unknown): string | undefined => {
    if (!isNode(n)) return undefined;
    if (n.type === 'Identifier') return locals.get(String(n.name));
    const c = memberChain(n);
    return propsObj && c.length === 2 && c[0] === propsObj ? c[1] : undefined;
  };
  const calleeProp = (call: AstNode): string | undefined => propOf(call.callee);

  // locals bound to a call: `const approve = approveState(detail, roles)` (an `await` is see-through)
  const boundCalls = new Map<string, string>();
  walk(body, (n) => {
    if (n.type !== 'VariableDeclarator' || !isNode(n.id) || (n.id as AstNode).type !== 'Identifier') return;
    let init = n.init as AstNode | undefined;
    if (init?.type === 'AwaitExpression') init = init.argument as AstNode;
    if (init?.type !== 'CallExpression') return;
    const c = memberChain(init.callee);
    if (c.length === 1) boundCalls.set(String((n.id as AstNode).name), c[0]!);
  });

  const uses: PropUse[] = [];
  const handoffs: Handoff[] = [];
  const branched = new Map<string, number>();
  const noteBranch = (test: unknown): void => {
    walk(test, (t) => {
      const p = t.type === 'Identifier' ? locals.get(String(t.name)) : (t.type === 'MemberExpression' || t.type === 'StaticMemberExpression') ? propOf(t) : undefined;
      if (p && !branched.has(p)) branched.set(p, line(t.start ?? 0));
    });
  };

  const visit = (n: AstNode): boolean | void => {
    if (n.type === 'IfStatement' || n.type === 'ConditionalExpression') noteBranch(n.test);
    else if (n.type === 'LogicalExpression' && (n.operator === '&&' || n.operator === '||')) noteBranch(n.left);
    if (n.type === 'CallExpression') {
      const p = calleeProp(n);
      if (p) uses.push({ prop: p, line: line(n.start ?? 0) });
      return;
    }
    if (n.type !== 'JSXOpeningElement') return;
    const tag = jsxTag(n);
    const isComponent = !!tag && /^[A-Z]/.test(tag);
    for (const a of (n.attributes as AstNode[]) ?? []) {
      if (a.type !== 'JSXAttribute') { walk(a, visit); continue; }
      const an = a.name as AstNode | undefined;
      const attr = an && an.type === 'JSXIdentifier' ? String(an.name) : undefined;
      const val = a.value as AstNode | undefined;
      const expr = val?.type === 'JSXExpressionContainer' ? (val.expression as AstNode | undefined) : undefined;
      if (!attr || !isNode(expr)) { walk(val, visit); continue; }
      const at = line(a.start ?? 0);
      const prop = propOf(expr);
      if (prop) { uses.push(isComponent ? { prop, line: at, via: { tag: tag!, attr } } : { prop, line: at }); continue; }
      // an arrow on a DOM element runs here: its calls are this component's own uses
      if (!isComponent) { walk(expr, visit); continue; }
      if (isFn(expr)) {
        const own = new Set((((expr as AstNode).params as AstNode[]) ?? []).flatMap(namesOf));
        const callees: { name: string; line: number }[] = [];
        walk((expr as AstNode).body, (b) => {
          if (b.type !== 'CallExpression') return;
          const p = calleeProp(b);
          if (p) { uses.push({ prop: p, line: line(b.start ?? 0), via: { tag: tag!, attr } }); return; }
          const c = memberChain(b.callee);
          if (c.length === 1 && !own.has(c[0]!)) callees.push({ name: c[0]!, line: line(b.start ?? 0) });
        });
        if (callees.length) handoffs.push({ tag: tag!, attr, line: at, callees });
        continue;
      }
      if (expr.type === 'Identifier') {
        const name = String(expr.name);
        handoffs.push({ tag: tag!, attr, line: at, ident: name, ...(boundCalls.has(name) ? { boundCall: boundCalls.get(name)! } : {}) });
        continue;
      }
      walk(expr, visit);
    }
    return false; // the attributes were read above; the element's children hang off the JSXElement
  };
  walk(body, visit);
  if (!uses.length && !handoffs.length && !branched.size) return undefined;
  return { uses: dedupeUses(uses), handoffs, branched };
}

/** One use per (prop, line, hand-on). */
function dedupeUses(uses: PropUse[]): PropUse[] {
  const seen = new Set<string>();
  return uses.filter((u) => {
    const k = `${u.prop}|${u.line}|${u.via?.tag ?? ''}|${u.via?.attr ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
