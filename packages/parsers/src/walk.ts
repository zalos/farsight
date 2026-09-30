/** Minimal generic AST walker for oxc's ESTree-style JSON output. */

export interface AstNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

export function isNode(v: unknown): v is AstNode {
  return typeof v === 'object' && v !== null && typeof (v as AstNode).type === 'string';
}

/** Depth-first walk; return false from visit to skip a subtree. */
export function walk(node: unknown, visit: (n: AstNode, parents: AstNode[]) => boolean | void, parents: AstNode[] = []): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parents);
    return;
  }
  if (!isNode(node)) return;
  if (visit(node, parents) === false) return;
  const nextParents = [...parents, node];
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    walk(node[key], visit, nextParents);
  }
}

/** Build a byte-offset → 1-based line lookup for a source file. */
export function lineIndex(source: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return (offset: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** String value of a Literal / StringLiteral / TemplateLiteral (template holes become :param). */
export function stringValue(n: unknown): string | null {
  if (!isNode(n)) return null;
  if ((n.type === 'Literal' || n.type === 'StringLiteral') && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') {
    const quasis = (n.quasis as AstNode[]) ?? [];
    const parts = quasis.map((q) => ((q.value as { cooked?: string })?.cooked ?? ''));
    return parts.join(':param').replace(/:param$/, ':param');
  }
  return null;
}

/** callee name for foo(...) or obj chain tail for a.b.c(...) → ['a','b','c']. */
export function memberChain(n: unknown): string[] {
  if (!isNode(n)) return [];
  if (n.type === 'Identifier') return [String(n.name)];
  if (n.type === 'ThisExpression') return ['this']; // this.method() — the adapter resolves it to the class's own method
  if (n.type === 'MemberExpression' || n.type === 'StaticMemberExpression') {
    const prop = n.property as AstNode | undefined;
    const propName = prop && (prop.type === 'Identifier' || prop.type === 'IdentifierName') ? String(prop.name) : null;
    const objChain = memberChain(n.object);
    return propName ? [...objChain, propName] : objChain;
  }
  return [];
}
