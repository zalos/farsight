/**
 * Cited documents, quoted (the 2026-10-13 outsider round, F11). When a flow's `docs`, a decision's `doc`, or a
 * sentence the team wrote (`@business`, a doc comment, a flow or screen description) cites a markdown document
 * inside the source — by path, or as *ADR 0007* when the source keeps its ADRs in a `decisions/` or `adr/` folder —
 * the document becomes a `doc` node: its first heading as the title and its first paragraph **verbatim** (cut at a
 * word near 400 characters, never reworded, never summarised), and the citing node gets a `cites` edge to it.
 *
 * Path-confined: only files inside the source are read, never a URL, never a path that climbs out.
 */
import { readFileSync, statSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import type { GraphFragment, GraphNode, DocRef } from '@farsight/core';
import { collectFiles } from './shared/files.js';
import type { IngestOptions } from './types.js';

const QUOTE_MAX = 400;
const MAX_BYTES = 512 * 1024;

/** A GitHub-style heading slug: lower case, punctuation out, spaces to hyphens. */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
}

/** The first paragraph of prose in `lines` from `at`: headings, tables, comments, rules and `Key: value` lines skipped. */
function firstParagraph(lines: string[], at: number, stopAtHeading: boolean): { text: string; status?: string } {
  let status: string | undefined;
  const para: string[] = [];
  let inComment = false;
  for (let i = at; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (inComment) { if (line.includes('-->')) inComment = false; continue; }
    if (line.startsWith('<!--')) { if (!line.includes('-->')) inComment = true; if (para.length) break; continue; }
    if (!line) { if (para.length) break; continue; }
    if (/^#{1,6}\s/.test(line)) {
      if (para.length || stopAtHeading) break;
      // a `## Status` heading: its next line is the status
      if (/^#{1,6}\s+status\s*$/i.test(line)) {
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (next && !status) status = next.trim().replace(/^[-*]\s+/, '').replace(/\*\*/g, '');
      }
      continue;
    }
    // a block of `- **Key:** value` items (an ADR's Status, Date, Deciders…) is metadata, however long: skip it to its
    // blank line, keeping the Status as written
    if (!para.length && /^(?:[-*]\s+)?\*\*[^*]{1,40}:?\*\*:?/.test(line)) {
      for (; i < lines.length && lines[i]!.trim(); i++) {
        const item = /^(?:[-*]\s+)?\*\*([^*]{1,40}?):?\*\*:?\s*(.*)$/.exec(lines[i]!.trim());
        if (item && /^status$/i.test(item[1]!.trim()) && !status) status = inline(item[2]!);
      }
      continue;
    }
    const meta = /^[-*]?\s*\**([A-Za-z][A-Za-z ]{1,24})\**\s*:\s*\**\s*(.+)$/.exec(line);
    if (!para.length && meta && meta[2]!.length < 120) {
      if (/^status$/i.test(meta[1]!.trim()) && !status) status = inline(meta[2]!);
      continue;
    }
    // a leading quoted note (`> 2026-07-12 revisions: …`) is an aside to the document, not its first paragraph
    if (!para.length && line.startsWith('>')) { for (; i < lines.length && lines[i]!.trim(); i++); continue; }
    if (!para.length && (/^\|/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line) || /^```/.test(line))) continue;
    // the line under a `## Status` heading is the status, not the paragraph
    if (!para.length && status && line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '') === status) continue;
    para.push(line);
  }
  return { text: inline(para.join(' ')), ...(status ? { status } : {}) };
}

/**
 * Markdown's marks out of a quoted line, the words kept as written: `[text](url)` reads *text*, `**x**` / `_x_` / a
 * backticked span read *x*. Nothing is reworded.
 */
