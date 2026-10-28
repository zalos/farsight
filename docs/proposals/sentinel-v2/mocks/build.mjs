#!/usr/bin/env node
/* global process, console */
// Builds the Sentinel v2 UX mocks: wraps each pages/*.html fragment in the shared Farsight chrome,
// writes out/<name>.html, and (unless --html-only) screenshots each at 1440x900 to <name>.png.
// Run from the workspace root so @playwright/test resolves: node docs/proposals/sentinel-v2/mocks/build.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });
const css = readFileSync(join(here, 'style.css'), 'utf8');

const NAV = ['Journeys', 'Map', 'Code map', 'APIs', 'Tests', 'Work', 'Changes', 'Sentinel'];
const LEVELS = ['Scans', 'Pipeline', 'Stage', 'Entry points', 'Path'];

function chrome(meta, body) {
  const nav = NAV.map((n) => `<a class="${n === 'Sentinel' ? 'on' : ''}">${n}</a>`).join('');
  const idx = LEVELS.indexOf(meta.level);
  const levels = LEVELS.map((l, i) => `<span class="${i === idx ? 'on' : i < idx ? 'done' : ''}">${l}</span>`).join('');
  const layout = (meta.layout ?? [])
    .map((l, i) => `<span class="${i === (meta.layoutOn ?? 0) ? 'on' : ''}">${l}</span>`)
    .join('');
  const register = ['Business', 'Hybrid', 'Code']
    .map((r) => `<span class="${r === (meta.register ?? 'Hybrid') ? 'on' : ''}">${r}</span>`)
    .join('');
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><title>${meta.title}</title><style>${css}</style></head><body>
<header class="top"><div class="mark">FAR<b>SIGHT</b></div><nav>${nav}</nav>
 <div class="right"><div class="seg ${meta.register === 'Business' ? 'amber' : 'cyan'}">${register}</div><span class="chip plain">sync 42 · 1ff7a25e</span><span class="chip">⚙ settings</span></div></header>
<div class="hud-row r1"><div class="levels">${levels}</div>
 ${layout ? `<span class="label" style="margin-left:14px">layout</span><div class="seg">${layout}</div>` : ''}
 <div class="tools">${(meta.tools ?? ['Compare', 'Save', '?']).map((t) => `<span class="btn ghost">${t}</span>`).join('')}</div></div>
<div class="hud-row r2"><div class="crumb">${meta.crumb}</div><div class="verdicts">${meta.verdicts ?? ''}</div></div>
<div class="body">${body}</div></body></html>`;
}

const pages = readdirSync(join(here, 'pages'))
  .filter((f) => f.endsWith('.html'))
  .sort();
const built = [];
for (const file of pages) {
  const raw = readFileSync(join(here, 'pages', file), 'utf8');
  const m = raw.match(/^<!--\s*(\{[\s\S]*?\})\s*-->/);
  if (!m) throw new Error(`${file}: missing leading JSON comment`);
  const meta = JSON.parse(m[1]);
  const html = chrome(meta, raw.slice(m[0].length));
  const target = join(out, basename(file));
  writeFileSync(target, html);
  built.push({ file: target, png: join(here, basename(file, '.html') + '.png') });
}
console.log(`built ${built.length} pages into ${out}`);

if (!process.argv.includes('--html-only')) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  for (const { file, png } of built) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('file://' + file);
    await page.waitForTimeout(150);
    await page.screenshot({ path: png });
    await page.close();
    console.log(`${basename(png)}${errors.length ? ` · ${errors.length} page errors: ${errors.join('; ')}` : ''}`);
  }
  await browser.close();
}
