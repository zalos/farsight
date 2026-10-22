// Whether the parser's graph accounts for every call a function's captured bytes could make. The parser records an
// edge only for calls it can name; a computed call (`handlers[name]()`), a call on a value of unknown type, a call to a
// global and a function handed on as a value leave no edge, and a search that relied on the edges alone would report
// absence it has not established. This reads the function's captured text lexically and counts every place that
// could be a call, without trying to tell strings, comments or types apart: anything that looks like one counts. The
// count can only be too high, never too low, so a function is "accounted for" only when the parser recorded at least
// as many call sites inside it. A function name used as a value (not called where it appears) is counted as well.

/** Words that precede a parenthesis without calling anything. */
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'void', 'delete', 'in', 'of',
  'instanceof', 'await', 'yield', 'case', 'do', 'else', 'throw', 'function']);

export interface BodyScan {
  /** Places that could be a call: `x(`, `x)(`, `x](`, `x>(`, `x.(`, `x/(`, a tagged template, `new`. */
  readonly callSites: number;
  /** Names of known functions that appear without being called right there. */
  readonly valueReferences: number;
}

export function scanBody(text: string, functionNames: ReadonlySet<string>, ownName: string | undefined): BodyScan {
  let callSites = 0;
  // A declaration header names the function and its parameters; it is not a call.
  const header = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*(?:<[^>(]*>)?\s*\(/.exec(text)
    ?? /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*[A-Za-z_$#][\w$]*\s*(?:<[^>(]*>)?\s*\([^)]*\)\s*(?::[^{]*)?\{/.exec(text);
  const skipUntil = header ? header[0].length : 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '`') {
      // A tagged template is a call: an identifier, `)` or `]` right before the backtick.
      const p = prevSignificant(text, i);
      if (p >= skipUntil && /[\w$)\]]/.test(text[p]!) && !endsWithWord(text, p, NOT_CALLS)) callSites++;
      continue;
    }
    if (c !== '(' || i < skipUntil) continue;
    const p = prevSignificant(text, i);
    if (p < 0) continue;
    const before = text[p]!;
    if (/[\w$]/.test(before)) { if (!endsWithWord(text, p, NOT_CALLS)) callSites++; }
    else if (/[)\].>/]/.test(before)) callSites++;
  }
  for (const m of text.matchAll(/\bnew\b/g)) if (m.index! >= skipUntil) callSites++;
  let valueReferences = 0;
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = m[0];
    const at = m.index!;
    if (!functionNames.has(name) || at < skipUntil || (name === ownName && at < skipUntil + 1)) continue;
    if (at > 0 && /[\w$]/.test(text[at - 1]!)) continue;
    const next = nextSignificant(text, at + name.length);
    if (next >= 0 && (text[next] === '(' || text[next] === '`')) continue;
    valueReferences++;
  }
  return { callSites, valueReferences };
}

function prevSignificant(text: string, i: number): number {
  let p = i - 1;
  while (p >= 0 && /\s/.test(text[p]!)) p--;
  return p;
}
function nextSignificant(text: string, i: number): number {
  let p = i;
  while (p < text.length && /\s/.test(text[p]!)) p++;
  return p < text.length ? p : -1;
}
function endsWithWord(text: string, end: number, words: ReadonlySet<string>): boolean {
  let s = end;
  while (s > 0 && /[\w$]/.test(text[s - 1]!)) s--;
  return words.has(text.slice(s, end + 1));
}
