// lib/export.js — save a view as a picture, a PDF or (a table) a spreadsheet
// (round 2026-10-05, lane E; the decisions in docs/proposals/swarm-fixes-2026-10-05.md).
//
// Export is client-side: the DOM the reader sees is copied into an SVG
// `foreignObject` with the page's own stylesheet, drawn onto a canvas, and a
// footer is written under it — the source, the sync, its commit, the day and
// the lens, the facts the header's sync chip prints. A PDF is that same
// picture on one page (lib/export-model.js writes it). No server route makes
// any of it, and nothing leaves the browser.
//
// A surface puts `exportToolHtml(surface, cls)` in its toolbar and registers
// what to draw with `registerExport(surface, provider)`; the click, the menu,
// the drawing and the download are all here. The provider answers either
// `{ el }` (an element drawn whole, not only the part on screen) or
// `{ world, size, scale }` (the Map's transformed world, drawn at that scale).

import { S, esc, expose, currentLens } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { tipAttrs } from './tooltip.js';
import {
  footerFacts, footerLines, exportFilename, pictureScale, pictureSelector,
  pdfPage, pdfFromJpeg, toCsv, cellWords, keptRows,
} from './export-model.js';

const XHTML = 'http://www.w3.org/1999/xhtml';
/** The board's margin around a world picture, in CSS pixels. */
const WORLD_PAD = 32;
/** The footer's height per line and its padding, in CSS pixels (scaled with the picture). */
const FOOT_LINE = 17, FOOT_PAD = 14;

/** surface → provider: () => Promise<{el}|{world,size,scale}> plus { title, csv? } */
const PROVIDERS = new Map();

/**
 * Register what a surface's Save control draws.
 * @param {string} surface  `map` · `storyboard` · `portfolio`
 * @param {() => Promise<any>|any} provider
 * @param {{csv?: () => {header:string[], rows:string[][]}}} [extra]
 * @group Export
 */
export function registerExport(surface, provider, extra) {
  PROVIDERS.set(surface, { provider, ...(extra || {}) });
}

/**
 * The Save control a surface puts in its toolbar: one button, the save glyph
 * and the word, its tip from the catalog. It opens a menu of the ways the view
 * can be saved; it is never drawn into the picture itself.
 * @param {string} surface
 * @param {string} [cls]  the toolbar's own button class, so the control looks like its neighbours
 * @group Export
 */
export function exportToolHtml(surface, cls) {
  return '<button type="button" class="fx-tool ' + esc(cls || '') + '" data-export="' + esc(surface) + '" data-export-skip'
    + ' aria-haspopup="menu" aria-expanded="false" aria-label="' + esc(t('export.menu')) + '"'
    + tipAttrs({ key: 'export.tool', noFocus: true }) + '>' + sym('save') + '<span>' + esc(t('export.tool')) + '</span></button>';
}

// ── the menu ────────────────────────────────────────────────────────────────

let MENU = null;

function closeMenu(refocus) {
  if (!MENU) return;
  const { el, btn } = MENU;
  el.remove();
  btn.setAttribute('aria-expanded', 'false');
  MENU = null;
  if (refocus) btn.focus();
}

/**
 * Open the Save menu under its control: picture, PDF, and for a table a
 * spreadsheet. Arrow keys walk it, Esc closes it and gives the focus back.
 * @group Export
 */
export function openExportMenu(btn) {
  const surface = btn.dataset.export;
  if (MENU && MENU.btn === btn) { closeMenu(true); return; }
  closeMenu(false);
  const reg = PROVIDERS.get(surface);
  const items = [['png', 'export.png'], ['pdf', 'export.pdf']].concat(reg && reg.csv ? [['csv', 'export.csv']] : []);
  const el = document.createElement('div');
  el.className = 'fx-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', t('export.menu'));
  el.innerHTML = items.map(([fmt, key]) => '<button type="button" role="menuitem" data-fx-fmt="' + fmt + '"' + tipAttrs({ key, noFocus: true }) + '>'
    + sym('save') + '<span>' + esc(t(key)) + '</span></button>').join('');
  document.body.appendChild(el);
  const r = btn.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.top = Math.round(r.bottom + 6) + 'px';
  el.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  MENU = { el, btn };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fx-fmt]');
    if (!b) return;
    e.stopPropagation();
    closeMenu(true);
    saveView(surface, b.dataset.fxFmt).catch(() => {});
  });
  el.addEventListener('keydown', (e) => {
    const all = [...el.querySelectorAll('[role="menuitem"]')];
    const i = all.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  const first = el.querySelector('[role="menuitem"]');
  if (first) first.focus();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-export]');
  if (btn) { e.preventDefault(); openExportMenu(btn); return; }
  if (MENU && !MENU.el.contains(e.target)) closeMenu(false);
});

