// HTML ↔ markdown-ish text, no dependency.
//
// `htmlToText` turns an Azure DevOps long-text field (System.Description,
// comments) into the plain rendering `Body.text` carries: paragraphs,
// headings, nested lists, code, links, bold/italic, line breaks and simple
// tables survive as markdown; every other tag is dropped and its text kept.
// `markdownToHtml` is the small inverse used for description edits.

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', trade: '™', copy: '©', reg: '®', bull: '•',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

interface Token { tag?: string; close?: boolean; attrs?: string; text?: string }

function tokenize(html: string): Token[] {
  const out: Token[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[2]) out.push({ tag: m[2].toLowerCase(), close: m[1] === '/', attrs: m[3] ?? '' });
    else out.push({ text: m[4] ?? m[0] });
  }
  return out;
}

function attr(attrs: string | undefined, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs ?? '');
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : undefined;
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'blockquote', 'header', 'footer', 'table']);

/** HTML → markdown-ish plain text. */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  const src = String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const toks = tokenize(src);
  let out = '';
  const lists: { ordered: boolean; n: number }[] = [];
  let pre = 0;
  const links: (string | undefined)[] = [];
  let row: string[] | null = null;
  let cell: string | null = null;
  let rowsInTable = 0;
  const emit = (s: string) => { if (cell !== null) cell += s; else out += s; };
  const newline = () => { if (cell !== null) { cell += ' '; return; } out = out.replace(/[ \t]+$/, ''); if (!out.endsWith('\n') && out) out += '\n'; };
  const blank = () => { if (cell !== null) { cell += ' '; return; } newline(); if (out && !out.endsWith('\n\n')) out += '\n'; };
  for (const tk of toks) {
    if (tk.text !== undefined) {
      let t = decodeEntities(tk.text);
      if (!pre) {
        t = t.replace(/\s+/g, ' ');
        const tail = cell !== null ? cell : out;
        if (t.startsWith(' ') && (tail === '' || /[\s\n]$/.test(tail))) t = t.slice(1);
      }
      emit(t);
      continue;
    }
    const tag = tk.tag!;
    if (tag === 'br') { if (cell !== null) cell += ' '; else out = out.replace(/[ \t]+$/, '') + '\n'; continue; }
    if (tag === 'hr' && !tk.close) { blank(); out += '---'; blank(); continue; }
    if (tag === 'img' && !tk.close) { const alt = attr(tk.attrs, 'alt') ?? ''; const s = attr(tk.attrs, 'src'); if (s) emit(`![${alt}](${s})`); continue; }
    if (/^h[1-6]$/.test(tag)) { if (!tk.close) { blank(); emit('#'.repeat(Number(tag[1])) + ' '); } else blank(); continue; }
    if (tag === 'ul' || tag === 'ol') {
      if (!tk.close) { lists.push({ ordered: tag === 'ol', n: 0 }); newline(); }
      else { lists.pop(); if (!lists.length) blank(); else newline(); }
      continue;
    }
    if (tag === 'li') {
      if (!tk.close) {
        newline();
        const l = lists.at(-1) ?? { ordered: false, n: 0 };
        l.n++;
        out += '  '.repeat(Math.max(0, lists.length - 1)) + (l.ordered ? `${l.n}. ` : '- ');
      } else newline();
      continue;
    }
    if (tag === 'b' || tag === 'strong') { emit('**'); continue; }
    if (tag === 'i' || tag === 'em') { emit('*'); continue; }
    if (tag === 'pre') { if (!tk.close) { blank(); out += '```\n'; pre++; } else { pre = Math.max(0, pre - 1); newline(); out += '```'; blank(); } continue; }
    if (tag === 'code') { if (!pre) emit('`'); continue; }
    if (tag === 'a') {
      if (!tk.close) { const href = attr(tk.attrs, 'href'); links.push(href); emit('['); }
      else {
        const href = links.pop();
        // [text](href), or the bare url when the text is the url
        const buf: string = cell !== null ? cell : out;
        const at = buf.lastIndexOf('[');
        const text = at >= 0 ? buf.slice(at + 1) : '';
        const repl = !href ? text : text.trim() === href ? href : `[${text}](${href})`;
        if (cell !== null) cell = buf.slice(0, at) + repl; else out = buf.slice(0, at) + repl;
      }
      continue;
    }
    if (tag === 'tr') {
      if (!tk.close) { row = []; }
      else if (row) {
        newline();
        out += `| ${row.join(' | ')} |`;
        if (rowsInTable === 0) { out += `\n|${row.map(() => ' --- ').join('|')}|`; }
        rowsInTable++;
        row = null;
      }
      continue;
    }
    if (tag === 'td' || tag === 'th') {
      if (!tk.close) cell = '';
      else if (cell !== null) { row?.push(cell.trim().replace(/\|/g, '\\|')); cell = null; }
      continue;
    }
    if (tag === 'table') { if (!tk.close) { rowsInTable = 0; blank(); } else blank(); continue; }
    if (tag === 'div') { newline(); continue; }
    if (BLOCK.has(tag)) { blank(); continue; }
  }
  return out
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_, c: string) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => `<a href="${href}">${text}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

/** Markdown (the subset htmlToText writes) → HTML for an HTML long-text field. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const stack: { type: 'ul' | 'ol'; indent: number }[] = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeLists = (toIndent = -1) => {
    while (stack.length && stack.at(-1)!.indent > toIndent) out.push(`</li></${stack.pop()!.type}>`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flushPara(); closeLists();
      const body: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i]!);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); closeLists(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); continue; }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = li[1]!.length;
      const type: 'ul' | 'ol' = /\d/.test(li[2]!) ? 'ol' : 'ul';
      const top = stack.at(-1);
      if (!top || indent > top.indent) { stack.push({ type, indent }); out.push(`<${type}><li>`); }
      else {
        closeLists(indent);
        const cur = stack.at(-1);
        if (!cur) { stack.push({ type, indent }); out.push(`<${type}><li>`); }
        else out.push('</li><li>');
      }
      out.push(inline(li[3]!));
      continue;
    }
    if (!line.trim()) { flushPara(); closeLists(); continue; }
    if (stack.length) { out.push(' ' + inline(line.trim())); continue; }
    para.push(line.trim());
  }
  flushPara(); closeLists();
  return out.join('');
}
