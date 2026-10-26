// lib/empty-state.js — an empty surface says what it is for, why it is empty and what fills it
// (round 2026-10-10, proposal 9). One catalog key per surface (`empty.<surface>`, strings-agents.ts), both
// registers: the business register names the step a person asks for, hybrid and code name the command. The
// define is the tip. Drawn the same way on every surface so *nothing here* reads one way.
import { esc } from '../store.js';
import { t } from '../strings.js';
import { sym } from '../sym.js';
import { defAttrs } from './counted.js';

/** The empty state of one surface: work · tests · changes · apis · map · mapStorylines · lessons. */
export function emptyHtml(surface, tag = 'p') {
  const key = 'empty.' + surface;
  return (
    '<' +
    tag +
    ' class="set-note fs-empty" data-empty="' +
    esc(surface) +
    '"><span' +
    defAttrs(key) +
    '>' +
    sym('absent') +
    ' ' +
    esc(t(key)) +
    '</span></' +
    tag +
    '>'
  );
}
