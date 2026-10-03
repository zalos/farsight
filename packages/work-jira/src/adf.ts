// Atlassian Document Format ↔ markdown. Jira v3 has no plain-text or markdown
// body (research appendix §2), so Farsight owns this converter.
//
// ADF → markdown covers what Jira bodies carry: paragraphs, headings, bullet /
// ordered / task lists (nested), code blocks and inline code, links, mentions
// (@Name), simple tables (pipe rows), hard breaks, quotes, rules, panels and
// expands (their content), emoji, dates, status lozenges, inline cards. Media is
// a reference — `[attachment: name]` — never bytes.
//
// markdown → ADF covers what Farsight writes: paragraphs, headings, bullet and
// ordered lists, fenced code, inline code, links, bold, italic, strike, tables.
// A line break inside a paragraph is a hardBreak, both ways, so a comment reads
// the way it was typed.
import type { Body } from '@farsight/work';

export interface AdfMark { type: string; attrs?: Record<string, unknown> }
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}
export interface AdfDoc extends AdfNode { type: 'doc'; version: 1; content: AdfNode[] }

// ── ADF → markdown ─────────────────────────────────────────────────────────

function markText(n: AdfNode): string {
  let s = n.text ?? '';
  const marks = n.marks ?? [];
  const has = (t: string) => marks.find((m) => m.type === t);
  if (has('code')) s = '`' + s + '`';
  else {
    if (has('strong')) s = `**${s}**`;
    if (has('em')) s = `*${s}*`;
    if (has('strike')) s = `~~${s}~~`;
  }
  const link = has('link');
  if (link) s = `[${s}](${String(link.attrs?.href ?? '')})`;
  return s;
}

function mediaName(n: AdfNode): string {
  const a = n.attrs ?? {};
  const name = (a.alt as string) || (a.filename as string) || (a.id as string) || (a.url as string) || 'file';
  return `[attachment: ${name}]`;
}

function inline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return '';
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return markText(n);
      case 'hardBreak': return '\n';
      case 'mention': {
        const t = String(n.attrs?.text ?? n.attrs?.id ?? '');
        return t.startsWith('@') ? t : `@${t}`;
      }
      case 'emoji': return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
      case 'date': {
        const ts = Number(n.attrs?.timestamp);
        return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
      }
      case 'status': return `[${String(n.attrs?.text ?? '')}]`;
      case 'inlineCard': return String(n.attrs?.url ?? '');
      case 'media': case 'mediaInline': return mediaName(n);
      case 'placeholder': return '';
      default: return n.content ? inline(n.content) : n.text ?? '';
    }
  }).join('');
}

