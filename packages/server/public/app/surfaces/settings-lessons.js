// surfaces/settings-lessons.js — Lessons for agents on the Settings page (round 2026-10-10, proposal 9).
//
// The owner's notes for every AI agent that opens this workspace: a pinned lesson is read at the start of every
// agent session (MCP resource farsight://context, graph_overview brief). Only a person writes one, here; no tool
// does. Each control is a write (`data-write`), so a read-only session greys them (lib/read-only.js), and the
// lessons are kept by *Save settings* with the rest of .farsight/settings.json. The server refuses a lesson
// shaped like a credential, and this page says so before it is sent.
import { S, esc, expose } from '../store.js';
import { t } from '../strings.js';
import { defAttrs } from '../lib/counted.js';
import { emptyHtml } from '../lib/empty-state.js';
import { applyReadOnly, readOnlyWhy } from '../lib/read-only.js';

/** The longest lesson, in characters — the server and the MCP context hold it to the same. */
const MAX = 400;
/** The shapes the server refuses (server index.ts lessonsProblem): a keychain or env reference, a header, a long token. */
const SECRET = /keychain:|\benv:[A-Z_]|\b(?:bearer|basic)\s+[A-Za-z0-9+/=._-]{12,}|[A-Za-z0-9+_=-]{32,}/i;

function lessons() {
  if (!S.SETTINGS) return [];
  if (!Array.isArray(S.SETTINGS.lessons)) S.SETTINGS.lessons = [];
  return S.SETTINGS.lessons;
}

/** The list as HTML: one row per lesson (pin · text · date · remove), the count, or the empty state. Pure over its input. */
export function lessonsHtml(list) {
  if (!list.length) return emptyHtml('lessons');
  const pinned = list.filter((l) => l.pinned).length;
  const countKey = list.length === 1 ? 'set.lessons.countOne' : 'set.lessons.count';
  return (
    '<p class="set-note les-count"' +
    defAttrs('set.lessons.count') +
    '>' +
    esc(t(countKey).replace('{n}', list.length).replace('{p}', pinned)) +
    '</p>' +
    '<ul class="les-list">' +
    list
      .map(
        (l, i) =>
          '<li class="les-row" data-i="' +
          i +
          '">' +
          '<label class="set-flag"><input type="checkbox" data-write ' +
          (l.pinned ? 'checked ' : '') +
          'onchange="lessonPin(' +
          i +
          ',this.checked)"/>' +
          '<span' +
          defAttrs('set.lessons.pin') +
          '>' +
          esc(t('set.lessons.pin')) +
          '</span></label>' +
          '<span class="les-text">' +
          esc(l.text) +
          '</span>' +
          (l.date ? '<span class="set-note les-date">' + esc(l.date) + '</span>' : '') +
          '<button class="x" data-write onclick="lessonRemove(' +
          i +
          ')" aria-label="' +
          esc(t('set.lessons.remove')) +
          '">✕</button></li>',
      )
      .join('') +
    '</ul>'
  );
}

/** Draw the section (called by renderSettings). */
export function renderLessons() {
  const title = document.getElementById('set-lessons-title');
  if (!title) return;
  title.textContent = t('set.lessons.title');
  title.setAttribute('data-tip-key', 'set.lessons.title');
  const sub = document.getElementById('set-lessons-sub');
  if (sub) sub.textContent = t('set.lessons.sub');
  const input = document.getElementById('lesson-text');
  if (input) {
    input.placeholder = t('set.lessons.placeholder');
    input.maxLength = MAX;
  }
  const add = document.getElementById('lesson-add');
  if (add) add.textContent = t('set.lessons.add');
  const rows = document.getElementById('lessonrows');
  if (rows) rows.innerHTML = lessonsHtml(lessons());
  applyReadOnly(document.getElementById('set-lessons') || document);
}

function lessonAdd() {
  if (readOnlyWhy()) return;
  const input = document.getElementById('lesson-text');
  const note = document.getElementById('lesson-note');
  const text = ((input && input.value) || '').trim().slice(0, MAX);
  if (!text) return;
  if (SECRET.test(text)) {
    if (note) {
      note.hidden = false;
      note.textContent = t('set.lessons.secret');
    }
    return;
  }
  if (note) {
    note.hidden = true;
    note.textContent = '';
  }
  lessons().push({ text, pinned: true, date: new Date().toISOString().slice(0, 10) });
  input.value = '';
  renderLessons();
}
function lessonPin(i, on) {
  if (readOnlyWhy()) return;
  const l = lessons()[i];
  if (l) l.pinned = !!on;
  renderLessons();
}
function lessonRemove(i) {
  if (readOnlyWhy()) return;
  lessons().splice(i, 1);
  renderLessons();
}

expose({ lessonAdd, lessonPin, lessonRemove });
