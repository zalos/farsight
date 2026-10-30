/** Bounded, declarative matching over selected source files; the same pass powers ingest and dry runs. */
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { grammarForFile, grammarQuery } from '@farsight/code-parser';
import { grammarParser, normalizePath, type TSNode } from '@farsight/code-parser/support';
import { configSchemaProblem } from '@farsight/graph/config';
import {
  t,
  patternFilesText,
  type GraphFragment,
  type GraphNode,
  type GraphEdge,
  type PatternDecl,
  type PatternsMeta,
  type PatternRuleReport,
} from '@farsight/core';
import { collectFiles, globToRegExp } from './shared/files.js';
import type { WorkspaceConfig } from './shared/config-files.js';
import type { IngestOptions } from './types.js';

export const PATTERN_MAX_BYTES = 1024 * 1024;
export const PATTERN_MAX_RULES = 64;
export const PATTERN_BUDGET_MS = 1000;

export interface PatternMatch {
  rule: string;
  file: string;
  path: string;
  line: number;
  endLine: number;
  text: string;
  captures: Record<string, string>;
  kind: PatternDecl['emit']['kind'];
  name: string;
  handler?: string;
  unresolved: string[];
}
export interface PatternRunOptions {
  rule?: string;
  /** Tests can lower the fixed production budget; a caller cannot raise it. */
  budgetMs?: number;
  onMatch?: (match: PatternMatch) => void;
}
interface Match {
  line: number;
  endLine: number;
  text: string;
  captures: Record<string, string>;
}
const word = (key: string) => t('config.patterns.' + key, 'professional');
const fill = (template: string, captures: Record<string, string>): string | undefined => {
  let missing = false;
  const value = template.replace(/\$([A-Za-z_][A-Za-z0-9_]*|\d+)/g, (_, key: string) => {
    if (!Object.hasOwn(captures, key) || captures[key] === undefined) {
      missing = true;
      return '';
    }
    return captures[key]!;
  });
  return missing ? undefined : value;
};

/** Static literals, identifiers and member paths only; expressions are never evaluated. */
function valueOf(node: TSNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'ERROR' && node.namedChildren.length === 1) return valueOf(node.namedChildren[0]);
  if (['string', 'string_literal', 'template_string'].includes(node.type)) {
    if (node.namedChildren.some((n) => n?.type === 'template_substitution')) return undefined;
    const text = node.text;
    if (text[0] === '"') {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    }
    if (text[0] === "'" || text[0] === '`') {
      return text.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\\'"`nrtbfv0])/g, (_, code: string) => {
        if (code[0] === 'u' || code[0] === 'x') return String.fromCharCode(parseInt(code.slice(1), 16));
        return (
          ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[code] ?? code
        );
      });
    }
    return undefined;
  }
  if (/^(?:[\w$]+)(?:\s*\.\s*[\w$]+)*$/.test(node.text)) return node.text.replace(/\s/g, '');
  return undefined;
}

