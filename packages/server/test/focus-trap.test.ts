// An open journey must not take the header away.
//
// The journey overlay makes what it covers `inert`, so a keyboard reader does
// not walk ~350 invisible stops on the covered page. The first version listed
// the whole `.frame` — which holds the top bar, the toolbar and the status bar
// the overlay leaves on screen — so with a journey open nothing in the header
// answered a click (2026-09-25). These tests hold the shipped module and the
// shipped stylesheet together: what the overlay leaves visible stays live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');
const { BEHIND, LIVE_CHROME, tabAction } = await import(join(pub, 'app', 'lib', 'focus-trap.js'));
const html = readFileSync(join(pub, 'viewer.html'), 'utf8');

/** The declarations of one CSS rule in viewer.html, by its exact selector. */
function rule(sel: string): string {
  const m = new RegExp('(?:^|[\\s}])' + sel.replace(/[.#]/g, '\\$&') + '\\{([^}]*)\\}', 'm').exec(html);
  assert.ok(m, 'no rule for ' + sel);
  return m![1];
}
/** A numeric declaration (px or unitless) of one rule. */
const px = (decls: string, prop: string) => {
  const m = new RegExp('(?:^|;)' + prop + ':(-?\\d+)(?:px)?(?:;|$)').exec(decls);
  assert.ok(m, prop + ' not in ' + decls);
  return +m![1];
};

test('the chrome the overlay leaves on screen is never made inert', () => {
  assert.ok(!BEHIND.includes('.frame'), '.frame holds the header, the toolbar and the status bar');
  for (const c of LIVE_CHROME) assert.ok(!BEHIND.includes(c), c + ' must stay live');
  assert.deepEqual([...LIVE_CHROME].sort(), ['.statusbar', '.toolbar', '.topbar']);
});

test('the overlay really does leave that chrome uncovered', () => {
  // top bar + toolbar rows above the stage, the status bar row below it
  const rows = /grid-template-rows:(\d+)px (\d+)px 1fr (\d+)px/.exec(rule('.frame'));
  assert.ok(rows, 'frame rows');
  const journey = rule('.journey');
  assert.equal(px(journey, 'top'), +rows![1] + +rows![2], 'the journey starts below the top bar and the toolbar');
  assert.equal(px(journey, 'bottom'), +rows![3], 'the journey ends above the status bar');
  for (const c of LIVE_CHROME) assert.ok(html.includes('class="' + c.slice(1) + '"'), c + ' is in the page');
});

test('every covered layer names an element the page has', () => {
  for (const sel of BEHIND) {
    const found = sel.startsWith('#') ? html.includes('id="' + sel.slice(1) + '"') : new RegExp('class="[^"]*\\b' + sel.slice(1) + '\\b').test(html);
    assert.ok(found, sel + ' matches nothing in viewer.html');
  }
});

test('Settings and the Model Hub open above an open journey', () => {
  // their buttons are live beside the overlay, so what they open must not land under it
  const jz = px(rule('.journey'), 'z-index');
  assert.ok(px(rule('.settings'), 'z-index') > jz);
  assert.ok(px(rule('.modelhub'), 'z-index') > jz);
});

test('Tab moves only focus a redraw dropped; it never wraps a reader out of the chrome', () => {
  assert.equal(tabAction('dropped', false, true), 'first');
  assert.equal(tabAction('dropped', true, true), 'last');
  assert.equal(tabAction('dropped', false, false), 'dialog');
  // inside the dialog and in the live chrome, the browser's natural order holds —
  // leaving the dialog's last stop reaches the header, Shift+Tab from its first the lens switch
  for (const shift of [false, true]) {
    assert.equal(tabAction('dialog', shift, true), null);
    assert.equal(tabAction('outside', shift, true), null);
  }
});
