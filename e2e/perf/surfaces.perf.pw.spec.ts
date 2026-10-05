// Every surface of the HUD on a synthetic workspace (scripts/synth-graph.mjs), measured the way a reader
// meets it: the shell boots once per surface on a cheap route (#/stewardship) — that boot is the /graph
// download, parse and index, its own row — then the surface's route is set and the clock runs until the
// surface's own ready selector is on screen (performance.now() in the page, polled once per frame, plus
// one frame to paint). One interaction per surface is timed the same way. Long tasks come from a
// PerformanceObserver installed before the page's own scripts; the JS heap from CDP Performance.getMetrics.
//
// The table is printed as markdown and written to e2e/perf/results.json. On the full preset a row over
// its budget (docs/proposals/round-2026-10-05.md §4) fails the run; on the small preset (CI) every surface
// must still draw, with no page error.
import { test, expect, type Page, type Browser, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRESET = process.env['FARSIGHT_PERF_PRESET'] || 'full';
const FULL = PRESET === 'full';
const here = dirname(fileURLToPath(import.meta.url));
/** A surface that has not drawn after this long is reported as not drawn, and its page is closed. */
const CAP_MS = Number(process.env['FARSIGHT_PERF_CAP_MS'] || 120_000);

type Row = {
  surface: string;
  /** null: did not draw within the cap · undefined: not measured for this row */
  firstDraw?: number | null;
  interaction: string;
  interactionMs?: number | null;
  longTasks: number;
  longTaskMs: number;
  longestTaskMs: number;
  heapMB: number | null;
  budgetDraw: number | null;
  budgetInteraction: number | null;
  /** fps rows: the interaction is a rate, judged ≥ budget */
  rate?: boolean;
  note?: string;
  errors: string[];
};
// the rows live in results.json as they are measured, so a failed surface (which restarts the worker) loses none
const RESULTS = join(here, 'results.json');
function readRows(): Row[] {
  try { return existsSync(RESULTS) ? (JSON.parse(readFileSync(RESULTS, 'utf8')).rows as Row[]) : []; } catch { return []; }
}
function writeRows(rows: Row[]) {
  writeFileSync(RESULTS, JSON.stringify({ preset: PRESET, at: new Date().toISOString(), rows }, null, 2));
}
const rows = { push: (...r: Row[]) => writeRows([...readRows(), ...r]) };

/** Installed before the viewer's own scripts: every long task the page has, with its start. */
function observeLongTasks() {
  (window as unknown as { __lt: { start: number; dur: number }[] }).__lt = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as unknown as { __lt: { start: number; dur: number }[] }).__lt.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no longtask support: the columns read 0 */ }
}

async function heapMB(page: Page): Promise<number | null> {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
    await cdp.send('Performance.enable');
    const m = await cdp.send('Performance.getMetrics');
    const used = m.metrics.find((x) => x.name === 'JSHeapUsedSize');
    return used ? Math.round(used.value / 1e6) : null;
  } catch { return null; }
}

/**
 * Run `act` in the page and time it until `ready` holds and one more frame has painted. Both are function
 * bodies evaluated in the page. Null when the page did not get there within the cap (the main thread may
 * be blocked, so the race is held outside the page).
 */
async function timed(page: Page, act: string, ready: string, cap = CAP_MS): Promise<{ ms: number | null; t0: number }> {
  const run = page.evaluate(async ({ act, ready, cap }) => {
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const ok = new Function(ready) as () => boolean;
    const t0 = performance.now();
    await (new Function(act) as () => unknown)();
    while (!ok()) {
      if (performance.now() - t0 > cap) return { ms: null, t0 };
      await frame();
    }
    await frame();
    return { ms: performance.now() - t0, t0 };
  }, { act, ready, cap });
  const timer = new Promise<{ ms: null; t0: number }>((r) => setTimeout(() => r({ ms: null, t0: -1 }), cap + 10_000));
  return Promise.race([run, timer]);
}

/** A promise, or the fallback once `ms` have passed (a page whose main thread is blocked answers nothing). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/**
 * Wait until the server answers at once — a surface that left requests queued (a page closed while the server
 * still folds what it asked) must not be billed to the next one. Returns the seconds waited.
 */
async function idle(request: APIRequestContext): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    const t = Date.now();
    const ok = await request.get('/api/version', { timeout: 60_000 }).then((r) => r.ok(), () => false);
    if (ok && Date.now() - t < 300) break;
  }
  return Math.round((Date.now() - t0) / 1000);
}