function inline(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Cut a paragraph at a word near `QUOTE_MAX`, never inside a word. */
function cutQuote(text: string): { quote: string; cut?: true } {
  if (text.length <= QUOTE_MAX) return { quote: text };
  const head = text.slice(0, QUOTE_MAX + 1);
  const at = head.lastIndexOf(' ');
  return { quote: (at > QUOTE_MAX * 0.6 ? head.slice(0, at) : text.slice(0, QUOTE_MAX)).replace(/[\s,;:]+$/, ''), cut: true };
}

/**
 * Read one document inside the source: its title (the first `#` heading, or with an anchor the heading the anchor
 * names) and the first paragraph under it, verbatim. Undefined when the path leaves the source, is not a file, is
 * too large, or cannot be read.
 */
export function readDocQuote(repoRoot: string, ref: string, anchor?: string): DocRef | undefined {
  const path = ref.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || /^[a-z]+:\/\//i.test(path) || path.startsWith('/') || path.includes('\0')) return undefined;
  const norm = posix.normalize(path);
  if (norm === '..' || norm.startsWith('../')) return undefined;
  const abs = resolve(repoRoot, norm);
  if (relative(repoRoot, abs).startsWith('..')) return undefined;
  let text: string;
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    text = readFileSync(abs, 'utf8');
  } catch { return undefined; }
  const lines = text.split(/\r?\n/);
  let at = 0;
  let title: string | undefined;
  if (anchor) {
    const want = anchor.toLowerCase();
    const i = lines.findIndex((l) => {
      const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l.trim());
      if (!m) return false;
      const slug = headingSlug(m[1]!);
      return slug === want || slug.startsWith(`${want}-`);
    });
    if (i >= 0) { title = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]!.trim())![1]; at = i + 1; }
  }
  if (!title) {
    const i = lines.findIndex((l) => /^#\s+\S/.test(l));
    if (i >= 0) { title = lines[i]!.replace(/^#\s+/, '').trim(); at = i + 1; }
  }
  const { text: para, status } = firstParagraph(lines, at, !!anchor && at > 0);
  const q = para ? cutQuote(para) : undefined;
  return { path: norm, ...(title ? { title } : {}), ...(q ? { quote: q.quote, ...(q.cut ? { cut: true as const } : {}) } : {}), ...(status ? { status } : {}) };
}

/** The `doc` node id for a source-relative path. */
export const docNodeId = (repo: string, path: string) => `${repo}::doc::${path}`;

/** `ADR 0007`, `ADR-7`, `ADR 0007's` — the number, as written. */
const ADR_RE = /\bADR[\s-]?0*(\d{1,4})\b/g;
/** A markdown path written in a sentence: `docs/product/x.md`, `docs/decisions/0007-y.md#context`. */
const PATH_RE = /(?:^|[\s(`'"[])((?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)*\.md)(?:#([\w-]+))?/g;

/**
 * The `doc` node pass over a fragment, in place. Reads each cited document once. `extra` are documents cited by
 * something that is not a node (a decision's `doc`) — they get a node and no edge; the caller reads their quote from
 * the answer. Returns the doc refs read, by `path` or `path#anchor`.
 */
export function applyCitedDocs(fragment: GraphFragment, repoRoot: string, options: IngestOptions, extra: { path: string; anchor?: string }[] = []): Map<string, DocRef> {
  const repo = fragment.repo;
  const read = new Map<string, DocRef | null>();
  const quoteOf = (path: string, anchor?: string): DocRef | undefined => {
    const k = anchor ? `${path}#${anchor}` : path;
    if (!read.has(k)) read.set(k, readDocQuote(repoRoot, path, anchor) ?? null);
    return read.get(k) ?? undefined;
  };
  // the ADR files the source keeps, by number — listed once, only when some sentence cites an ADR
  let adrs: Map<number, string> | undefined;
  const adrPath = (n: number): string | undefined => {
    if (!adrs) {
      adrs = new Map();
      try {
        for (const abs of collectFiles(repoRoot, ['.md'], options)) {
          const rel = relative(repoRoot, abs).replace(/\\/g, '/');
          const m = /(?:^|\/)(?:adr|adrs|decisions|decision-records)\/0*(\d{1,4})[-_ ][^/]*\.md$/i.exec(rel);
          if (m && !adrs.has(Number(m[1]))) adrs.set(Number(m[1]), rel);
        }
      } catch { /* an unreadable tree has no ADRs to offer */ }
    }
    return adrs.get(n);
  };
  const nodes = new Map(fragment.nodes.map((n) => [n.id, n]));
  const docNode = (ref: DocRef): string => {
    const id = docNodeId(repo, ref.path);
    if (!nodes.has(id)) {
      // the node carries the document's own heading and first paragraph — never the anchor's section
      const whole = quoteOf(ref.path) ?? ref;
      const n: GraphNode = { id, kind: 'doc', name: whole.title ?? ref.path.split('/').pop()!, tags: ['doc'], doc: whole };
      nodes.set(id, n);
      fragment.nodes.push(n);
    }
    return id;
  };
  const seen = new Set<string>();
  let seq = fragment.edges.length;
  const cite = (from: string, path: string, via: 'docs' | 'text', anchor?: string) => {
    const ref = quoteOf(path, anchor);
    if (!ref) return;
    const to = docNode(ref);
    const key = `${from}|${to}`;
    if (seen.has(key) || from === to) return;
    seen.add(key);
    fragment.edges.push({
      id: `cites${seq++}`, kind: 'cites', from, to,
      meta: { via, ...(anchor ? { anchor } : {}) },
      resolution: { status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH', note: via === 'docs' ? 'listed in the manifest' : 'named in a sentence the team wrote' },
    });
  };
  // the sentences a person wrote on the node: its `@business` line and its doc comment (a flow's description is its docs)
  const sentencesOf = (n: GraphNode): string[] => [n.facets?.business?.description, n.docs].filter((x): x is string => typeof x === 'string' && !!x);
  for (const n of [...fragment.nodes]) {
    if (n.kind === 'doc') continue;
    for (const l of n.links ?? []) if (l.kind === 'doc' && l.ref) {
      const [p, a] = l.ref.split('#');
      cite(n.id, p!, 'docs', a || undefined);
    }
    for (const text of sentencesOf(n)) {
      for (const m of text.matchAll(ADR_RE)) { const p = adrPath(Number(m[1])); if (p) cite(n.id, p, 'text'); }
      for (const m of text.matchAll(PATH_RE)) cite(n.id, m[1]!, 'text', m[2] || undefined);
    }
  }
  const out = new Map<string, DocRef>();
  for (const x of extra) {
    const ref = quoteOf(x.path, x.anchor);
    if (!ref) continue;
    docNode(ref);
    out.set(x.anchor ? `${x.path}#${x.anchor}` : x.path, ref);
  }
  return out;
}
