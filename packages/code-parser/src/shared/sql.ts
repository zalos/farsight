/**
 * SQL text as a source of truth: the tables a string literal declares
 * (`CREATE TABLE …`) and the tables a query reads or writes. Pure — the
 * adapters hand in the text they found in a template or string literal and
 * decide where the resulting nodes and edges hang. Deliberately shallow: no
 * grammar, only the clauses that name a table, so a `WITH` chain, an
 * `INSERT … SELECT` or an `UPDATE … FROM` all yield every table they touch.
 * Anything that is not recognisably SQL yields nothing — the caller never has
 * to pre-filter.
 */

export interface SqlTable {
  name: string;
  columns: string[];
  /** character offset of the CREATE TABLE inside the text (for a line number) */
  offset: number;
  /** `CHECK (<col> IN ('A', 'B', …))` lists in the column list, per column, in declared order */
  checks: { column: string; values: string[] }[];
}

export interface SqlOp {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  write: boolean;
}

const CONSTRAINT_WORDS = new Set(['primary', 'constraint', 'unique', 'check', 'foreign', 'index', 'key', 'exclude', 'like']);
const KEYWORD_TABLES = new Set(['select', 'lateral', 'unnest', 'values', 'generate_series', 'only', 'jsonb_array_elements', 'json_array_elements', 'dual']);
const STATEMENT_START = /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(select|insert|update|delete|with|create)\b/i;

/** `"schema"."name"` · `schema.name` · `name` → `name` (quotes and schema stripped, lower-cased). */
function cleanName(raw: string): string {
  const parts = raw.replace(/["`\]\[]/g, '').split('.');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** Does the text start like a SQL statement (after leading comments)? */
export function looksLikeSql(text: string): boolean {
  return STATEMENT_START.test(text);
}

/**
 * Every `CREATE TABLE [IF NOT EXISTS] name ( … )` in the text, with its column
 * names — the first identifier of each column definition, constraint lines
 * skipped. Table-level parentheses (CHECK (…), REFERENCES x(y)) are balanced
 * so a constraint never ends the column list early.
 */
export function sqlTables(text: string): SqlTable[] {
  const out: SqlTable[] = [];
  const re = /create\s+(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."`]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = cleanName(m[1]!);
    if (!name) continue;
    // balance the parentheses to find the column list
    let depth = 1, i = re.lastIndex, start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    // comments inside the column list are prose, never a column (`-- a and b`)
    const body = text.slice(start, i - 1).replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
    const columns: string[] = [];
    // split on top-level commas only
    let cur = '', d = 0;
    const defs: string[] = [];
    for (const ch of body) {
      if (ch === '(') d++;
      else if (ch === ')') d--;
      if (ch === ',' && d === 0) { defs.push(cur); cur = ''; } else cur += ch;
    }
    defs.push(cur);
    for (const def of defs) {
      const first = def.trim().split(/\s+/)[0] ?? '';
      const ident = first.replace(/["`]/g, '');
      if (!ident || CONSTRAINT_WORDS.has(ident.toLowerCase())) continue;
      if (!/^[A-Za-z_][\w$]*$/.test(ident)) continue;
      columns.push(ident);
    }
    out.push({ name, columns, offset: m.index, checks: checkLists(body) });
  }
  return out;
}

/**
 * The tables a statement reads and writes: `FROM x` / `JOIN x` are reads,
 * `INSERT INTO x` / `UPDATE x` / `DELETE FROM x` are writes (a `DELETE FROM x`
 * is not also a read of x). `WITH name AS (…)` names are CTEs, not tables, and
 * are dropped. Deduped by table + op. Empty when the text is not SQL.
 */
export function sqlOps(text: string): SqlOp[] {
  if (!looksLikeSql(text)) return [];
  const t = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const ctes = new Set<string>();
  for (const m of t.matchAll(/\bwith\s+(?:recursive\s+)?([\w"]+)\s+as\s*\(/gi)) ctes.add(cleanName(m[1]!));
  for (const m of t.matchAll(/\)\s*,\s*([\w"]+)\s+as\s*\(/gi)) ctes.add(cleanName(m[1]!));
  const ops: SqlOp[] = [];
  const seen = new Set<string>();
  const push = (raw: string, op: SqlOp['op']) => {
    const table = cleanName(raw);
    if (!table || ctes.has(table) || KEYWORD_TABLES.has(table) || !/^[a-z_][\w$]*$/.test(table)) return;
    const key = `${op}|${table}`;
    if (seen.has(key)) return;
    seen.add(key);
    ops.push({ table, op, write: op !== 'select' });
  };
  const deletes = new Set<string>();
  for (const m of t.matchAll(/\bdelete\s+from\s+(?:only\s+)?([\w."`]+)/gi)) { push(m[1]!, 'delete'); deletes.add(cleanName(m[1]!)); }
  for (const m of t.matchAll(/\binsert\s+into\s+([\w."`]+)/gi)) push(m[1]!, 'insert');
  for (const m of t.matchAll(/\bupdate\s+(?:only\s+)?([\w."`]+)(?:\s+(?:as\s+)?[\w"]+)?\s+set\b/gi)) push(m[1]!, 'update'); // `UPDATE t alias SET`
  for (const m of t.matchAll(/\b(?:from|join)\s+(?:only\s+)?([\w."`]+)/gi)) {
    const name = cleanName(m[1]!);
    if (deletes.has(name)) continue;
    push(m[1]!, 'select');
  }
  return ops;
}

/** The CHECK (<col> IN ('A', …)) lists of a CREATE TABLE column list, per column, in declared order. */
export function checkLists(body: string): { column: string; values: string[] }[] {
  const out: { column: string; values: string[] }[] = [];
  for (const m of body.matchAll(/check\s*\(\s*"?(\w+)"?\s+in\s*\(([^)]*)\)/gi)) {
    const values = [...m[2]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
    if (values.length >= 2 && !out.some((o) => o.column === m[1])) out.push({ column: m[1]!, values });
  }
  return out;
}