// ── the status line ─────────────────────────────────────────────────────────

let toastT = null;
function say(text, busy) {
  let el = document.getElementById('fx-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fx-toast';
    el.className = 'fx-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('busy', !!busy);
  clearTimeout(toastT);
  if (!busy) toastT = setTimeout(() => { el.hidden = true; }, 3200);
}

// ── the copy: the page's stylesheet, the element, its ancestors ─────────────

let CSS_CACHE = null;
/**
 * The page's stylesheet as text the picture can carry: every rule whose media
 * query holds in this window (flattened, so the picture keeps the layout the
 * reader sees), with `:root`, `html` and `body` renamed to the picture's own
 * wrappers. Animations and transitions are stopped: an SVG picture is drawn
 * at its first frame, where a fade-in is still invisible.
 */
function pictureCss() {
  const out = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.type === 1) out.push(pictureSelector(r.selectorText) + '{' + r.style.cssText + '}');
      else if (r.type === 4) { if (window.matchMedia(r.media.mediaText).matches) walk(r.cssRules); }
      else if (r.type === 12) { if (CSS.supports(r.conditionText)) walk(r.cssRules); }
      else if (r.cssRules && r.selectorText == null && r.type !== 7) walk(r.cssRules);
      else out.push(r.cssText);
    }
  };
  for (const sh of document.styleSheets) {
    let rules = null;
    try { rules = sh.cssRules; } catch { rules = null; }
    if (rules) walk(rules);
  }
  out.push('.fx-root *,.fx-root *::before,.fx-root *::after{animation:none!important;transition:none!important;caret-color:transparent}');
  out.push('.fx-root [data-export-skip]{display:none!important}');
  return out.join('\n');
}
function cssText() {
  // a media query can change with the window or the theme: the cache is per width × theme × lens
  const k = window.innerWidth + '|' + (document.documentElement.getAttribute('data-theme') || '') + '|' + document.body.className;
  if (!CSS_CACHE || CSS_CACHE.k !== k) CSS_CACHE = { k, css: pictureCss() };
  return CSS_CACHE.css;
}

/** Every same-origin image in the copy, read into the copy as data, so the picture holds it (an SVG picture loads nothing). */
async function inlineImages(orig, copy) {
  const a = [...orig.querySelectorAll('img')], b = [...copy.querySelectorAll('img')];
  const cache = new Map();
  await Promise.all(b.map(async (img, i) => {
    const src = (a[i] && (a[i].currentSrc || a[i].src)) || img.getAttribute('src') || '';
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
    if (!src || src.startsWith('data:')) return;
    try {
      if (!cache.has(src)) {
        cache.set(src, fetch(src, { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob() : null)).then((bl) => (bl ? new Promise((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.onerror = () => res(null);
          fr.readAsDataURL(bl);
        }) : null)));
      }
      const data = await cache.get(src);
      if (data) img.setAttribute('src', data); else img.removeAttribute('src');
    } catch { img.removeAttribute('src'); }
  }));
}

/** The sprite glyphs (`<use href="#sym-…">`) copied in: the picture cannot reach the page's sprite. */
function inlineGlyphs(copy) {
  for (const use of [...copy.querySelectorAll('use')]) {
    const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
    const symEl = ref.startsWith('#') ? document.getElementById(ref.slice(1)) : null;
    const svg = use.ownerSVGElement || use.parentNode;
    if (!symEl) { use.remove(); continue; }
    if (svg && svg.setAttribute && !svg.getAttribute('viewBox') && symEl.getAttribute('viewBox')) svg.setAttribute('viewBox', symEl.getAttribute('viewBox'));
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    for (const c of symEl.childNodes) g.appendChild(c.cloneNode(true));
    use.replaceWith(g);
  }
}