function argsOf(rule: PatternDecl, args: TSNode | undefined): Record<string, string> {
  if (!('args' in rule.match) || !args) return {};
  const children = args.namedChildren.filter((n): n is TSNode => !!n && n.type !== 'comment');
  const positional = children.filter((n) => n.type !== 'element_value_pair');
  const pairs = new Map<string, TSNode>();
  for (const n of children) {
    if (n.type === 'element_value_pair') {
      const key = n.childForFieldName('key');
      const value = n.childForFieldName('value');
      if (key && value) pairs.set(key.text, value);
    }
    if (n.type === 'object')
      for (const pair of n.namedChildren) {
        const key = pair?.childForFieldName('key');
        const value = pair?.childForFieldName('value');
        if (key && value) pairs.set(valueOf(key) ?? key.text, value);
      }
  }
  const out: Record<string, string> = Object.create(null);
  for (const [name, selector] of Object.entries(rule.match.args ?? {})) {
    const selected =
      typeof selector === 'number'
        ? (positional.at(selector) ?? (selector === 0 ? pairs.get('value') : undefined))
        : (pairs.get(selector.slice(5)) ?? (selector === 'pair:value' ? positional[0] : undefined));
    const value = valueOf(selected);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Each sugar matcher is one syntax query; callee captures are matched without evaluating expressions. */
function compile(rule: PatternDecl, grammar: string): string | undefined {
  const m = rule.match;
  if ('query' in m) return m.query;
  if ('call' in m) {
    if (grammar === 'java') return '(method_invocation name: (_) @name arguments: (argument_list) @args) @site';
    if (['typescript', 'tsx', 'javascript'].includes(grammar))
      return '(call_expression function: (_) @name arguments: (arguments) @args) @site';
  }
  if ('decorator' in m && ['typescript', 'tsx', 'javascript'].includes(grammar)) return '(decorator (_) @name) @site';
  if ('annotation' in m && grammar === 'java')
    return '[(annotation name: (_) @name arguments: (annotation_argument_list) @args) (marker_annotation name: (_) @name)] @site';
  return undefined;
}

function calleeCaptures(template: string, actual: string): Record<string, string> | undefined {
  const wanted = template.split('.');
  const got = actual.replace(/\s/g, '').split('.');
  if (got.length !== wanted.length) return undefined;
  const captures: Record<string, string> = Object.create(null);
  for (let i = 0; i < wanted.length; i++) {
    const part = wanted[i]!;
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      const key = part.slice(1);
      if (captures[key] !== undefined && captures[key] !== got[i]) return undefined;
      captures[key] = got[i]!;
    } else if (part !== got[i]) return undefined;
  }
  return captures;
}

async function queryMatches(rule: PatternDecl, grammar: string, source: string): Promise<Match[] | undefined> {
  const compiled = compile(rule, grammar);
  if (!compiled) return undefined;
  const parse = await grammarParser(grammar);
  try {
    const query = await grammarQuery(grammar, compiled);
    const root = parse(source);
    if (!root) throw new Error(word('parseFailed'));
    const results = query.matches(root, { matchLimit: 65536 });
    if (query.didExceedMatchLimit()) throw new Error(word('queryLimit'));
    const matches: Match[] = [];
    for (const result of results) {
      const nodes = Object.fromEntries(result.captures.map((c) => [c.name, c.node]));
      if (!result.captures.length) continue;
      // With no @site, use the smallest ancestor that contains every capture.
      let site = nodes.site ?? result.captures[0]!.node;
      if (!nodes.site)
        while (
          site.parent &&
          result.captures.some(({ node }) => node.startIndex < site.startIndex || node.endIndex > site.endIndex)
        )
          site = site.parent;
      let captures: Record<string, string> = Object.create(null);
      if ('query' in rule.match) {
        for (const { name, node } of result.captures) captures[name] = valueOf(node) ?? node.text;
      } else {
        let name = nodes.name;
        let args = nodes.args;
        if ('decorator' in rule.match && name?.type === 'call_expression') {
          args = name.childForFieldName('arguments') ?? undefined;
          name = name.childForFieldName('function') ?? undefined;
        }
        let actual = name?.text ?? '';
        if ('call' in rule.match && grammar === 'java') {
          const object = site.childForFieldName('object');
          if (object) actual = `${object.text}.${actual}`;
        }
        const template =
          'call' in rule.match
            ? rule.match.call
            : 'decorator' in rule.match
              ? rule.match.decorator
              : 'annotation' in rule.match
                ? rule.match.annotation
                : '';
        const hit = calleeCaptures(template, actual);
        if (!hit) continue;
        captures = { ...hit, ...argsOf(rule, args) };
      }
      matches.push({ line: site.startPosition.row + 1, endLine: site.endPosition.row + 1, text: site.text, captures });
    }
    return matches;
  } finally {
    parse.dispose();
  }
}

function regexMatches(regex: RegExp, source: string): Match[] {
  return source.split(/\r?\n/).flatMap((line, i) => {
    const hit = regex.exec(line);
    return hit ? [{ line: i + 1, endLine: i + 1, text: hit[0], captures: { ...hit.groups } }] : [];
  });
}

function readSelected(root: string, path: string): string {
  const abs = resolve(root, path);
  const rel = relative(root, realpathSync(abs));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error(word('outside'));
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(word('unreadable'));
    if (st.size > PATTERN_MAX_BYTES) throw new Error(word('tooLarge'));
    const bytes = Buffer.alloc(PATTERN_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > PATTERN_MAX_BYTES) throw new Error(word('tooLarge'));
    return bytes.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Every rule of every config file over its selected files, joined to existing declarations by span. */
export async function applyPatterns(
  fragment: GraphFragment,
  repoRoot: string,
  options: IngestOptions,
  ws: WorkspaceConfig,
  run: PatternRunOptions = {},
): Promise<PatternsMeta> {
  const report: PatternsMeta = { rules: [] };
  const declarations = ws.files.flatMap((file) =>
    Array.isArray(file.config.patterns) ? file.config.patterns.map((rule) => ({ file, rule })) : [],
  );
  if (!declarations.length) return report;
  const root = realpathSync(repoRoot);
  // Empty extension matches all selected files, including extensionless regex inputs; glob filtering happens before reads.
  const files = collectFiles(root, [''], options)
    .map((abs) => relative(root, abs).replaceAll('\\', '/'))
    .sort();
  const byPath = new Map<string, GraphNode[]>();
  for (const node of fragment.nodes)
    if (node.loc?.repo === fragment.repo && !['file', 'module', 'repo', 'test'].includes(node.kind)) {
      const here = byPath.get(node.loc.path) ?? [];
      here.push(node);
      byPath.set(node.loc.path, here);
    }
  const nodes = new Map(fragment.nodes.map((node) => [node.id, node]));
  const edges = new Set(fragment.edges.map((edge) => `${edge.kind}|${edge.from}|${edge.to}`));
  const span = (node: GraphNode) => (node.loc!.endLine ?? node.loc!.line) - node.loc!.line;
  for (const [index, { file, rule }] of declarations.entries()) {
    if (run.rule && rule?.id !== run.rule) continue;
    const row: PatternRuleReport = {
      id: typeof rule?.id === 'string' ? rule.id : '',
      file: file.path,
      matched: 0,
      nodes: 0,
      edges: 0,
      unresolved: [],
      skipped: [],
    };
    report.rules.push(row);
    const skip = (path: string, reason: string) => row.skipped.push({ path, reason });
    if (index >= PATTERN_MAX_RULES) {
      skip(file.path, word('ruleLimit'));
      continue;
    }
    const invalid = configSchemaProblem({ patterns: [rule] }, 'config');
    if (invalid) {
      skip(file.path, word('invalid').replace('{error}', invalid));
      continue;
    }
    const started = performance.now();
    const budget = Math.max(0, Math.min(run.budgetMs ?? PATTERN_BUDGET_MS, PATTERN_BUDGET_MS));
    const globs = rule.files.map((glob) => globToRegExp(glob));
    let regex: RegExp | undefined;
    try {
      if ('regex' in rule.match) regex = new RegExp(rule.match.regex);
    } catch {
      skip(file.path, word('invalidRegex'));
      continue;
    }
    for (const path of files) {
      if (file.dir !== '.' && !path.startsWith(file.dir + '/')) continue;
      const local = file.dir === '.' ? path : path.slice(file.dir.length + 1);
      if (!globs.some((glob) => glob.test(local))) continue;
      if (performance.now() - started >= budget) {
        skip(path, word('budget'));
        break;
      }
      let matches: Match[] | undefined;
      try {
        const source = readSelected(root, path);
        const grammar = grammarForFile(path);
        matches = regex ? regexMatches(regex, source) : grammar ? await queryMatches(rule, grammar, source) : undefined;
      } catch (error) {
        const reason =
          error instanceof Error &&
          [word('tooLarge'), word('outside'), word('unreadable'), word('parseFailed'), word('queryLimit')].includes(
            error.message,
          )
            ? error.message
            : word('invalidQuery');
        skip(path, reason);
        continue;
      }
      if (!matches) {
        skip(path, word('grammar'));
        continue;
      }
      const here = byPath.get(path) ?? [];
      for (const match of matches) {
        row.matched++;
        const holding = here
          .filter((n) => n.loc!.line <= match.line && (n.loc!.endLine ?? n.loc!.line) >= match.endLine)
          .sort((a, b) => span(a) - span(b) || Number(a.kind === 'class') - Number(b.kind === 'class'));
        const host = holding[0];
        const unresolved: string[] = [];
        let resolvedTarget: GraphNode | undefined;
        const missing = (capture: string) => {
          if (!unresolved.includes(capture)) {
            unresolved.push(capture);
            row.unresolved.push({ path, line: match.line, capture });
          }
        };
        const interpolate = (template: string) => {
          const value = fill(template, match.captures);
          if (value === undefined) missing(template);
          return value;
        };
        const targetOf = (template: string | undefined): GraphNode | undefined => {
          if (!template) return undefined;
          if (template === 'enclosing') {
            if (!host) missing(template);
            if (host) resolvedTarget = host;
            return host;
          }
          const value = interpolate(template);
          if (value === undefined) return undefined;
          const exact = here.filter((n) => n.name === value);
          const cls = holding.find((n) => n.kind === 'class');
          const method = value.startsWith('this.') ? value.slice(5) : value;
          const candidates = exact.length
            ? exact
            : here.filter((n) => (cls ? n.name === `${cls.name}.${method}` : n.name.endsWith(`.${method}`)));
          if (candidates.length === 1) {
            resolvedTarget = candidates[0];
            return candidates[0];
          }
          missing(value);
          return undefined;
        };
        const emit = rule.emit;
        const handler = targetOf(emit.handler);
        const nameTemplate =
          emit.kind === 'route' ? `${emit.method ?? 'GET'} ${emit.path ?? ''}` : (emit.topic ?? emit.name ?? rule.id);
        let name = interpolate(nameTemplate);
        if (name && emit.kind === 'route') {
          const space = name.indexOf(' ');
          const method = name
            .slice(0, space)
            .replace(/^RequestMethod\./, '')
            .toUpperCase();
          const pathValue = name.slice(space + 1);
          if (!/^[A-Z]+$/.test(method) || !pathValue.startsWith('/')) {
            missing(nameTemplate);
            name = undefined;
          } else name = `${method} ${normalizePath(pathValue)}`;
        }
        const resolution: GraphEdge['resolution'] = {
          status: 'resolved',
          technique: 'config-pattern',
          confidence: regex ? 'MEDIUM' : 'HIGH',
          note: word('evidence')
            .replace('{from}', file.path)
            .replace('{rule}', rule.id)
            .replace('{path}', path)
            .replace('{line}', String(match.line)),
        };
        const link = (kind: GraphEdge['kind'], from: string, to: string) => {
          const id = `${kind}|${from}|${to}`;
          if (edges.has(id)) return;
          edges.add(id);
          fragment.edges.push({ id, kind, from, to, resolution });
          row.edges++;
        };
        const business = rule.business ?? emit.business;
        const description = business ? interpolate(business) : undefined;
        const tags = ['pattern:' + rule.id, ...(emit.tags ?? [])];
        if (name && emit.kind === 'entrypoint') {
          const target = handler ?? (!emit.handler ? targetOf('enclosing') : undefined);
          if (target) {
            target.tags = [...new Set([...target.tags, ...tags, 'entrypoint', name])];
            if (description)
              target.facets = { ...target.facets, business: { ...target.facets?.business, description } };
          }
        } else if (name) {
          const id = `${fragment.repo}::${emit.kind}::${name}`;
          const prior = nodes.get(id);
          if (prior) prior.tags = [...new Set([...prior.tags, ...tags])];
          else {
            const node: GraphNode = {
              id,
              kind: emit.kind as Exclude<PatternDecl['emit']['kind'], 'entrypoint'>,
              name,
              tags: [...tags, 'declared', ...(emit.kind === 'guard' ? ['auth'] : [])],
              loc: { repo: fragment.repo, path, line: match.line, endLine: match.endLine },
              snippet: match.text,
              ...(description ? { facets: { business: { description } } } : {}),
              ...(emit.tier && ['guard', 'rule'].includes(emit.kind)
                ? { gateTier: { tier: emit.tier, from: 'config' as const } }
                : {}),
            };
            nodes.set(id, node);
            fragment.nodes.push(node);
            row.nodes++;
          }
          if (emit.kind === 'route' && handler) link('calls', id, handler.id);
          if (emit.kind === 'guard') {
            const target = emit.guards ? targetOf(emit.guards) : handler;
            if (target) link('guards', id, target.id);
          }
          if (emit.kind === 'rule') {
            const target = emit.validates ? targetOf(emit.validates) : handler;
            if (target) link('validates', id, target.id);
          }
          if (emit.kind === 'queue') {
            const publisher = targetOf(emit.publishes);
            const consumer = emit.consumes ? targetOf(emit.consumes) : handler;
            if (publisher) link('publishes', publisher.id, id);
            if (consumer) link('consumes', id, consumer.id);
          }
        }
        run.onMatch?.({
          rule: rule.id,
          file: file.path,
          path,
          ...match,
          kind: emit.kind,
          name: name ?? nameTemplate,
          ...(resolvedTarget ? { handler: resolvedTarget.id } : {}),
          unresolved,
        });
      }
    }
  }
  return report;
}

/** Shared CLI/MCP text, with unresolved matches first; details are returned only by an explicit dry run. */
export function patternsTestText(result: { repo: string; report: PatternsMeta; matches: PatternMatch[] }): string {
  const matches = [...result.matches].sort(
    (a, b) =>
      Number(!!b.unresolved.length) - Number(!!a.unresolved.length) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return [
    ...patternFilesText({ [result.repo]: result.report }),
    ...matches.map((match) =>
      word('match')
        .replace('{site}', `${match.path}:${match.line}`)
        .replace('{captures}', JSON.stringify(match.captures))
        .replace('{kind}', match.kind)
        .replace('{name}', match.name)
        .replace(
          '{handler}',
          match.unresolved.length
            ? `${word('unresolved')} (${match.unresolved.join(', ')})`
            : (match.handler ?? word('noHandler')),
        ),
    ),
    ...(!result.report.rules.length ? [word('none')] : []),
  ].join('\n');
}