async function longTasksSince(page: Page, t0: number) {
  if (t0 < 0) return { n: 0, total: 0, max: 0 };
  return page.evaluate((t0) => {
    const lt = ((window as unknown as { __lt?: { start: number; dur: number }[] }).__lt || []).filter((x) => x.start >= t0);
    return { n: lt.length, total: Math.round(lt.reduce((s, x) => s + x.dur, 0)), max: Math.round(lt.reduce((m, x) => Math.max(m, x.dur), 0)) };
  }, t0).catch(() => ({ n: 0, total: 0, max: 0 }));
}

/** A fresh page, booted on the cheapest route; returns the page, the boot time and the errors it collects. */
async function boot(browser: Browser): Promise<{ page: Page; bootMs: number | null; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(observeLongTasks);
  // a returning reader: the map's legend does not open by itself
  await ctx.addInitScript(() => { try { localStorage.setItem('fs-map-legend-seen', '1'); } catch { /* no storage */ } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`http ${r.status()}: ${r.url()}`); });
  const t0 = Date.now();
  await page.goto('/#/stewardship');
  try {
    await page.waitForFunction(() => { const s = document.getElementById('stats'); return !!s && s.textContent !== 'loading…'; }, null, { timeout: 5 * 60_000, polling: 100 });
    return { page, bootMs: Date.now() - t0, errors };
  } catch { return { page, bootMs: null, errors }; }
}

type Surface = {
  name: string;
  route: string;
  ready: string;
  interaction: string;
  act: string;
  actReady: string;
  budgetDraw: number;
  budgetInteraction: number;
  /** run after the first draw instead of `act`, for a rate (fps) */
  rate?: (page: Page) => Promise<number | null>;
  /** extra facts measured after the interaction, for the note column */
  note?: (page: Page) => Promise<string>;
};

