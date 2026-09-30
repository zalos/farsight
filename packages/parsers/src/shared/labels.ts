/**
 * `// @business …` branch-directive labels (Journey fork/arm labels) and the
 * shared fork-label text shape. Pure source-text + offset logic — `//` line and
 * `/* *​/` block comments look the same in every C-family language Farsight
 * parses, so TS and Java share this verbatim.
 */

/** Whitespace-collapse + ≤120-char cap — the fork-label shape (matches condition/requires). */
export function capLabel(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Text after `@business` in a comment body, as a fork label (or undefined if the tag is absent). */
function businessDirective(text: string): string | undefined {
  const m = text.match(/@business\b[ \t]*([\s\S]*)$/);
  if (!m) return undefined;
  const label = capLabel(m[1]!);
  return label || undefined;
}

// Fork label carried by the comment immediately ABOVE a statement/case: a run of
// `//` lines, or a block comment, whose text contains `@business <text>`. Nothing
// but indentation may sit between it and the statement. (Doc comments bind to
// declarations, so a declaration's block comment sits above the declaration, not
// above a branch — the required `@business` already excludes ordinary docs.)
export function leadingBranchLabel(source: string, startOffset: number): string | undefined {
  const before = source.slice(0, startOffset);
  const nl = before.lastIndexOf('\n');
  const head = nl < 0 ? before : before.slice(nl + 1);
  if (head.trim() !== '') return undefined; // code precedes the statement on its own line
  const above = (nl < 0 ? '' : before.slice(0, nl)).replace(/[ \t]*$/, '');
  if (!above) return undefined;
  // block comment ( /* … */ or /** … */ ) ending immediately above
  if (above.endsWith('*/')) {
    const open = above.lastIndexOf('/*');
    if (open < 0) return undefined;
    const inner = above.slice(open).replace(/^\/\*+/, '').replace(/\*\/$/, '').replace(/^\s*\*\s?/gm, ' ');
    return businessDirective(inner);
  }
  // stacked `//` line comments
  const collected: string[] = [];
  for (const raw of above.split('\n').reverse()) {
    const t = raw.trim();
    if (t.startsWith('//')) { collected.unshift(t.replace(/^\/\/+/, '').trim()); continue; }
    break;
  }
  return collected.length ? businessDirective(collected.join(' ')) : undefined;
}

// Fork label carried by a trailing `// @business …` (or an inline block comment
// `@business …`) on the source line at `startOffset`.
export function trailingBranchLabel(source: string, startOffset: number): string | undefined {
  const nl = source.indexOf('\n', startOffset);
  const lineText = source.slice(startOffset, nl < 0 ? source.length : nl);
  const lc = lineText.match(/\/\/[ \t]*@business\b[ \t]*(.*)$/);
  if (lc) return capLabel(lc[1]!) || undefined;
  const bc = lineText.match(/\/\*+[ \t]*@business\b[ \t]*([\s\S]*?)\*\//);
  if (bc) return capLabel(bc[1]!) || undefined;
  return undefined;
}

/** Comparison flips for AST-aware `else`-arm negation — shared across languages. */
export const NEGATE_FLIP: Record<string, string> = {
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '<': '>=', '>=': '<', '>': '<=', '<=': '>',
};
