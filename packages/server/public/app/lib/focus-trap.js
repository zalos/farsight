// lib/focus-trap.js — focus containment for a dialog-shaped overlay.
//
// The journey overlay declares `role="dialog"` and covers the stage, but the
// page underneath stayed fully tabbable. Measured on the 2026-09-24 build: the
// overlay's ✕ was the **214th** tab stop and the business lane's tabs the
// **227th**, because Tab ran first through the chrome and then through every
// "Open journey" button and every ⧉ deep-link icon on the covered Journeys
// page — all of them invisible. A keyboard user could not reach the thing they
// had just opened.
//
// **What is covered, and what is not.** The overlay sits between the chrome and
// the status bar (`top: 84px; bottom: 30px`): the top bar — nav, search, the
// register switch, share, settings — the toolbar with the scope and the lens
// switch, and the status bar all stay on screen, and they are the controls a
// reader reaches for *while* reading a journey (flip the lens, narrow the
// scope, go to another surface). The first version of this module made the
// whole `.frame` inert, which took those controls away from the pointer as well
// as the keyboard: with a journey open, nothing in the header responded to a
// click (reported 2026-09-25). Only what the overlay actually covers is inert
// now — the stage, the inspector, the surface and the code map's note.
//
// So the overlay is a **non-modal** dialog: it does not declare `aria-modal`,
// because the page around it is live, visible and meant to be used.
//
// Two mechanisms, deliberately both:
//
//  1. `inert` on the covered layers. This is what actually removes the ~350
//     invisible stops — from the tab order, from the accessibility tree, and
//     from the pointer. It is the honest fix; a Tab handler alone would leave a
//     screen reader free to browse the covered page.
//  2. A Tab handler that recovers focus a redraw dropped. A register switch or
//     a fold rebuilds the dialog's content, the focused element goes with it
//     and focus falls to the body; the next Tab would start from the logo. It
//     goes back into the dialog instead. Tab does **not** wrap inside the
//     dialog: the only other live stops are the chrome's, so leaving the
//     dialog's last stop reaches the header, and Shift+Tab from its first
//     reaches the lens switch — which is how a keyboard reader gets to them.
//
// Overlays that open *over* the dialog (the ⌘K palette, the `?` keymap panel,
// the change-impact drawer, the context menu, the design lightbox, Settings,
// the Model Hub) are never made inert, so the controls that open them work.

/** The layers the journey overlay covers, and nothing else. The top bar, the
 *  toolbar and the status bar are deliberately absent: they are on screen
 *  around the overlay and must keep answering the pointer and the keyboard. */
export const BEHIND = ['.stage-wrap', '#inspector', '#surface', '.interim-note'];

/** The chrome that stays live around a trapped dialog — named so the test can
 *  hold the rule that none of it (or anything containing it) is ever in BEHIND. */
export const LIVE_CHROME = ['.topbar', '.toolbar', '.statusbar'];

/**
 * What a Tab should do while a dialog is trapped — the pure part of `trapTab`.
 *
 * `where` is where the focus is: `'dialog'` (inside it), `'dropped'` (the body,
 * nothing, or an element a redraw removed) or `'outside'` (live chrome, or an
 * overlay raised over the dialog). Returns `'first'` / `'last'` to move focus
 * into the dialog, or `null` to let the browser take the natural next stop.
 * Only dropped focus is moved: a reader in the header is somewhere they chose.
 */
export function tabAction(where, shift, hasStops) {
  if (where !== 'dropped') return null;
  if (!hasStops) return 'dialog';
  return shift ? 'last' : 'first';
}

let trapped = null;
let opener = null;
let openerKey = null;
let pendingKey = null;

/**
 * A key that survives a re-mount.
 *
 * Closing the journey navigates, and the router rebuilds `#surface` — so the
 * button the reader pressed to open the journey is a *different element* by the
 * time focus comes back to it. An id, or the `onclick` attribute (which on this
 * surface carries the entry id, so it identifies one button among several that
 * read "Open journey"), re-finds it; a tag and its words are the fallback.
 */
function keyOf(el) {
  if (!el || !el.tagName) return null;
  return {
    id: el.id || '',
    click: (el.getAttribute && el.getAttribute('onclick')) || '',
    tag: el.tagName,
    text: (el.textContent || '').trim().slice(0, 80),
  };
}

/** Find the element a key names again, after the surface it lived on was redrawn. */
function findByKey(k) {
  if (!k) return null;
  if (k.id) { const byId = document.getElementById(k.id); if (byId) return byId; }
  const all = [...document.querySelectorAll(k.tag.toLowerCase())];
  const visible = (n) => { const r = n.getBoundingClientRect(); return (r.width > 0 || r.height > 0) && !n.closest('[inert]'); };
  if (k.click) { const hit = all.find((n) => n.getAttribute('onclick') === k.click && visible(n)); if (hit) return hit; }
  return all.find((n) => (n.textContent || '').trim().slice(0, 80) === k.text && visible(n)) || null;
}

/** Everything inside `el` a Tab could land on, in document order. */
function focusables(el) {
  const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return [...el.querySelectorAll(sel)].filter((n) => {
    if (n.closest('[inert]')) return false;
    const r = n.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && getComputedStyle(n).visibility !== 'hidden';
  });
}