/** Form fields keep what the reader typed or picked (a copy carries attributes, not values). */
function keepValues(orig, copy) {
  const a = [...orig.querySelectorAll('input,textarea,select')], b = [...copy.querySelectorAll('input,textarea,select')];
  b.forEach((el, i) => {
    const o = a[i];
    if (!o) return;
    if (el.tagName === 'TEXTAREA') el.textContent = o.value;
    else if (el.tagName === 'SELECT') [...el.options].forEach((op, j) => { if (o.options[j] && o.options[j].selected) op.setAttribute('selected', ''); });
    else if (o.type === 'checkbox' || o.type === 'radio') { if (o.checked) el.setAttribute('checked', ''); }
    else el.setAttribute('value', o.value);
  });
}

function setImportant(el, props) {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
}

/**
 * The SVG document a view becomes: the page's stylesheet, the wrappers the
 * view sits in (as bare shells, so a selector like `.map-board .map-world`
 * still matches), and the copy of the view, at `w` × `h` CSS pixels.
 */
function svgOf(copy, orig, w, h, r, opts) {
  const root = document.createElementNS(XHTML, 'div');
  for (const a of document.documentElement.attributes) if (a.name !== 'class' && a.name !== 'style') root.setAttribute(a.name, a.value);
  root.setAttribute('class', 'fx-root fx-html ' + (document.documentElement.className || ''));
  const style = document.createElementNS(XHTML, 'style');
  style.textContent = cssText();
  root.appendChild(style);
  const body = document.createElementNS(XHTML, 'div');
  body.setAttribute('class', 'fx-body ' + (document.body.className || ''));
  for (const a of document.body.attributes) if (a.name.startsWith('data-')) body.setAttribute(a.name, a.value);
  setImportant(body, { width: w + 'px', height: h + 'px', overflow: 'hidden', margin: '0', position: 'relative' });
  root.appendChild(body);
  // the wrappers between the body and the view, outermost first, emptied
  const chain = [];
  for (let n = orig.parentElement; n && n !== document.body; n = n.parentElement) chain.unshift(n);
  let at = body;
  for (const n of chain) {
    const shell = n.cloneNode(false);
    shell.removeAttribute('hidden');
    setImportant(shell, {
      position: 'relative', display: 'block', overflow: 'visible', inset: 'auto', transform: 'none',
      width: w + 'px', 'max-width': 'none', 'min-width': '0', height: opts.fixedHeight ? h + 'px' : 'auto', 'max-height': 'none', 'min-height': '0',
      margin: '0', padding: '0', border: '0', 'box-shadow': 'none', opacity: '1', visibility: 'visible',
    });
    at.appendChild(shell);
    at = shell;
  }
  at.appendChild(copy);
  const xml = new XMLSerializer().serializeToString(root);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(w * r) + '" height="' + Math.round(h * r) + '" viewBox="0 0 ' + w + ' ' + h + '">'
    + '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">' + xml + '</foreignObject></svg>';
}

/** `rgb(…)` / `rgba(…)` as three numbers (a computed colour is always one of these). */
function parseColor(c) {
  const m = String(c || '').match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
  return m ? [+m[1], +m[2], +m[3]] : [10, 13, 20];
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(t('export.why.decode')));
    img.src = src;
  });
}

/** How tall an element is drawn, down to its last child the picture keeps (skipped parts and the trailing gutter left out). */
function keptHeight(el) {
  const top = el.getBoundingClientRect().top;
  let bottom = 0;
  for (const c of el.children) {
    if (c.hasAttribute('data-export-skip') || c.matches('[data-export-skip] *')) continue;
    const b = c.getBoundingClientRect();
    if (b.height) bottom = Math.max(bottom, b.bottom - top + (parseFloat(getComputedStyle(c).marginBottom) || 0));
  }
  return Math.ceil(Math.max(bottom + 24, 40));
}

/**
 * Draw a provider's answer into a canvas at `r` × its CSS size, with room for the footer.
 * @returns {Promise<{canvas:HTMLCanvasElement, w:number, h:number, r:number}>}
 */
