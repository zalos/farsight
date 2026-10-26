// Whether the parser's graph accounts for every call a function's captured bytes could make. The parser records an
// edge only for calls it can name; a computed call (`handlers[name]()`), a call on a value of unknown type, a call to a
// global and a function handed on as a value leave no edge, and a search that relied on the edges alone would report
// absence it has not established. This reads the function's captured text lexically and counts every place that
// could be a call, without trying to tell strings, comments or types apart: anything that looks like one counts. The
// count can only be too high, never too low, so a function is "accounted for" only when the parser recorded at least
// as many call sites inside it. A function name used as a value (not called where it appears) is counted as well.

/**
 * Reserved words that precede a parenthesis without calling anything. Only words that can never name a function are
 * listed (`of`, `await`, `yield` and `async` can, so they count), and a word read as a property (`obj.return(`) or a
 * private name is always a call.
 */
const NOT_CALLS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'return',
  'typeof',
  'void',
  'delete',
  'in',
  'instanceof',
  'case',
  'do',
  'else',
  'throw',
  'function',
]);
/** Identifier characters, Unicode included: `π()` is a call. */
const ID_CHAR = /[\p{ID_Continue}$\u200c\u200d]/u;
const ID_START = /[\p{ID_Start}$_]/u;
const IDENT = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/gu;

export interface BodyScan {
  /** Places that could be a call: `x(`, `x)(`, `x](`, `x>(`, `x.(`, `x/(`, a tagged template, `new`. */
  readonly callSites: number;
  /** Names of known functions that appear without being called right there. */
  readonly valueReferences: number;
}

export function scanBody(text: string, functionNames: ReadonlySet<string>, ownName: string | undefined): BodyScan {
  let callSites = 0;
  // A declaration header names the function and its parameters; it is not a call.
  const header =
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*(?:<[^>(]*>)?\s*\(/.exec(text) ??
    /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*[A-Za-z_$#][\w$]*\s*(?:<[^>(]*>)?\s*\([^)]*\)\s*(?::[^{]*)?\{/.exec(
      text,
    );
  const skipUntil = header ? header[0].length : 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '`') {
      // A tagged template is a call: an identifier, `)` or `]` right before the backtick.
      const p = prevSignificant(text, i);
      if (p >= skipUntil && (ID_CHAR.test(text[p]!) || /[)\]]/.test(text[p]!)) && !endsWithWord(text, p, NOT_CALLS))
        callSites++;
      continue;
    }
    if (c !== '(' || i < skipUntil) continue;
    const p = prevSignificant(text, i);
    if (p < 0) continue;
    const before = text[p]!;
    if (ID_CHAR.test(before)) {
      if (!endsWithWord(text, p, NOT_CALLS)) callSites++;
    } else if (/[)\].>/]/.test(before)) callSites++;
    // Anything else directly before a parenthesis that is not an operator or opener could still be a callee.
    else if (!/[(,;{}=!&|?:+\-*%^~<\[]/.test(before)) callSites++;
  }
  for (const m of text.matchAll(/\bnew\b/g)) if (m.index! >= skipUntil) callSites++;
  let valueReferences = 0;
  for (const m of text.matchAll(IDENT)) {
    const name = m[0];
    const at = m.index!;
    if (!functionNames.has(name) || at < skipUntil || (name === ownName && at < skipUntil + 1)) continue;
    if (at > 0 && ID_CHAR.test(text[at - 1]!)) continue;
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
  while (s > 0 && ID_CHAR.test(text[s - 1]!)) s--;
  if (!words.has(text.slice(s, end + 1))) return false;
  // `obj.return(`, `obj?.if(`, `this.#x(`: a property name, so a call.
  const before = prevSignificant(text, s);
  return !(before >= 0 && (text[before] === '.' || text[before] === '#'));
}

/**
 * Names a function's text binds itself: parameters, local declarations, catch bindings and destructured names. A
 * call edge the parser drew to a top-level function of one of these names may really call the local one, so the
 * search does not follow it. The scan collects too many names rather than too few.
 */
export function localNames(text: string, ownName: string | undefined): Set<string> {
  const out = new Set<string>();
  const addAll = (part: string) => {
    for (const m of part.matchAll(IDENT)) out.add(m[0]);
  };
  for (const m of text.matchAll(
    /\b(?:const|let|var|class|function\s*\*?)\s+([\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)/gu,
  ))
    out.add(m[1]!);
  for (const m of text.matchAll(/\b(?:const|let|var)\s*([{[][^=;]*?[}\]])\s*=/gu)) addAll(m[1]!);
  for (const m of text.matchAll(/\bcatch\s*\(([^)]*)\)/gu)) addAll(m[1]!);
  // Parameter lists: every name inside any parenthesised group. Telling a parameter list from a call's arguments needs
  // a parser (a type or a comment can sit between `)` and the body), so every group counts: a name collected too many
  // only stops the search following one edge, which it reports; a name missed would let it follow a shadowed call.
  for (const m of text.matchAll(/\(([^()]*)\)/gu)) addAll(m[1]!);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '(') continue;
    let depth = 0,
      j = i;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) break;
    }
    addAll(text.slice(i + 1, j));
  }
  for (const m of text.matchAll(/([\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*)\s*=>/gu)) out.add(m[1]!);
  if (ownName) {
    // The function's own name in its own header refers to itself, not a local.
    const own = new RegExp(`\\bfunction\\s*\\*?\\s*${ownName.replace(/[$]/g, '\\$')}\\b`, 'gu');
    const declared = [...text.matchAll(own)].length;
    if (declared <= 1) out.delete(ownName);
  }
  return out;
}
export { ID_START };