function cellText(cell: AdfNode): string {
  return blocks(cell.content ?? [], '').join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

function table(n: AdfNode): string {
  const rows = (n.content ?? []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return '';
  const lines: string[] = [];
  rows.forEach((r, i) => {
    const cells = (r.content ?? []).map(cellText);
    lines.push(`| ${cells.join(' | ')} |`);
    if (i === 0) lines.push(`|${cells.map(() => ' --- ').join('|')}|`);
  });
  return lines.join('\n');
}

function list(n: AdfNode, indent: string): string {
  const ordered = n.type === 'orderedList';
  const start = Number(n.attrs?.order ?? 1) || 1;
  const out: string[] = [];
  (n.content ?? []).forEach((item, i) => {
    const bullet = n.type === 'taskList'
      ? (item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] ')
      : ordered ? `${start + i}. ` : '- ';
    const pad = indent + ' '.repeat(bullet.length);
    if (item.type === 'taskItem') {
      out.push(indent + bullet + inline(item.content).replace(/\n/g, '\n' + pad));
      return;
    }
    const parts = item.content ?? [];
    let first = true;
    for (const p of parts) {
      if (p.type === 'bulletList' || p.type === 'orderedList' || p.type === 'taskList') {
        out.push(list(p, pad));
        continue;
      }
      const text = blocks([p], pad).join('\n');
      if (first) out.push(indent + bullet + (text.startsWith(pad) ? text.slice(pad.length) : text));
      else out.push(text);
      first = false;
    }
    if (first) out.push(indent + bullet.trimEnd());
  });
  return out.join('\n');
}

function blocks(nodes: AdfNode[], indent: string): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph': out.push(indent + inline(n.content).replace(/\n/g, '\n' + indent)); break;
      case 'heading': out.push(indent + '#'.repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1)))) + ' ' + inline(n.content)); break;
      case 'bulletList': case 'orderedList': case 'taskList': out.push(list(n, indent)); break;
      case 'codeBlock': {
        const lang = typeof n.attrs?.language === 'string' ? n.attrs.language : '';
        const body = (n.content ?? []).map((c) => c.text ?? '').join('');
        out.push([indent + '```' + lang, ...body.split('\n').map((l) => indent + l), indent + '```'].join('\n'));
        break;
      }
      case 'blockquote':
        out.push(blocks(n.content ?? [], '').join('\n\n').split('\n').map((l) => indent + '> ' + l).join('\n'));
        break;
      case 'rule': out.push(indent + '---'); break;
      case 'table': out.push(table(n)); break;
      case 'mediaSingle': case 'mediaGroup':
        out.push(indent + (n.content ?? []).map(mediaName).join(' '));
        break;
      case 'media': out.push(indent + mediaName(n)); break;
      case 'expand': case 'nestedExpand': {
        const title = typeof n.attrs?.title === 'string' && n.attrs.title ? [indent + `**${n.attrs.title}**`] : [];
        out.push([...title, ...blocks(n.content ?? [], indent)].join('\n\n'));
        break;
      }
      case 'panel': case 'layoutSection': case 'layoutColumn': case 'bodiedExtension':
        out.push(blocks(n.content ?? [], indent).join('\n\n'));
        break;
      default:
        if (n.content) out.push(...blocks(n.content, indent));
        else if (n.text) out.push(indent + n.text);
    }
  }
  return out.filter((s) => s !== '');
}

/** ADF document → markdown text. Tolerates null, a bare string (v2 wiki) and unknown nodes. */
export function adfToMarkdown(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  const d = doc as AdfNode;
  const content = d.type === 'doc' ? d.content ?? [] : [d];
  return blocks(content, '').join('\n\n').trim();
}

/** A Jira rich-text value as a contract Body (format adf, raw verbatim, text markdown). */
export function adfBody(raw: unknown): Body | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') return { format: 'wiki', raw, text: raw };
  return { format: 'adf', raw, text: adfToMarkdown(raw) };
}

// ── markdown → ADF ─────────────────────────────────────────────────────────

const INLINE = /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(\*([^*\s][^*]*)\*)|((?<![A-Za-z0-9_])_([^_\s][^_]*)_(?![A-Za-z0-9_]))/;

// ADF lets the code mark combine with link only: `**\`x\`**` stays code, never code + strong (Jira refuses that body)
function withMark(nodes: AdfNode[], mark: AdfMark): AdfNode[] {
  return nodes.map((n) => {
    if (n.type !== 'text') return n;
    if (mark.type !== 'link' && n.marks?.some((m) => m.type === 'code')) return n;
    return { ...n, marks: [...(n.marks ?? []), mark] };
  });
}

function parseInline(s: string): AdfNode[] {
  const out: AdfNode[] = [];
  let rest = s;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push({ type: 'text', text: rest }); break; }
    if (m.index > 0) out.push({ type: 'text', text: rest.slice(0, m.index) });
    if (m[1]) out.push({ type: 'text', text: m[1].slice(1, -1), marks: [{ type: 'code' }] });
    else if (m[2]) out.push(...withMark(parseInline(m[3]!), { type: 'link', attrs: { href: m[4]! } }));
    else if (m[5]) out.push(...withMark(parseInline(m[6]!), { type: 'strong' }));
    else if (m[7]) out.push(...withMark(parseInline(m[8]!), { type: 'strike' }));
    else if (m[9]) out.push(...withMark(parseInline(m[10]!), { type: 'em' }));
    else if (m[11]) out.push(...withMark(parseInline(m[12]!), { type: 'em' }));
    rest = rest.slice(m.index + m[0].length);
  }
  return out.filter((n) => n.type !== 'text' || n.text);
}

