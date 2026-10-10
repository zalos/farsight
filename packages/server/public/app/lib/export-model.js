// lib/export-model.js — the pure half of export (round 2026-10-05, lane E).
//
// No DOM, no imports: what a saved picture is called, the facts written under
// it, the CSV a table becomes, the PDF a picture becomes, and the pinned link.
// lib/export.js draws; this decides. The server's test suite calls every
// function here with literals, so the rules a saved file obeys are rules a
// test holds.
//
// Export is client-side by decision: the DOM the reader sees, drawn to a
// canvas in the page. No server route makes a picture, a PDF or a CSV.

/**
 * A filename-safe word: lowercase letters, digits and single dashes.
 * @param {string} s
 * @returns {string}
 */
export function slug(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/**
 * A day as `YYYY-MM-DD` in this machine's time zone, from an ISO time or a Date — the date the graph was
 * taken, never the date the file was saved (that one is on the footer's second
 * half). An unreadable time gives '' rather than today, which would be a claim.
 * @param {string|Date|null|undefined} at
 * @returns {string}
 */
export function dayOf(at) {
  if (!at) return '';
  const d = at instanceof Date ? at : new Date(String(at));
  if (isNaN(d.getTime())) return '';
  // the reader's own calendar day — the one the sync chip and the Map's as-of stamp print
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * The saved file's name: `farsight-<surface>-<source>-sync<N>-<date>.<ext>`.
 * A part the graph does not carry is left out, never invented: no sync → no
 * `syncN` part, no date → no date part.
 * @param {{surface:string, source?:string, sync?:number|null, date?:string, ext:string, subject?:string}} o
 * @returns {string}
 */
export function exportFilename(o) {
  const parts = ['farsight', slug(o.surface) || 'view'];
  const src = slug(o.source);
  if (src) parts.push(src);
  const sub = slug(o.subject);
  if (sub) parts.push(sub);
  if (o.sync != null && Number.isFinite(+o.sync)) parts.push('sync' + (+o.sync));
  if (o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date)) parts.push(o.date);
  return parts.join('-') + '.' + String(o.ext || 'png').replace(/^\./, '');
}

/**
 * The facts a saved picture carries under it — the same facts the header's
 * sync chip and the Map's as-of stamp print: which source, which sync, which
 * source commit, the day that sync was taken, the lens it was read in, and the
 * Farsight build that drew it.
 *
 * @param {{meta?:any, version?:any, lens?:string, surface:string, title?:string, today?:Date}} o
 * @returns {{surface:string, title:string, source:string, sync:number|null, commit:string, date:string, lens:string, build:string, saved:string}}
 */
export function footerFacts(o) {
  const meta = o.meta || {};
  const v = o.version || {};
  const sync = v.graph && v.graph.sync != null ? v.graph.sync : meta.sync != null ? meta.sync : null;
  const repos = Array.isArray(meta.repos) ? meta.repos : [];
  const source = meta.workspace || (repos[0] && (repos[0].name || repos[0])) || '';
  return {
    surface: o.surface,
    title: o.title || '',
    source: String(source || ''),
    sync: sync != null && Number.isFinite(+sync) ? +sync : null,
    commit: meta.commit ? String(meta.commit).slice(0, 7) : '',
    date: dayOf(meta.generatedAt),
    lens: o.lens || 'hybrid',
    build: (v.farsight && v.farsight.commit) || (meta.farsight && meta.farsight.commit) || '',
    saved: dayOf(o.today || new Date()),
  };
}

/**
 * Fill `{name}` placeholders. The template is read as parts between ` · `; a
 * part whose value is missing is dropped whole (` · source {commit}` with no
 * commit reads as nothing), so a footer never prints an empty slot, a dangling
 * word or the placeholder itself.
 * @param {string} template
 * @param {Record<string, string|number|null|undefined>} values
 * @returns {string}
 */
export function fill(template, values) {
  return String(template || '').split(' · ').map((seg) => {
    let missing = false;
    const out = seg.replace(/\{(\w+)\}/g, (_, k) => {
      const v = values[k];
      if (v == null || v === '') { missing = true; return ''; }
      return String(v);
    });
    return missing ? '' : out.trim();
  }).filter(Boolean).join(' · ');
}

/**
 * The two lines written under a saved picture. The words come from the
 * catalog (`t` is injected); the values from footerFacts.
 *   line 1 — what this is: `<surface> · <title>`
 *   line 2 — where and when it is true: `<source> · sync N · source <commit> · as of <date> · <lens>`
 *   line 3 — who drew it: `drawn by Farsight <build> · saved <day>`
 * @param {ReturnType<typeof footerFacts>} f
 * @param {(key:string)=>string} t
 * @returns {string[]}
 */
export function footerLines(f, t) {
  const lens = t('export.footer.lens.' + (f.lens === 'business' || f.lens === 'code' ? f.lens : 'hybrid'));
  return [
    fill(t('export.footer.what'), { surface: t('export.surface.' + f.surface), title: f.title }),
    fill(t('export.footer.facts'), { source: f.source, n: f.sync, commit: f.commit, date: f.date, lens }),
    fill(t('export.footer.drawn'), { build: f.build, saved: f.saved }),
  ].filter(Boolean);
}

/**
 * One CSV cell, quoted the way the Tests matrix's CSV quotes (core
 * `testsMatrixCsv`): only when it holds a quote, a comma or a newline.
 * @param {unknown} v
 * @returns {string}
 */
export function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Rows to CSV text — the header first, one line per row, `\n` between lines
 * (the Tests matrix's own convention, so both spreadsheets open the same way).
 * @param {string[]} header
 * @param {unknown[][]} rows
 * @returns {string}
 */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/**
 * A cell's words as one line: the cell's own line breaks become ` · `, and
 * runs of spaces one space — what the reader sees, said on one row.
 * @param {string} text
 * @returns {string}
 */
export function cellWords(text) {
  return String(text == null ? '' : text).split(/\s*\n\s*/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
}

/**
 * Width and height of a PNG, from its IHDR chunk; null when the bytes are not a PNG.
 * @param {Uint8Array} b
 * @returns {{width:number, height:number}|null}
 */
export function pngSize(b) {
  if (!b || b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
  const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/**
 * How much larger than its CSS size a picture is drawn: at least the screen's
 * own density and 2, and as much as brings the long side to `target` pixels,
 * never past `max`, and never past `maxSide` on either side or `maxArea`
 * pixels in all (the browser refuses a canvas past those).
 * @param {number} w  CSS pixels
 * @param {number} h  CSS pixels
 * @param {{dpr?:number, target?:number, max?:number, maxSide?:number, maxArea?:number}} [o]
 * @returns {number}
 */
export function pictureScale(w, h, o = {}) {
  const dpr = Math.max(1, o.dpr || 1);
  const target = o.target || 3200, max = o.max || 4, maxSide = o.maxSide || 16000, maxArea = o.maxArea || 120e6;
  if (!(w > 0) || !(h > 0)) return 1;
  let r = Math.max(2, dpr, target / Math.max(w, h));
  r = Math.min(r, max, maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h)));
  return Math.max(0.25, Math.round(r * 100) / 100);
}

/**
 * A selector made to match inside the picture: the page's `:root`, `html` and
 * `body` become the classes the picture's own wrappers carry, so the
 * stylesheet's variables, theme and lens rules apply to the copy too.
 * @param {string} sel
 * @returns {string}
 */
export function pictureSelector(sel) {
  return String(sel)
    .replace(/:root\b/g, '.fx-root')
    .replace(/(^|[\s,>+~(])(html|body)(?=$|[\s,.:#[>+~)])/g, (_, pre, tag) => pre + '.fx-' + tag);
}

/**
 * How many rows of a picture to keep: the last row (from the bottom) whose
 * pixels are not all the ground colour, plus a margin. An element's copy can
 * lay out a little taller than the live page, so it is drawn with room to
 * spare and the empty rows under it are cut here.
 * @param {Uint8ClampedArray} px  RGBA rows, `width` pixels each
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number]} ground
 * @param {number} margin  rows kept under the last drawn row
 * @returns {number}
 */
export function keptRows(px, width, height, ground, margin) {
  const near = (i) => Math.abs(px[i] - ground[0]) + Math.abs(px[i + 1] - ground[1]) + Math.abs(px[i + 2] - ground[2]) <= 6;
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) if (!near(row + x * 4)) return Math.min(height, y + 1 + margin);
  }
  return Math.min(height, margin);
}

// ── the PDF: the same picture on one page ────────────────────────────────────

/**
 * The PDF page a picture is laid on: its own shape, at 96 px to the inch
 * (0.75 pt per CSS pixel), scaled down so the long side is at most `maxPt`
 * (A3's long side, 1191 pt) and never under `minPt` on the short side.
 * @param {number} cssW
 * @param {number} cssH
 * @param {{maxPt?:number}} [o]
 * @returns {{w:number, h:number}}
 */
export function pdfPage(cssW, cssH, o = {}) {
  const maxPt = o.maxPt || 1191;
  let w = cssW * 0.75, h = cssH * 0.75;
  const k = Math.min(1, maxPt / Math.max(w, h));
  w *= k; h *= k;
  return { w: Math.max(1, Math.round(w * 100) / 100), h: Math.max(1, Math.round(h * 100) / 100) };
}

/**
 * An A4 portrait page (595.28 × 841.89 pt) and where a picture of `cssW × cssH` CSS pixels lies on it:
 * fitted inside 28 pt margins, its shape kept, at the top — a document page, not a poster.
 * @param {number} cssW
 * @param {number} cssH
 * @returns {{page:{w:number,h:number}, place:{x:number,y:number,w:number,h:number}}}
 */
export function pdfA4(cssW, cssH) {
  const W = 595.28, H = 841.89, M = 28;
  const k = Math.min((W - 2 * M) / cssW, (H - 2 * M) / cssH);
  const w = Math.round(cssW * k * 100) / 100, h = Math.round(cssH * k * 100) / 100;
  return { page: { w: W, h: H }, place: { x: Math.round((W - w) / 2 * 100) / 100, y: Math.round((H - M - h) * 100) / 100, w, h } };
}

/** The bytes of a Latin-1 string (the PDF's own syntax is ASCII). */
function ascii(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** A PDF text string: printable ASCII kept, `(`, `)` and `\` escaped, everything else a `?`. */
function pdfText(s) {
  return '(' + String(s || '').replace(/[^\x20-\x7e]/g, '?').replace(/([()\\])/g, '\\$1') + ')';
}

/**
 * A one-page PDF that holds one JPEG, filling the page — the same picture the
 * PNG is, on a page. The smallest writer that does that: a catalog, a page, an
 * image XObject (DCTDecode, so the JPEG's bytes go in as they are), a content
 * stream that draws it, an info dictionary with the title, and the xref table.
 *
 * @param {Uint8Array} jpeg  the JPEG's bytes
 * @param {number} pxW  the JPEG's width in pixels
 * @param {number} pxH  the JPEG's height in pixels
 * @param {{page:{w:number,h:number}, place?:{x:number,y:number,w:number,h:number}, title?:string, subject?:string, created?:Date}} o
 * @returns {Uint8Array}
 */
export function pdfFromJpeg(jpeg, pxW, pxH, o) {
  const pw = o.page.w, ph = o.page.h;
  const num = (n) => String(Math.round(n * 100) / 100);
  const pl = o.place || { x: 0, y: 0, w: pw, h: ph };
  const content = (o.place ? '1 1 1 rg 0 0 ' + num(pw) + ' ' + num(ph) + ' re f ' : '') + 'q ' + num(pl.w) + ' 0 0 ' + num(pl.h) + ' ' + num(pl.x) + ' ' + num(pl.y) + ' cm /Im0 Do Q';
  const d = o.created || new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const when = 'D:' + d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + 'Z';
  const chunks = [];
  const offsets = [];
  let size = 0;
  const push = (part) => { const b = typeof part === 'string' ? ascii(part) : part; chunks.push(b); size += b.length; };
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const obj = (n, body) => { offsets[n] = size; push(n + ' 0 obj\n'); for (const b of body) push(b); push('\nendobj\n'); };
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  obj(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(pw) + ' ' + num(ph) + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>']);
  obj(4, ['<< /Type /XObject /Subtype /Image /Width ' + pxW + ' /Height ' + pxH + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n', jpeg, '\nendstream']);
  obj(5, ['<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream']);
  obj(6, ['<< /Title ' + pdfText(o.title) + (o.subject ? ' /Subject ' + pdfText(o.subject) : '') + ' /Producer (Farsight) /CreationDate (' + when + ') >>']);
  const xref = size;
  let x = 'xref\n0 7\n0000000000 65535 f \n';
  for (let n = 1; n <= 6; n++) x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  push(x + 'trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ── the pinned, dated link ───────────────────────────────────────────────────

/**
 * A viewer address pinned to the sync it was read at: `@sync:N` before the
 * query (the grammar `parseRoute` reads, and the one a journey link has always
 * carried) and `asof=<day>` in it, so the link says when it was true in words
 * a person can read in the address. A hash this grammar does not own comes
 * back unchanged; an earlier pin is replaced, never stacked.
 * @param {string} hash  e.g. `#/map?storyline=invoice&z=0.4`
 * @param {number|null} sync
 * @param {string} [day]  `YYYY-MM-DD`
 * @returns {string}
 */
export function pinnedHash(hash, sync, day) {
  const h = String(hash || '');
  if (!h.startsWith('#/')) return h;
  const qi = h.indexOf('?');
  let base = qi >= 0 ? h.slice(0, qi) : h;
  const query = qi >= 0 ? h.slice(qi + 1) : '';
  base = base.replace(/@sync:\d+$/, '');
  if (sync != null && Number.isFinite(+sync)) base += '@sync:' + (+sync);
  const pairs = query.split('&').filter((p) => p && !/^asof=/.test(p));
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) pairs.push('asof=' + day);
  return base + (pairs.length ? '?' + pairs.join('&') : '');
}

/**
 * Whether a pinned link is being read on a server that draws another sync:
 * the two numbers when they differ, else null. A link with no pin, or a graph
 * with no sync number, is never a mismatch — nothing to compare.
 * @param {number|null|undefined} pinned
 * @param {number|null|undefined} served
 * @returns {{pinned:number, served:number}|null}
 */
export function pinMismatch(pinned, served) {
  if (pinned == null || served == null) return null;
  if (!Number.isFinite(+pinned) || !Number.isFinite(+served)) return null;
  return +pinned === +served ? null : { pinned: +pinned, served: +served };
}