async function drawPicture(src) {
  let orig, copy, w, h, fixedHeight = false;
  if (src.world) {
    // the Map's world, at the scale the board was fitted to, with a margin round it
    orig = src.world;
    const s = src.scale;
    w = Math.ceil(src.size.w * s + WORLD_PAD * 2);
    h = Math.ceil(src.size.h * s + WORLD_PAD * 2);
    copy = orig.cloneNode(true);
    setImportant(copy, { transform: 'translate(' + WORLD_PAD + 'px,' + WORLD_PAD + 'px) scale(' + s + ')', 'transform-origin': '0 0', transition: 'none' });
    fixedHeight = true;
  } else {
    orig = src.el;
    w = Math.ceil(orig.getBoundingClientRect().width);
    // with room to spare: the copy may lay out a little taller than the page; the empty rows are cut below
    h = Math.ceil(keptHeight(orig) * 1.25 + 120);
    copy = orig.cloneNode(true);
    setImportant(copy, { width: w + 'px', 'max-width': 'none', margin: '0', height: 'auto', 'max-height': 'none', overflow: 'visible', position: 'relative' });
  }
  keepValues(orig, copy);
  await inlineImages(orig, copy);
  inlineGlyphs(copy);
  copy.querySelectorAll('[data-export-skip]').forEach((n) => n.remove());
  const r = pictureScale(w, h, { dpr: window.devicePixelRatio || 1 });
  const svg = svgOf(copy, orig, w, h, r, { fixedHeight });
  const fullH = h;
  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  // an element's copy: cut the rows of ground under its last drawn part (a world is drawn at its own size)
  if (!src.world) {
    const probe = document.createElement('canvas');
    probe.width = w; probe.height = h;
    const pc = probe.getContext('2d');
    const g = parseColor(getComputedStyle(document.body).backgroundColor);
    pc.fillStyle = 'rgb(' + g.join(',') + ')';
    pc.fillRect(0, 0, w, h);
    pc.drawImage(img, 0, 0, w, h);
    const data = pc.getImageData(0, 0, w, h).data;
    // the empty rows are whatever colour the bottom row is: the page's ground, or a panel the view sits on
    const at = (h - 1) * w * 4 + Math.floor(w / 2) * 4;
    h = keptRows(data, w, h, [data[at], data[at + 1], data[at + 2]], 20);
  }
  const lines = src.lines || [];
  const foot = FOOT_PAD * 2 + FOOT_LINE * lines.length;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * r);
  canvas.height = Math.round((h + foot) * r);
  const ctx = canvas.getContext('2d');
  const cs = getComputedStyle(document.body);
  const v = (name, dflt) => (cs.getPropertyValue(name) || '').trim() || dflt;
  ctx.fillStyle = v('--ground', '#0A0D14');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // the picture's rows above the cut, drawn at r × (the source rect is in the SVG's own pixels)
  ctx.drawImage(img, 0, 0, img.naturalWidth || img.width, Math.round((img.naturalHeight || img.height) * h / fullH), 0, 0, Math.round(w * r), Math.round(h * r));
  // the footer: a rule, then what it shows, where and when it is true, and who drew it
  ctx.scale(r, r);
  ctx.fillStyle = v('--panel', '#111623');
  ctx.fillRect(0, h, w, foot);
  ctx.fillStyle = v('--line', '#232C42');
  ctx.fillRect(0, h, w, 1);
  const hud = v('--hud', 'Futura, sans-serif'), mono = v('--mono', 'Menlo, monospace');
  lines.forEach((line, i) => {
    const y = h + FOOT_PAD + FOOT_LINE * i + 12;
    ctx.fillStyle = i === 0 ? v('--accent', '#5BC8DD') : i === 1 ? v('--ink', '#DCE4F5') : v('--muted', '#99A3BA');
    ctx.font = i === 0 ? '600 12px ' + hud : '11.5px ' + mono;
    ctx.fillText(i === 0 ? line.toUpperCase() : line, 16, y, w - 32);
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, w, h: h + foot, r };
}

// ── the files ───────────────────────────────────────────────────────────────

function blobOf(canvas, type, q) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error(t('export.why.tooBig')))), type, q));
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

/** The footer facts of this page now, for a surface and its title. */
function factsFor(surface, title) {
  return footerFacts({ meta: (S.GRAPH && S.GRAPH.meta) || {}, version: S.VERSION, lens: currentLens(), surface, title });
}