const go = (hash: string) => `location.hash = ${JSON.stringify(hash)};`;
const SURFACES: Surface[] = [
  {
    name: 'Journeys front door', route: '#/journeys',
    ready: `return !!document.querySelector('.jrn-org .jrn-persona');`,
    interaction: 'filter by a persona',
    act: go('#/journeys?persona=ops'),
    actReady: `return !!document.querySelector('.jrn-org-filter');`,
    budgetDraw: 2000, budgetInteraction: 200,
  },
  {
    name: 'Map board', route: '#/map',
    ready: `return document.querySelectorAll('.map-district').length > 0 && !document.querySelector('.map-note');`,
    interaction: 'open a street',
    act: `const id = window.S.GRAPH.nodes.find((n) => n.kind === 'flow' && n.id.includes('flow-9')).id; window.__flow = id; location.hash = '#/map/' + encodeURIComponent(id);`,
    actReady: `const id = window.__flow; const c = document.querySelector('.map-crumb'); const n = window.S.BYID[id];
      return !!(c && n && c.textContent.includes(n.name) && document.querySelector('.map-scr[data-flow="' + id + '"]'));`,
    budgetDraw: 3000, budgetInteraction: 500,
    rate: async (page) => page.evaluate(async () => {
      // pan and zoom: one ctrl-wheel (a pinch) per frame for 60 frames, half in, half out
      const board = document.querySelector('.map-board');
      if (!board) return null;
      const r = board.getBoundingClientRect();
      const frame = () => new Promise<number>((res) => requestAnimationFrame((t) => res(t)));
      const start = await frame();
      for (let i = 0; i < 60; i++) {
        board.dispatchEvent(new WheelEvent('wheel', { deltaY: i < 30 ? -40 : 40, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
        await frame();
      }
      const end = await frame();
      return Math.round((61 / (end - start)) * 1000);
    }),
    note: async (page) => {
      const all = await timed(page, '', `const d = document.querySelectorAll('.map-district'); return d.length > 0 && document.querySelectorAll('.map-district.loaded').length === d.length;`, 30_000);
      return all.ms === null ? 'not every journey read 30 s after the street opened' : `every journey read ${Math.round(all.ms)} ms after the street opened`;
    },
  },
  {
    name: 'Code map, grouped by project', route: '#/codemap?group=project',
    ready: `return !!document.querySelector('.cm-box');`,
    interaction: 'a filter (hide packages)',
    act: `document.getElementById('cm-hidepkg').click();`,
    actReady: `const b = document.getElementById('cm-hidepkg'); return !!(b && b.classList.contains('on'));`,
    budgetDraw: 4000, budgetInteraction: 500,
  },
  {
    name: 'Portfolio', route: '#/portfolio',
    ready: `return !!document.querySelector('.pf-table tbody tr');`,
    interaction: 'switch the lens',
    act: `window.setLens('business');`,
    actReady: `return document.body.classList.contains('lens-business') && !!document.querySelector('.pf-table tbody tr');`,
    budgetDraw: 3000, budgetInteraction: 500,
    note: async (page) => {
      const filled = await timed(page, '', `const b = document.getElementById('pf-body'); return !!b && !/reading…/.test(b.textContent);`, 30_000);
      return filled.ms === null ? 'rows still reading 30 s after the table drew' : `every row filled ${Math.round(filled.ms)} ms after the switch`;
    },
  },
  {
    name: 'APIs', route: '#/apis',
    ready: `return !!document.querySelector('.api-card');`,
    interaction: 'open an API',
    act: `document.querySelector('.api-card a.btn.primary').click();`,
    actReady: `return !!document.getElementById('api-body') && !!document.querySelector('.api-back');`,
    budgetDraw: 3000, budgetInteraction: 500,
  },
  {
    name: 'Tests', route: '#/tests',
    ready: `return !!document.querySelector('.tst-strip .counts') && !!document.querySelector('#tst-body table, #tst-body .tst-sec, #tst-body .tst-verdict');`,
    interaction: 'a level filter (unit)',
    act: `[...document.querySelectorAll('button')].find((b) => b.getAttribute('onclick') && /unit/.test(b.getAttribute('onclick')) && !b.classList.contains('on')).click();`,
    actReady: `return !!document.querySelector('.tst-strip .counts') && !/loading/i.test(document.getElementById('tst-body').textContent.slice(0, 40));`,
    budgetDraw: 3000, budgetInteraction: 500,
  },
  {
    name: 'Changes', route: '#/changes',
    ready: `const b = document.getElementById('ch-body'); return !!b && b.textContent.trim().length > 0 && !/reading…/.test(b.textContent);`,
    interaction: 'another repository',
    act: `document.querySelectorAll('.ch-repo')[1].click();`,
    actReady: `const on = document.querySelector('.ch-repo.on'); const b = document.getElementById('ch-body'); return !!on && on === document.querySelectorAll('.ch-repo')[1] && !!b && !/reading…/.test(b.textContent);`,
    budgetDraw: 3000, budgetInteraction: 500,
  },
  {
    name: 'Work', route: '#/work',
    ready: `return !!document.querySelector('#wk-body .wk-body, #wk-body .wk-table, #wk-body .wk-board, #wk-body .wk-err');`,
    interaction: 'the board view',
    act: `document.querySelectorAll('.wk-views button')[1].click();`,
    actReady: `const b = document.querySelectorAll('.wk-views button')[1]; return !!b && b.getAttribute('aria-pressed') === 'true' && !!document.querySelector('#wk-body .wk-body, #wk-body .wk-board, #wk-body .wk-err');`,
    budgetDraw: 3000, budgetInteraction: 500,
  },
];

/** True when a row is over one of its budgets. */
function over(r: Row) {
  const draw = r.budgetDraw !== null && r.firstDraw !== undefined && (r.firstDraw === null || r.firstDraw > r.budgetDraw);
  const act = r.budgetInteraction !== null && (r.interactionMs == null || (r.rate ? r.interactionMs < r.budgetInteraction : r.interactionMs > r.budgetInteraction));
  return draw || act;
}
function table(all: Row[]): string {
  const fmt = (n: number | null | undefined) => (n === undefined ? '—' : n === null ? 'did not draw' : String(Math.round(n)));
  const boot = all.find((r) => r.surface.startsWith('Boot'));
  return [
    `Preset **${PRESET}** — ${boot?.note ?? ''}`,
    '',
    '| surface | first draw ms (budget) | interaction | ms (budget) | long tasks · total ms · longest | JS heap MB | verdict |',
    '|---|---|---|---|---|---|---|',
    ...all.map((r) => `| ${r.surface} | ${fmt(r.firstDraw)}${r.budgetDraw !== null ? ` (≤ ${r.budgetDraw})` : ''} | ${r.interaction} | ${fmt(r.interactionMs)}${r.budgetInteraction !== null ? ` (${r.rate ? '≥' : '≤'} ${r.budgetInteraction}${r.rate ? ' fps' : ''})` : ''} | ${r.longTasks} · ${r.longTaskMs} · ${r.longestTaskMs} | ${r.heapMB ?? '—'} | ${r.budgetDraw === null && r.budgetInteraction === null ? 'measured' : over(r) ? '**over**' : 'ok'}${r.errors.length ? ` · ${r.errors.length} page errors` : ''}${r.note && r !== boot ? ` — ${r.note}` : ''} |`),
  ].join('\n');
}

test('boot: /graph download, parse and index', async ({ browser, request }) => {
  writeRows([]);
  const head = await request.get('/graph', { timeout: 5 * 60_000 });
  const bytes = (await head.body()).length;
  const { page, bootMs, errors } = await boot(browser);
  const lt = await longTasksSince(page, 0);
  const counts = await page.evaluate(() => ({ nodes: window.S.GRAPH.nodes.length, edges: window.S.GRAPH.edges.length }));
  rows.push({
    surface: 'Boot (/graph + index)', firstDraw: bootMs, interaction: '—', longTasks: lt.n, longTaskMs: lt.total, longestTaskMs: lt.max,
    heapMB: await heapMB(page), budgetDraw: null, budgetInteraction: null, errors,
    note: `${counts.nodes.toLocaleString('en')} nodes · ${counts.edges.toLocaleString('en')} edges · /graph ${(bytes / 1e6).toFixed(1)} MB`,
  });
  expect(bootMs, 'the shell booted').not.toBeNull();
  await page.context().close();
});

for (const s of SURFACES) {
  test(s.name, async ({ browser, request }) => {
    const waited = await idle(request);
    const { page, bootMs, errors } = await boot(browser);
    expect(bootMs, 'the shell booted').not.toBeNull();
    const draw = await timed(page, go(s.route), s.ready);
    let act: { ms: number | null; t0: number } = { ms: null, t0: -1 };
    let rate: number | null = null;
    if (draw.ms !== null) {
      if (s.rate) rate = await within(s.rate(page), 90_000, null);
      act = await timed(page, s.act, s.actReady);
    }
    const none = { n: 0, total: 0, max: 0 };
    const lt = draw.ms !== null ? await within(longTasksSince(page, draw.t0), 60_000, none) : none;
    const said = draw.ms !== null && act.ms !== null && s.note ? await within(s.note(page), 90_000, '') : '';
    const note = [said, waited > 2 ? `waited ${waited} s for the server to finish the last surface's requests` : ''].filter(Boolean).join('; ');
    const heap = draw.ms !== null ? await within(heapMB(page), 60_000, null) : null;
    rows.push({
      surface: s.name, firstDraw: draw.ms, interaction: s.interaction, interactionMs: act.ms, longTasks: lt.n, longTaskMs: lt.total, longestTaskMs: lt.max,
      heapMB: heap, budgetDraw: s.budgetDraw, budgetInteraction: s.budgetInteraction, errors, ...(note ? { note } : {}),
    });
    if (s.rate) {
      rows.push({ surface: s.name, interaction: 'pan and zoom (fps)', interactionMs: rate, longTasks: 0, longTaskMs: 0, longestTaskMs: 0, heapMB: null, budgetDraw: null, budgetInteraction: 30, rate: true, errors: [] });
    }
    await page.context().close().catch(() => {});
    expect(errors, 'page errors').toEqual([]);
    expect(draw.ms, `${s.name} drew`).not.toBeNull();
    expect(act.ms, `${s.name}: ${s.interaction}`).not.toBeNull();
  });
}

test('⌘K: a keystroke', async ({ browser, request }) => {
  await idle(request);
  const { page, bootMs, errors } = await boot(browser);
  expect(bootMs, 'the shell booted').not.toBeNull();
  await page.evaluate(() => window.openPalette());
  const t0 = await page.evaluate(() => performance.now());
  const word = 'invoice';
  const times: number[] = [];
  for (let i = 1; i <= word.length; i++) {
    const r = await timed(page, `const inp = document.getElementById('pinput'); inp.value = ${JSON.stringify(word.slice(0, i))}; inp.dispatchEvent(new Event('input', { bubbles: true }));`,
      'return true;');
    times.push(r.ms ?? CAP_MS);
  }
  const shown = await page.locator('.presult').count();
  const lt = await longTasksSince(page, t0);
  const sorted = [...times].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1]!;
  rows.push({
    surface: '⌘K', interaction: `a keystroke (max of ${word.length}; median ${Math.round(sorted[Math.floor(sorted.length / 2)]!)})`, interactionMs: max,
    longTasks: lt.n, longTaskMs: lt.total, longestTaskMs: lt.max, heapMB: await heapMB(page), budgetDraw: null, budgetInteraction: 50, errors,
  });
  await page.context().close();
  expect(errors, 'page errors').toEqual([]);
  expect(shown, 'the palette shows results').toBeGreaterThan(0);
});

// last: the table, and on the full preset every row within its budget
test('the table, and the budgets', async () => {
  const all = readRows();
  console.log('\n' + table(all) + '\n');
  expect(all.length, 'every surface left a row').toBeGreaterThanOrEqual(SURFACES.length + 2);
  if (FULL) expect(all.filter(over).map((r) => `${r.surface}: ${r.interaction}`), 'rows over their budget').toEqual([]);
});

declare global {
  interface Window {
    S: { GRAPH: { nodes: { id: string; kind: string; name: string }[]; edges: unknown[] }; BYID: Record<string, { name: string }> };
    openPalette: () => void;
    setLens: (l: string) => void;
    __flow?: string;
  }
}