/**
 * Remember what is about to open a dialog, **before** the navigation that opens
 * it. Opening a journey goes through the hash, and the router empties `#surface`
 * on the way — so by the time the dialog calls `trapFocus`, the button the
 * reader pressed is already gone and `document.activeElement` is the body. The
 * caller that still holds it records it here.
 */
export function rememberOpener(el) { pendingKey = keyOf(el); }

/** True while `el` (or any dialog, with no argument) holds the focus. */
export function isTrapped(el) { return el ? trapped === el : !!trapped; }

/**
 * Contain focus in `el`: make the layers it covers inert (never the chrome
 * around it), remember what had focus, and move focus onto the dialog itself — so a screen reader announces
 * the dialog's name and its heading before the first control, and Tab starts
 * from the top of the dialog rather than the top of the page.
 */
export function trapFocus(el) {
  if (!el || trapped === el) return;
  releaseFocus();
  trapped = el;
  const active = document.activeElement;
  opener = active && active !== document.body && document.contains(active) ? active : null;
  openerKey = pendingKey || keyOf(opener);
  pendingKey = null;
  for (const sel of BEHIND) {
    document.querySelectorAll(sel).forEach((n) => {
      if (n === el || n.contains(el)) return;
      n.setAttribute('inert', '');
      n.dataset.fsInert = '1';
    });
  }
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  try { el.focus({ preventScroll: true }); } catch (err) { /* older engines: the inert layer is the part that matters */ }
}

/** Give the page back: drop `inert`, and put focus where it was before. */
export function releaseFocus() {
  if (!trapped) return;
  const dialog = trapped, back = opener, key = openerKey;
  trapped = null; opener = null; openerKey = null;
  document.querySelectorAll('[data-fs-inert]').forEach((n) => { n.removeAttribute('inert'); delete n.dataset.fsInert; });
  const put = (n) => { try { n.focus({ preventScroll: true }); return true; } catch (err) { return false; } };
  // focus still sitting on the dialog we just released is *not* the reader
  // moving on — at the moment Escape is handled that is exactly where it is
  const movedOn = (a) => !!a && a !== document.body && document.contains(a) && !(dialog && (a === dialog || dialog.contains(a)));
  // the chrome is live while a dialog is open, so the release can be caused by
  // a control there — a nav tab, a palette result. The reader has put the focus
  // where they want it; handing it back to the opener would snatch it away.
  if (movedOn(document.activeElement)) return;
  // focus still on the dialog we just hid: a hidden element keeps the focus until the
  // engine's next fixup, so a screen reader (and a test) would find it on a control that
  // is no longer on screen — let go of it now, the re-find below puts it back on the page
  const held = document.activeElement;
  if (held && held !== document.body && dialog && (held === dialog || dialog.contains(held))) { try { held.blur(); } catch (err) { /* nothing to let go of */ } }
  if (back && document.contains(back) && !back.closest('[inert]')) { put(back); return; }
  if (!key) return;
  // The control that opened the dialog is usually gone: closing navigates, and
  // the router empties `#surface` and re-mounts it — asynchronously, filling its
  // cards one at a time — so a frame-timer would find the *outgoing* element,
  // focus it, and watch it be discarded a task later. Watch the surface instead:
  // every time its subtree changes, look for the control again and put the focus
  // back on it, so Tab does not start over from the logo every time a journey
  // closes. Bounded, and it stops the moment the reader moves focus themselves.
  const host = document.getElementById('surface') || document.body;
  let obs = null;
  let timer = 0;
  const done = () => { if (obs) { obs.disconnect(); obs = null; } clearTimeout(timer); };
  const attempt = () => {
    const a = document.activeElement;
    const again = findByKey(key);
    if (movedOn(a) && a !== again) { done(); return; }
    if (again && a !== again) put(again);
  };
  timer = setTimeout(done, 2500);
  obs = new MutationObserver(attempt);
  obs.observe(host, { childList: true, subtree: true });
  requestAnimationFrame(attempt);
}

/**
 * Recover the focus a redraw dropped while a dialog is trapped. Returns true
 * when it has handled the key, so the central keymap can stop there.
 *
 * Focus inside the dialog, or in the live chrome around it, takes the browser's
 * natural next stop — `inert` has already removed the covered page from that
 * order. Focus that has fallen to the body, which a redraw does by removing the
 * focused element, comes back to the dialog's first stop (its last on Shift+Tab).
 */
export function trapTab(e) {
  if (!trapped || e.key !== 'Tab') return false;
  const active = document.activeElement;
  const where = trapped.contains(active) ? 'dialog'
    : (!active || active === document.body || active === document.documentElement || !document.contains(active)) ? 'dropped'
      : 'outside';
  const list = where === 'dropped' ? focusables(trapped) : [];
  const act = tabAction(where, e.shiftKey, list.length > 0);
  if (!act) return false;
  e.preventDefault();
  const target = act === 'first' ? list[0] : act === 'last' ? list[list.length - 1] : trapped;
  try { target.focus({ preventScroll: true }); } catch (err) { /* nothing focusable: the key is still spent */ }
  return true;
}
