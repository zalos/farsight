// The chrome's words (swarm-fixes round 2026-10-05, lane H): the read-only
// session, the keys that moved when `?` became the keymap's alone, and the
// Escape that asks before it closes a journey. Spread into STRINGS in
// strings.ts. Same rules as the rest of the catalog: both registers, a define
// on every word, defines in plain words; `sys.*` entries are register-invariant
// (they say what the session permits).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function sys(word: string): StringEntry {
  return { hud: word, professional: word, invariant: true };
}

export const CHROME_STRINGS: Record<string, StringEntry> = {
  // the READ-ONLY chip is drawn only when the server says the session is read-only
  'sys.readonly.flag': sys('This server was started read-only. Browsing changes nothing, and the server refuses every change: saving settings, adding or removing a source, a sync and a work-item write. Those controls stay on screen, greyed out.'),
  'sys.readonly.asOf': sys('This server shows a past sync, so it is read-only. Browsing changes nothing, and the server refuses every change: saving settings, adding or removing a source, a sync and a work-item write. Those controls stay on screen, greyed out.'),
  'sys.readonly.control': sys('This server is read-only, so this does nothing here: the server refuses the change. Ask whoever runs this server to make it, or start your own server without read-only.'),
  'sys.readonly.banner': sys('Read-only session — every change on this page is greyed out, because the server refuses it. The theme can still be previewed in this window.'),
  // keys
  'key.mapLegend': same('The board’s legend: what each line, colour and mark means'),
  // Esc on an open journey with nothing inside it open: one press says, a second closes
  'journey.escAgain': same('Esc again closes this journey', 'Nothing inside the journey was open, so the first Esc only says what a second one would do: close the journey and go back to the list.'),
};