/**
 * Save a surface's view as a `png`, a `pdf` or (a table) a `csv`. Returns what
 * was made — the file name, the picture's size, the footer, how long it took —
 * and, with `{ dataUrl: true }`, the picture as a data URL instead of a
 * download (what the e2e spec reads). The Save control carries the same facts
 * in `data-export-file`, `data-export-footer`, `data-export-size` and
 * `data-export-ms` once it is done.
 * @group Export
 * @business Saves what this view shows as a picture, a PDF or a spreadsheet, with where and when it was true written under it.
 */
export async function saveView(surface, format, opts = {}) {
  const reg = PROVIDERS.get(surface);
  if (!reg) throw new Error(t('export.why.none'));
  const t0 = performance.now();
  const btn = document.querySelector('[data-export="' + surface + '"]');
  say(t('export.working'), true);
  try {
    const src = await reg.provider();
    if (!src) throw new Error(t('export.why.notDrawn'));
    const f = factsFor(surface, src.title);
    const lines = footerLines(f, t);
    const name = exportFilename({ surface, source: f.source, subject: src.subject, sync: f.sync, date: f.date, ext: format });
    let out = { file: name, footer: lines.join(' | ') };
    if (format === 'csv') {
      if (!reg.csv) throw new Error(t('export.why.notTable'));
      const tab = reg.csv();
      const text = toCsv(tab.header, tab.rows);
      out.rows = tab.rows.length;
      if (opts.dataUrl) out.dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
      else download(new Blob([text], { type: 'text/csv;charset=utf-8' }), name);
    } else {
      const pic = await drawPicture({ ...src, lines });
      out.width = pic.canvas.width; out.height = pic.canvas.height;
      if (format === 'pdf') {
        const jpeg = new Uint8Array(await (await blobOf(pic.canvas, 'image/jpeg', 0.92)).arrayBuffer());
        const bytes = pdfFromJpeg(jpeg, pic.canvas.width, pic.canvas.height, { page: pdfPage(pic.w, pic.h), title: lines[0], subject: lines[1] });
        out.bytes = bytes.length;
        if (opts.dataUrl) out.dataUrl = 'data:application/pdf;base64,' + btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''));
        else download(new Blob([bytes], { type: 'application/pdf' }), name);
      } else if (opts.dataUrl) out.dataUrl = pic.canvas.toDataURL('image/png');
      else download(await blobOf(pic.canvas, 'image/png'), name);
    }
    out.ms = Math.round(performance.now() - t0);
    if (btn) {
      btn.dataset.exportFile = name;
      btn.dataset.exportFooter = out.footer;
      btn.dataset.exportMs = String(out.ms);
      if (out.width) btn.dataset.exportSize = out.width + 'x' + out.height;
    }
    say(t('export.done').replace('{file}', name));
    return out;
  } catch (err) {
    say(t('export.failed').replace('{why}', String((err && err.message) || err)));
    throw err;
  }
}

/** A heading's own words: its first text, without the counts it carries in a span after them. */
function headWords(h) {
  if (!h) return '';
  const first = [...h.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  return cellWords(first ? first.textContent : h.textContent);
}

/**
 * A table's rows as the reader sees them, for its spreadsheet: one line per
 * body row, each cell's words on one line, and before them the headings the
 * table sits under (a persona around it, a group heading just before it) as
 * columns of their own.
 * @param {Element} root
 * @param {{table:string, sections:{label:string, around?:string, head?:string, before?:string}[]}} spec
 * @group Export
 */
export function tableRows(root, spec) {
  const header = [];
  const rows = [];
  for (const table of root.querySelectorAll(spec.table)) {
    const ctx = spec.sections.map((s) => {
      if (s.around) {
        const sec = table.closest(s.around);
        return headWords(sec && sec.querySelector(s.head || 'h2'));
      }
      let p = table.previousElementSibling;
      while (p && p.tagName !== 'TABLE' && !p.matches(s.before)) p = p.previousElementSibling;
      return p && p.tagName !== 'TABLE' ? headWords(p) : '';
    });
    if (!header.length) header.push(...spec.sections.map((s) => s.label), ...[...table.querySelectorAll('thead th')].map((th) => cellWords(th.innerText || th.textContent)));
    for (const tr of table.querySelectorAll('tbody tr')) rows.push([...ctx, ...[...tr.children].map((td) => cellWords(td.innerText || td.textContent))]);
  }
  return { header, rows };
}

expose({ farsightSave: saveView });