function inlineWithBreaks(lines: string[]): AdfNode[] {
  const out: AdfNode[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ type: 'hardBreak' });
    out.push(...parseInline(l));
  });
  return out;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

interface ListFrame { indent: number; node: AdfNode }

function parseList(lines: string[], start: number): { node: AdfNode; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const mk = (marker: string): AdfNode => (/\d/.test(marker)
    ? { type: 'orderedList', attrs: { order: parseInt(marker, 10) || 1 }, content: [] }
    : { type: 'bulletList', content: [] });
  const root = mk(first[2]!);
  const stack: ListFrame[] = [{ indent: first[1]!.length, node: root }];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const m = LIST_ITEM.exec(line);
    if (!m) {
      // continuation of the last item's paragraph
      if (line.trim() && /^\s+/.test(line)) {
        const items = stack.at(-1)!.node.content!;
        const para = items.at(-1)?.content?.[0];
        if (para) para.content!.push({ type: 'hardBreak' }, ...parseInline(line.trim()));
        continue;
      }
      break;
    }
    const ind = m[1]!.length;
    while (stack.length > 1 && ind < stack.at(-1)!.indent) stack.pop();
    if (ind > stack.at(-1)!.indent) {
      const parentItems = stack.at(-1)!.node.content!;
      const host = parentItems.at(-1);
      if (host) {
        const sub = mk(m[2]!);
        host.content!.push(sub);
        stack.push({ indent: ind, node: sub });
      }
    }
    stack.at(-1)!.node.content!.push({ type: 'listItem', content: [{ type: 'paragraph', content: parseInline(m[3]!) }] });
  }
  return { node: root, next: i };
}

/** Markdown → an ADF document. */
export function markdownToAdf(md: string): AdfDoc {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const content: AdfNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) content.push({ type: 'paragraph', content: inlineWithBreaks(para) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      const node: AdfNode = { type: 'codeBlock', content: body.length ? [{ type: 'text', text: body.join('\n') }] : [] };
      if (fence[1]) node.attrs = { language: fence[1] };
      content.push(node);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      content.push({ type: 'heading', attrs: { level: h[1]!.length }, content: parseInline(h[2]!.trim()) });
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line) && !para.length) { content.push({ type: 'rule' }); continue; }
    // a list may interrupt a paragraph (CommonMark: a bullet, or an ordered list starting at 1)
    const li = LIST_ITEM.exec(line);
    if (li && (!para.length || !/\d/.test(li[2]!) || /^1[.)]$/.test(li[2]!))) {
      flush();
      const { node, next } = parseList(lines, i);
      content.push(node);
      i = next - 1;
      continue;
    }
    if (line.trim().startsWith('|') && lines[i + 1] !== undefined && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const rows: AdfNode[] = [];
      const cell = (type: string, text: string): AdfNode => ({ type, attrs: {}, content: [{ type: 'paragraph', content: parseInline(text) }] });
      rows.push({ type: 'tableRow', content: splitRow(line).map((c) => cell('tableHeader', c)) });
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
        rows.push({ type: 'tableRow', content: splitRow(lines[i]!).map((c) => cell('tableCell', c)) });
      }
      i--;
      content.push({ type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^>\s?/, ''));
      i--;
      content.push({ type: 'blockquote', content: markdownToAdf(quoted.join('\n')).content });
      continue;
    }
    para.push(line);
  }
  flush();
  return { version: 1, type: 'doc', content };
}
