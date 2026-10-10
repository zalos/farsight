// surfaces/journey-drill.js — the ACTION DRILL: board 02 of
// the journey-timeline design reference  (02-action-drill.html) drawn from
// the same /api/journey summary the timeline and the sheet read. Behind the
// `journeyDrill` workspace flag (Settings → Experiments) — the third value of
// the journey's view axis (`?view=drill`, key `v`) once the flag is on.
//
// Three parts, top to bottom: the ACTION RAIL (every moment of every segment
// as arrowed stops, the screens spanning them), the LANES (rows = the layers
// of the system in request order, columns = the BEATS of the selected action
// in causal order — one box per beat, elbow wires from beat to beat, records /
// messages / third parties in the column of the part that reached them) and,
// on the right, the INSPECTOR (docs · request/response · code · forks · tests
// for the selected box). A beat is a marker of the drill tree at tier 0–1; a
// minor part (no drill of its own, reaches nothing, no authored label) folds
// into its parent's box as an *also* chip, and everything deeper opens one
// level at a time exactly as the rows and the sheet do (`▸ n inside`).
// Nothing here is hand-drawn: every box is a step of the walk, the answer
// column is the contract's own responses and says so. Untrusted → esc().

import { S, expose, esc, currentLens, humanize } from '../store.js';
import { t, def, plainWords, proseHtml } from '../strings.js';
import { sym } from '../sym.js';
import { vsl, linkHtml, designThumbHtml } from '../lib/graph-render.js';
import { doorsFor, doorsHtml } from '../lib/detail-doors.js';
import { gateAttrs } from '../lib/gate-card.js';
import {
  jrnCellFoldsHtml, jrnSeamCardHtml, jrnMarkerHtml, jrnMarkerText, jrnMarkerTitle, jrnScreenNode, jrnSegDecisions,
  jrnGateText, jrnGateLabel, jrnGatesShown, jrnBizTab, jrnBizTabsHtml, jrnExpBodyHtml, jrnContractHtml, jrnForkEntryHtml, jrnReqChips, jrnRefAnchors, jrnLabel, jrnChoiceHtml,
  jrnSchemaChipHtml, jrnFirstSentence, jrnSheetModel, jrnMarkerAt, jrnSelect, jrnSelectSegment, jrnScrollTo, jrnTxLineHtml,
  jrnTestsFootHtml, jrnStepTestFacts, jrnCountedHtml, jrnMoLabel, jrnDesignIdHtml, jrnUntranslatedHtml, jrnActionUntrList, jrnWords, jrnCallWords,
  jrnAbsentWord, jrnAbsentKindWord, jrnAbsentText, jrnAbsentHtml, jrnStepActionFacts, jrnStopText, jrnRowLabel as jrnRowLabelOf, jrnHelperTest as jrnHelperOf,
} from './journeys.js';
import { tipAttrs, tipSource } from '../lib/tooltip.js';
import { drillLayers, drillLayerOf, drillBeats } from '../lib/journey-model.js';
import { impactBodyHtml, impactCached, impactFetch, impactHasHops, impactOpts, impactRings, impactHash } from '../impact.js';

const JRN_DRILL_LANE = 172, JRN_DRILL_COL = 212, JRN_DRILL_SEAM_COL = 320, JRN_DRILL_STOP = 150, JRN_INSP_TESTS = 12;

// ── the flag ─────────────────────────────────────────────────────
/** Whether the drill view is switched on for this workspace (Settings → Experiments → journey drill).
 * @group Journey drill */
export function jrnDrillEnabled() {
  const f = S.SETTINGS && S.SETTINGS.flags;
  return !!(f && f.journeyDrill);
}

// ── the model ────────────────────────────────────────────────────
/** The actions of the journey: every moment of every segment, journey order — the stops of the rail.
 * @group Journey drill */
function jrnDrillActions(sum) {
  // the Sheet's columns, in the Sheet's order: stop n on the rail is column n on the
  // Sheet and `stop n of t` in the drawer — one position, one number
  return jrnSheetModel(sum).cols;
}
/** The rows of the lanes: the sheet's layers minus *verified by* (tests are an inspector tab here).
 * @group Journey drill */
function jrnDrillLayers(sum) {
  return drillLayers(sum, { t, rowLabel: jrnRowLabelOf, absentText: jrnAbsentText });
}
/** The word a beat wears in its column head, by the layer its marker sits in.
 * @group Journey drill */
function jrnBeatWord(layer) {
  // the business lens asks and answers; *seam* and *server* are a developer's words for the same places
  const biz = currentLens() === 'business';
  const server = biz ? 'journey.biz.beat.service' : 'journey.beat.server';
  if (!layer) return t(server);
  if (layer.kind === 'user') return t('journey.beat.screen');
  if (layer.kind === 'api') return t(biz ? 'journey.biz.beat.request' : 'journey.beat.seam');
  if (layer.kind === 'repo') return layer.side === 'ux' ? t('journey.beat.browser') : t(server);
  return t(server);
}
/** Which row a marker draws in: the user row for a component or page, else its system's row.
 * @group Journey drill */
function jrnDrillLayerOf(m, byKey) { return drillLayerOf(m, byKey, S.JOURNEY.steps); }
/**
 * The beats of one action, in causal order: the screen (when it stayed open
 * from an earlier action), then every marker of the drill tree at tier 0–1 in
 * step order — the action in the browser, the call across the seam, the
 * handler and the parts it calls. A part with no drill of its own, no record /
 * message / third party under it and no authored label is minor: it folds
 * into the beat before it as an *also* chip instead of taking a column. The
 * ANSWER beat — the contract's responses, tagged as from the spec — sits after
 * the last server-side beat, before the browser continues. Records, messages
 * and third parties land in the column of the part that reached them; gates
 * and translated decisions in the column of the step they sit on.
 * @group Journey drill
 * @business Splits one action into its beats — what the screen did, the call it made, what the service did in turn, what came back.
 */
function jrnDrillBeats(col, layers) {
  const { sg, mo } = col;
  // which gates and decisions this lens draws, and what it cannot name — the lane's control narrows them the way it
  // narrows the timeline's and the sheet's; the model only places what it is handed
  const business = currentLens() === 'business';
  const tab = jrnBizTab();
  const gs = jrnGatesShown((sg.gates || []).filter((g) => g.stepOrder >= mo.from && g.stepOrder <= mo.to));
  const all = jrnSegDecisions(sg).filter((d) => d.order >= mo.from && d.order <= mo.to);
  const shown = business ? all.filter((d) => d.cls !== 'guard') : all;
  const model = drillBeats(col, layers, {
    steps: S.JOURNEY.steps, parent: S.JRN_TREE ? S.JRN_TREE.parent : null, helper: jrnHelperOf(),
    gates: tab === 'decisions' ? [] : gs.drawn, decs: tab === 'gates' ? [] : shown,
  });
  const tree = model.tree;
  const cells = {};
  Object.keys(model.cells).forEach((k) => {
    cells[k] = model.cells[k].map((b) => (b.type === 'data' ? jrnDrillBoxHtml(b.m, layers[b.layer], tree)
      : b.type === 'part' ? jrnDrillBoxHtml(b.m, layers[b.layer], tree, b.also)
      : b.type === 'screen' ? jrnDrillScreenBoxHtml(b.comp, b.sg)
      : b.type === 'answer' ? jrnDrillAnswerBoxHtml(b.answer)
      : b.type === 'gate' ? jrnDrillGateBoxHtml(b.g, b.bi, b.k)
      : jrnDrillDecBoxHtml(b.d, b.bi, b.k)));
  });
  // one number in every lens: the technical conditions plus the gate conditions nobody labelled
  const untranslated = (mo.index === 0 ? (sg.untranslated || 0) : 0) + all.filter((d) => d.cls === 'guard').length;
  const notInWords = tab === 'decisions' ? 0 : gs.mute;
  return { beats: model.beats, colOf: model.colOf, cells, wires: model.wires, untranslated, notInWords, call: model.call, txCols: model.txCols, untrList: jrnActionUntrList(sg, mo) };
}

/** The words for a side of the transaction boundary, in the register the lens asks for.
 * @group Journey drill */
function jrnTxWord(side) {
  const biz = currentLens() === 'business';
  return t(jrnTxKey(side, biz));
}
/** The catalog key for a side, in the register the lens asks for.
 * @group Journey drill */
function jrnTxKey(side, biz) {
  const stem = side === 'inside' ? 'tx.inside' : side === 'after' ? 'tx.after' : 'tx.straddles';
  return (biz ? 'journey.biz.' : 'journey.') + stem;
}
/**
 * The transaction rail of one action: the side each **column** is written on
 * (every marker in it, folded ones included), and where that changes. A run of
 * columns wears the band; the word is printed where the side turns over, never
 * once per column — repeating it would read as a count of transactions, and the
 * flag records none (`journeyTransactions`). A column that holds both sides says
 * so, which is the sentence the reference app's submit needs.
 *
 * `null` = draw no rail: this action has nothing written inside a transaction
 * and the graph does record boundaries elsewhere, so silence is the honest
 * answer. `unknown` = the graph records none at all, and the rail says so in a
 * sentence instead of picking a side.
 * @group Journey drill
 */
function jrnDrillTxRail(model) {
  const known = !(S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.txKnown === false);
  const cells = model.txCols || model.beats.map(() => null);
  if (!known) return { unknown: true, cells: cells.map(() => null) };
  return cells.some(Boolean) ? { unknown: false, cells } : null;
}

/**
 * The transaction rail as a row of the lanes grid: the lane label, then one
 * cell per beat. A cell wearing the band is written inside a transaction; the
 * word is printed only where the side turns over, so a run of columns is never
 * a claim that they are the *same* transaction — the flag is per call site and
 * cannot say. When the graph records no boundary at all, the row is one
 * sentence saying exactly that instead of a side.
 * @group Journey drill
 * @business Shows which parts of this action the code saves together, and which it does separately afterwards.
 */
function jrnDrillTxRailHtml(model, cols) {
  const rail = jrnDrillTxRail(model);
  if (!rail) return '';
  const biz = currentLens() === 'business';
  // the lane's own words carry the define on hover rather than under the label: the rail is
  // one line of state, and a sentence here would make a tall band of mostly nothing
  let html = '<div class="jrn-dlh tx" title="' + esc(def(biz ? 'journey.biz.tx.lane' : 'journey.tx.lane')) + '">'
    + '<span class="hud-label">' + esc(t(biz ? 'journey.biz.tx.lane' : 'journey.tx.lane')) + '</span></div>';
  if (rail.unknown) {
    return html + '<div class="jrn-tx unknown" style="grid-column:span ' + cols + '">'
      + sym('absent') + esc(t(biz ? 'journey.biz.txFallback' : 'journey.drill.txFallback')) + '</div>';
  }
  let prev = null;
  rail.cells.forEach((side, bi) => {
    const turn = !!side && (side !== prev || side === 'straddles');
    const tip = side ? esc(def(jrnTxKey(side, biz))) : '';
    html += '<div class="jrn-tx ' + (side || 'na') + (turn ? ' turn' : '') + '" data-beat="' + bi + '" title="' + tip + '">'
      + (turn ? '<span class="w">' + esc(jrnTxWord(side)) + '</span>' : '') + '</div>';
    prev = side;
  });
  return html;
}

// ── boxes ────────────────────────────────────────────────────────
/** The verb a step's incoming edge reads as, for a box's kind line.
 * @group Journey drill */
function jrnDrillVia(s) {
  const map = { calls: 'journey.via.calls', renders: 'journey.via.renders', publishes: 'journey.via.publishes', consumes: 'journey.via.consumes', reads: 'journey.via.reads', writes: 'journey.via.writes', planned: 'journey.planned' };
  return map[s.via] ? t(map[s.via]) : '';
}
/** Colour class of a box by the row it sits in.
 * @group Journey drill */
function jrnDrillCls(layer) { return (layer && layer.cls) || 'srv'; }
/**
 * One box on a lane — a graph node with its ⧉ line: the kind line (kind · how
 * it was reached), the name (lens-aware, the same text the chips use), the
 * authored sentence when there is one, its *also* chips (minor parts folded
 * in) and its drill (`▸ n inside`). A call is the seam card with its schema
 * chip and the statuses the spec declares. Clicking selects the step.
 * @group Journey drill
 * @business One thing the system did in this beat, named the way the reader's lens asks for it.
 */
function jrnDrillBoxHtml(m, layer, tree, also) {
  const s = S.JOURNEY.steps[m.stepOrder] || {}, n = s.node || {};
  const lens = currentLens();
  const fold = jrnCellFoldsHtml(m, tree, null);
  const alsoHtml = also && also.length
    ? '<span class="also"><i>' + esc(t('journey.drill.also')) + '</i>' + also.map((x) => jrnMarkerHtml(x) + jrnCellFoldsHtml(x, tree, null)).join('') + '</span>' : '';
  if (m.kind === 'call') {
    const c = n.contract || {};
    const outs = (c.responses || []).map((r) => {
      const cls = /^2/.test(String(r.status)) ? ' ok' : /^4/.test(String(r.status)) ? ' warn' : '';
      return '<span class="api-chip st' + cls + '" title="' + esc(t('journey.fromSpec') + ' · ' + (r.description || '')) + '">' + esc(String(r.status)) + '</span>';
    }).join('');
    // the schema's identifiers and the status codes are the contract's code; the
    // business lens reads the call's words and what it answers, one beat later
    const outsHtml = lens === 'business' ? '' : jrnSchemaChipHtml(m) + outs;
    return '<div class="jrn-bx api" id="jrn-bx-' + m.stepOrder + '">' + jrnSeamCardHtml(m)
      + (outsHtml ? '<span class="outs">' + outsHtml + '</span>' : '') + alsoHtml + fold + '</div>';
  }
  const cls = jrnDrillCls(layer);
  const glyph = m.choice ? 'oneof'
    : m.kind === 'record' ? 'record' : m.kind === 'message' ? 'message' : m.kind === 'external' ? 'external'
    : (n.kind === 'component' || n.kind === 'page') ? 'screen' : 'step';
  // the kind line: the graph's kind and how the walk reached it — a developer's
  // reading (*component · rendered*, *function · called*). The business lens
  // says where the part is: on the screen, or a part of the system.
  const kindWord = m.kind === 'record' ? t('journey.kind.record') + (m.op ? ' · ' + t('journey.op.' + m.op) : '')
    : m.kind === 'message' ? t('journey.kind.message') : m.kind === 'external' ? t('journey.kind.external')
    : lens === 'business' ? t((n.kind === 'component' || n.kind === 'page') ? 'journey.biz.kind.onScreen' : 'journey.biz.kind.part')
    : (n.kind || t('journey.kind.step')) + (jrnDrillVia(s) ? ' · ' + jrnDrillVia(s) : '');
  const name = jrnMarkerText(m);
  // a run-time choice is the call, not one implementation: it borrows no candidate's
  // words and points at the line the call is written on (blocker 3)
  const label = (!m.choice && n.bizLabel && n.bizLabel !== n.name && lens !== 'business' && name.indexOf(n.bizLabel) < 0) ? n.bizLabel : '';
  // outside the code register the name IS the authored sentence, so the box does
  // not print it twice — the sentence stays where it is the only words there are
  const said = jrnWords(m.choice ? (m.title || '') : (jrnMarkerTitle(m) || m.business || jrnFirstSentence(n.bizDescription || n.docs || '')));
  const biz = said && said !== name ? said : '';
  const loc = m.choice ? (m.choice.at ? { path: m.choice.at.path, line: m.choice.at.line, repo: (m.choice.at.nodeId || '').split('::')[0] } : null)
    : (n.loc ? { path: n.loc.path, line: n.loc.line, repo: n.repo } : null);
  const title = [m.name || '', said && said !== m.name ? said : ''].filter(Boolean).join(' · ')
    + (m.planned ? ' · ' + t('journey.plannedNote') : '') + (m.repeat ? ' · ' + t('journey.repeated') : '');
  return '<div class="jrn-bx ' + cls + (m.planned ? ' planned' : '') + (m.repeat ? ' rep' : '') + '" id="jrn-bx-' + m.stepOrder + '" data-order="' + m.stepOrder + '" tabindex="0"'
    + ' onclick="jrnSelect(' + m.stepOrder + ')" title="' + esc(title) + '">'
    + '<span class="k">' + sym(glyph) + esc(kindWord) + (m.repeat ? '<span class="rep">↺</span>' : '') + '</span>'
    + '<span class="n">' + esc(name) + (loc ? '<span class="loc">' + esc(loc.path + ':' + loc.line) + vsl(loc.repo, loc.path, loc.line) + '</span>' : '') + '</span>'
    + (label ? '<span class="b">' + esc(label) + '</span>' : '')
    + (biz && biz !== label ? '<span class="b">' + esc(biz) + '</span>' : '')
    + (m.cut ? '<span class="b cut" title="' + esc(def('journey.cutPoints')) + '">▸ ' + esc(t('journey.notFollowed').replace('{n}', m.cut)) + '</span>' : '')
    + alsoHtml + fold + '</div>';
}
/** The screen that stayed open from an earlier action — its component, marked *still open*; clicking jumps to where it was drawn.
 * @group Journey drill */
function jrnDrillScreenBoxHtml(comp, sg) {
  const n = S.BYID[comp.id] || {};
  return '<div class="jrn-bx ui dim" id="jrn-bx-' + comp.stepOrder + '" tabindex="0" onclick="jrnScrollTo(' + comp.stepOrder + ')" title="' + esc(comp.name) + '">'
    + '<span class="k">' + sym('screen') + esc(currentLens() === 'business' ? t('journey.biz.kind.onScreen') : (n.kind || t('journey.kind.screen'))) + ' · ' + esc(t('journey.stillOpen')) + '</span>'
    + '<span class="n">' + esc(currentLens() === 'business' ? comp.label : comp.name) + (n.loc ? '<span class="loc">' + esc(n.loc.path + ':' + n.loc.line) + vsl(n.repo, n.loc.path, n.loc.line) + '</span>' : '') + '</span>'
    + (comp.label && comp.label !== comp.name && currentLens() !== 'business' ? '<span class="b">' + esc(comp.label) + '</span>' : '')
    + '</div>';
}
/**
 * The answer beat: what the contract says comes back — the 2xx schema as the
 * headline, every declared status as a chip — tagged as from the spec. No
 * payload was captured; an observed response would be labelled as such.
 * @group Journey drill
 * @business What the API promises to send back, as the contract declares it.
 */
function jrnDrillAnswerBoxHtml(a) {
  const c = a.contract;
  const biz = currentLens() === 'business';
  const ok = (c.responses || []).find((r) => /^2/.test(String(r.status)));
  const outs = (c.responses || []).map((r) => {
    const cls = /^2/.test(String(r.status)) ? ' ok' : /^4/.test(String(r.status)) ? ' warn' : '';
    return '<span class="api-chip st' + cls + '" title="' + esc(r.description || '') + '">' + esc(String(r.status)) + '</span>';
  }).join('');
  return '<div class="jrn-bx api ans" id="jrn-ans" tabindex="0" onclick="jrnDrillInspTab(\'req\',' + a.call.stepOrder + ')" title="' + esc(t('journey.drill.answerSub')) + '">'
    + '<span class="k">' + sym('api') + esc(t('journey.beat.answer')) + (biz ? '' : ' · ' + esc(t('journey.fromSpec'))) + '</span>'
    // business: what comes back in the contract's words — never the schema's identifier or the status code
    + '<span class="n">' + (ok ? (biz ? esc(plainWords(ok.description) || t('journey.biz.drill.answer')) : '<b>' + esc(String(ok.status)) + '</b> ' + esc(ok.schema || ok.description || '')) : esc(t('journey.absent.notBuilt'))) + '</span>'
    + (biz ? '' : '<span class="outs">' + outs + '</span>' + '<span class="b">' + esc(t('journey.drill.answerSub')) + '</span>') + '</div>';
}
/** A gate on the gates row: the checkpoint in words, how often this action met it, ⧉ into its code.
 * @group Journey drill */
function jrnDrillGateBoxHtml(g, bi, k) {
  const gn = S.BYID[g.id];
  // a click (or Enter) opens the gate card (swarm-fixes 2026-10-05, finding 4); a planned gate is not in the graph, so it walks to its step
  return '<div class="jrn-bx gate' + (g.planned ? ' planned' : '') + '" id="jrn-bg-' + bi + '-' + k + '"'
    + (gn ? gateAttrs(g.id, { step: g.stepOrder, config: g.config }) : ' tabindex="0" onclick="jrnScrollTo(' + g.stepOrder + ')"') + ' title="' + esc(g.name || '') + '">'
    + '<span class="k">' + sym(g.kind === 'rule' ? 'shield' : 'lock') + esc(g.kind === 'rule' ? t('journey.kind.rule') : t('journey.kind.gate')) + (g.count > 1 ? ' ×' + g.count : '') + '</span>'
    + '<span class="n">' + esc(jrnGateLabel(g)) + (gn && gn.loc ? '<span class="loc">' + esc(gn.loc.path + ':' + gn.loc.line) + vsl(gn.repo, gn.loc.path, gn.loc.line) + '</span>' : '') + '</span>'
    + (g.planned ? '<span class="b">' + esc(t('journey.plannedGate')) + '</span>' : '') + '</div>';
}
/** A translated decision on the gates row: the fork the flow can take here.
 * @group Journey drill */
function jrnDrillDecBoxHtml(d, bi, k) {
  return '<div class="jrn-bx gate dec" id="jrn-bd-' + bi + '-' + k + '" tabindex="0" onclick="jrnScrollTo(' + d.order + ')" title="' + esc(t('journey.decisionChip')) + '">'
    + '<span class="k">' + sym('fork') + esc(t('journey.kind.decision')) + '</span><span class="n">' + esc(d.label) + '</span></div>';
}

// ── the rail ─────────────────────────────────────────────────────
/**
 * The action rail: every action of the journey as a stop on one line — its
 * ordinal, a person glyph when a screen made the call or a system glyph when
 * nothing client-side did, ↺ when the walk already ran it — with the screens
 * spanning the stops they own (name, design id, thumbnail outside the code
 * lens). The selected stop is ringed; clicking one drills into it.
 * @group Journey drill
 * @business The whole journey as numbered stops, the screens above them — pick one to see its beats.
 */
function jrnDrillRailHtml(sum, cols) {
  let html = '<div class="jrn-rail-wrap"><div class="jrn-rail" style="grid-template-columns:repeat(' + cols.length + ',minmax(' + JRN_DRILL_STOP + 'px,1fr))">';
  let at = 0;
  sum.segments.forEach((sg) => {
    const span = (sg.moments || []).length;
    if (!span) return;
    const n = jrnScreenNode(sg);
    const name = (sg.screen && sg.screen.name) || (n && n.name) || t('journey.beforeFirstScreen');
    html += '<div class="jrn-rscr' + (sg.screen ? '' : ' entry') + '" style="grid-column:' + (at + 1) + ' / span ' + span + '" onclick="jrnSelectSegment(' + sg.index + ')">'
      + (n ? designThumbHtml(n, 'sheet') : '') + '<span class="t">' + jrnDesignIdHtml(sg) + esc(name) + '</span></div>';
    at += span;
  });
  html += cols.map((col) => {
    const mo = col.mo;
    return '<div class="jrn-stop' + (col.index === S.jrnAction ? ' on' : '') + (mo.component ? '' : ' auto') + (mo.repeat ? ' rep' : '') + '" data-col="' + col.index + '"'
      + ' onclick="jrnDrillGo(' + col.index + ')" title="' + esc(mo.business || mo.label) + '"><span class="dot"></span>'
      + '<span class="t"><span class="ord">' + (col.index + 1) + '</span>' + sym(mo.component ? 'human' : 'automation') + '<span class="n">' + esc(jrnMoLabel(mo)) + '</span>' + (mo.repeat ? '<span class="rep">↺</span>' : '') + '</span></div>';
  }).join('');
  return html + '</div></div>';
}
/**
 * One legend swatch: a line drawn with the **same class** the wire on the canvas
 * carries, so it takes the same dash pattern and the same hue from the same CSS
 * rule. The swatch cannot describe a wire the canvas does not draw, and a wire
 * cannot change shape without its swatch changing with it.
 * @group Journey drill
 */
function jrnWireSwatch(cls) {
  return '<svg class="lgsw" viewBox="0 0 30 7" aria-hidden="true"><line class="' + esc(cls) + '" x1="0.5" y1="3.5" x2="29.5" y2="3.5"/></svg>';
}
/** The caption under the rail: which action is open, its beats, and the legend of the wires.
 *
 * Every wire kind is told apart by its **line**, not its colour: the six kinds
 * used to be five solid lines in five hues, which a grayscale check reduced to
 * four identical greys. The hue is still there as the second channel.
 * @group Journey drill */
function jrnDrillCaptionHtml(cols, model) {
  const col = cols[S.jrnAction];
  const row = (cls, key) => '<span>' + jrnWireSwatch(cls) + esc(t(key)) + '</span>';
  const legend = '<span class="legend">' + row('', 'journey.drill.legend.call') + row('dash', 'journey.drill.legend.cond')
    + row('gate', 'journey.drill.legend.gates') + row('violet', 'journey.drill.legend.records')
    + row('q', 'journey.drill.legend.messages') + row('grey', 'journey.drill.legend.third')
    + '<span class="lgnote">' + esc(t('journey.drill.legend.shapes')) + '</span></span>';
  const biz = currentLens() === 'business';
  // `stop n of t on this journey`: t is the rail's stops — every moment, a second
  // visit a second stop — typed by the core as `counted.actionStops` (31 on the POC,
  // where the header's actions are 13), so the tip carries the split that reconciles them
  const stops = S.JOURNEY && S.JOURNEY.summary && S.JOURNEY.summary.counted && S.JOURNEY.summary.counted.actionStops;
  const of = esc(t('journey.drill.actionOf').replace('{n}', S.jrnAction + 1)).replace('{t}', () => (stops && stops.n === cols.length
    ? jrnCountedHtml(stops, { num: true, noFocus: true }) : String(cols.length)));
  // the beats of the open action — a developer's unit, said as *things happen* in the business lens
  const beatKey = biz ? 'journey.biz.countSteps' : 'journey.drill.countBeats';
  const beats = '<span class="jrn-num"' + tipAttrs({ number: { count: model.beats.length, of: beatKey, scope: 'count.scope.action', source: tipSource('/api/journey') }, noFocus: true }) + '>'
    + esc(t(beatKey).replace('{n}', model.beats.length)) + '</span>';
  return '<div class="jrn-dcap"><span>' + of + ' · ' + esc(jrnMoLabel(col.mo)) + ' · ' + esc(t(biz ? 'journey.biz.drill.order' : 'journey.drill.beats'))
    + '</span><span class="cnt">' + beats
    + (model.untranslated ? ' · ' + jrnUntranslatedHtml(model.untranslated, 'count.scope.action', null, model.untrList) : '') + '</span>' + legend + '</div>';
}

// ── the lanes ────────────────────────────────────────────────────
/**
 * The lanes of one action: a corner cell, one head per beat (ordinal · the
 * layer's word · the marker's name), then one row per layer — its label on the
 * left, one cell per beat holding that layer's boxes for the beat — and the
 * wires overlay on top. Column widths are fixed so nothing overlaps: a box is
 * as wide as its column and wraps inside it.
 * @group Journey drill
 * @business One action opened up: the layers of the system down the side, its beats across, an arrow from each to the next.
 */
function jrnDrillLanesHtml(cols, layers, model, col) {
  const beats = model.beats;
  const widths = beats.length ? beats.map((b) => (b.kind === 'seam' ? JRN_DRILL_SEAM_COL : JRN_DRILL_COL)) : [JRN_DRILL_COL];
  const style = 'grid-template-columns:' + JRN_DRILL_LANE + 'px ' + widths.map((w) => 'minmax(' + w + 'px,1fr)').join(' ') + ';min-width:' + (JRN_DRILL_LANE + widths.reduce((a, b) => a + b, 0)) + 'px';
  let html = '<div class="jrn-lanes" id="jrn-lanes" style="' + style + '"><div class="jrn-dbh corner"></div>';
  html += beats.map((b, bi) => {
    const word = b.kind === 'answer' ? t('journey.beat.answer') : jrnBeatWord(layers[b.layer]);
    const sub = b.kind === 'answer' ? (b.answer.contract.spec && b.answer.contract.spec.operationId) || '' : b.kind === 'screen' ? b.comp.name : jrnMarkerText(b.m);
    const at = b.kind === 'answer' ? b.answer.call.stepOrder : b.kind === 'screen' ? b.order : b.m.stepOrder;
    return '<div class="jrn-dbh" data-beat="' + bi + '" onclick="' + (b.kind === 'answer' ? 'jrnDrillInspTab(\'req\',' + at + ')' : 'jrnScrollTo(' + at + ')') + '">'
      + '<b><span class="ord">' + (bi + 1) + '</span>' + esc(word) + '</b><span class="s">' + esc(sub) + '</span></div>';
  }).join('');
  if (!beats.length) html += '<div class="jrn-dbh"><b>' + esc(t('journey.absent.noneIndexed')) + '</b></div>';
  html += jrnDrillTxRailHtml(model, Math.max(1, beats.length));
  layers.forEach((layer, li) => {
    // the checks lane carries the same control the timeline's lane and the
    // sheet's lane carry, in the same state, plus what this register could not word
    const ctl = layer.kind === 'gates'
      ? jrnBizTabsHtml(S.JOURNEY.summary)
        + (model.notInWords ? '<span class="jrn-gl-mute">' + sym('warning') + esc(t('journey.biz.notInWords').replace('{n}', model.notInWords)) + '</span>' : '')
      : '';
    // a lane this action leaves empty says so in the core's word for the cell — the
    // word the rows, the sheet and the storyboard print for the same (action, layer)
    const empty = col && layer.kind !== 'gates' && !layer.absent
      && !Object.keys(model.cells).some((k) => k.split(':')[0] === String(li) && (model.cells[k] || []).length);
    const word = !empty ? ''
      : layer.kind === 'user' ? ((col.sg.absent && col.sg.absent.moments[col.mo.index]) || {}).user || ''
      : layer.row ? jrnAbsentWord(col.sg, col.mo, layer.key) : jrnAbsentKindWord(col.sg, col.mo, layer.kind);
    html += '<div class="jrn-dlh ' + esc(layer.cls || '') + '"' + (layer.absent ? ' data-absent="' + esc(layer.word) + '"' : '') + '><span class="hud-label">' + esc(layer.label) + '</span>' + (layer.sub ? '<span class="sub">' + esc(layer.sub) + '</span>' : '')
      + (word ? '<span class="sub" data-sys="' + esc(layer.key) + '">' + jrnAbsentHtml(word) + '</span>' : '') + ctl + '</div>';
    for (let bi = 0; bi < Math.max(1, beats.length); bi++) {
      const list = model.cells[li + ':' + bi] || [];
      html += '<div class="jrn-dcell" data-layer="' + li + '" data-beat="' + bi + '">' + list.join('') + '</div>';
    }
  });
  return html + '<svg class="jrn-wires" aria-hidden="true"></svg></div>';
}
/**
 * Draw the wires after layout: an elbow from a box's right edge, down or up the
 * gutter between the columns, into the next box's left edge — or straight
 * down a column from a part to the record it wrote. Measured from the DOM, so
 * a fold that opens or a pane that resizes redraws them (ResizeObserver).
 * @group Journey drill
 */
function jrnDrillWires() {
  const host = document.getElementById('jrn-lanes');
  const svg = host && host.querySelector('svg.jrn-wires');
  if (!svg) return;
  const hb = host.getBoundingClientRect();
  svg.setAttribute('width', host.scrollWidth); svg.setAttribute('height', host.scrollHeight);
  let out = '';
  (S.JRN_WIRES || []).forEach((w) => {
    const A = document.getElementById(w.a), B = document.getElementById(w.b);
    if (!A || !B) return;
    const ra = A.getBoundingClientRect(), rb = B.getBoundingClientRect();
    const ax = ra.left - hb.left, ay = ra.top - hb.top, bx = rb.left - hb.left, by = rb.top - hb.top;
    let d, ex, ey, dir;
    if (rb.left >= ra.left + ra.width - 2) {
      // to the right: out the right edge, along the gutter, into the left edge
      const y1 = ay + ra.height / 2, y2 = by + rb.height / 2, mx = ax + ra.width + Math.max(8, (bx - ax - ra.width) / 2);
      d = 'M' + (ax + ra.width) + ',' + y1 + ' H' + mx + ' V' + y2 + ' H' + bx; ex = bx; ey = y2; dir = 'r';
    } else if (Math.abs(rb.left - ra.left) < 4 && rb.top > ra.top) {
      // the same column, below: straight down
      const x = ax + Math.min(ra.width, rb.width) / 2;
      d = 'M' + x + ',' + (ay + ra.height) + ' V' + by; ex = x; ey = by; dir = 'd';
    } else {
      // back to the left (a repeat, a continuation): out the left edge, along the gutter, into the right edge
      const y1 = ay + ra.height / 2, y2 = by + rb.height / 2, mx = ax - Math.max(8, (ax - bx - rb.width) / 2);
      d = 'M' + ax + ',' + y1 + ' H' + mx + ' V' + y2 + ' H' + (bx + rb.width); ex = bx + rb.width; ey = y2; dir = 'l';
    }
    const tri = dir === 'r' ? ex + ',' + ey + ' ' + (ex - 6) + ',' + (ey - 3.5) + ' ' + (ex - 6) + ',' + (ey + 3.5)
      : dir === 'l' ? ex + ',' + ey + ' ' + (ex + 6) + ',' + (ey - 3.5) + ' ' + (ex + 6) + ',' + (ey + 3.5)
      : ex + ',' + ey + ' ' + (ex - 3.5) + ',' + (ey - 6) + ' ' + (ex + 3.5) + ',' + (ey - 6);
    out += '<path class="' + esc(w.cls || '') + '" d="' + d + '"/><polygon class="arrow ' + esc(w.cls || '') + '" points="' + tri + '"/>';
  });
  svg.innerHTML = out;
}

// ── the inspector ────────────────────────────────────────────────
/** The tabs the selected step can answer for: docs, request/response (calls only), code (outside the business lens), forks, tests.
 * @group Journey drill */
function jrnInspTabs(i) {
  const mk = i >= 0 ? jrnMarkerAt(i) : null;
  const tabs = ['docs'];
  if (mk && mk.kind === 'call') tabs.push('req');
  if (currentLens() !== 'business') tabs.push('code');
  tabs.push('forks', 'tests');
  // IMPACT is last and appears only once an answer has come back with
  // something in it: a tab that opens on "nothing uses this" teaches a reader
  // to stop opening it, and an empty tab is not an honest absence — the step
  // that has no dependents simply has no tab (B5.4).
  if (impactHasHops(jrnStepNodeId(i))) tabs.push('impact');
  return tabs;
}
/** The graph node a step stands on — the seed of its impact answer.
 * @group Journey drill */
function jrnStepNodeId(i) {
  const s = i >= 0 && S.JOURNEY ? S.JOURNEY.steps[i] : null;
  return (s && s.node && s.node.id) || null;
}
/**
 * Ask what uses the selected step, once per step and budget, and redraw the
 * panel when the answer lands — it may add the tab. The rings on the sheet come
 * from the same answer, so opening a step rings what uses it wherever the
 * journey is drawn.
 * @group Journey drill
 */
function jrnInspImpactAsk(i) {
  const id = jrnStepNodeId(i);
  if (!id || impactCached(id)) return;
  // walking with j/k redraws the panel on every step; the question is asked
  // once the reader stops on one, not once per keystroke
  clearTimeout(S.jrnImpactTimer);
  S.jrnImpactTimer = setTimeout(() => {
    if (jrnStepNodeId(S.journeyActive) !== id) return;
    impactFetch(id, impactOpts(), (e) => {
      if (jrnStepNodeId(S.journeyActive) !== id) return;
      if (S.jrnInspTab === 'impact') impactRings(e);
      jrnInspRedraw();
    });
  }, 250);
}
/** Redraw the inspector wherever it is open — the drill's panel or the code pane.
 * @group Journey drill */
function jrnInspRedraw() {
  if (S.JRN_DRILL) jrnDrillInspect(S.journeyActive);
  else jrnSelect(S.journeyActive, true);
}
/**
 * The IMPACT tab: what uses this step, by distance, from `/api/impact`. The
 * same body the drawer draws, so the two cannot word one fold differently; in
 * the business register it is the sentence and the journeys, and nothing else.
 * @group Journey drill
 * @business What else uses this — and what would catch a change to it.
 */
function jrnInspImpactHtml(i) {
  const id = jrnStepNodeId(i);
  const entry = id ? impactCached(id) : null;
  if (entry && entry.state === 'ok') { impactRings(entry); if (id) impactHash(id); }
  return '<div class="jrn-impact">' + impactBodyHtml(entry, jrnInspRedraw) + '</div>';
}
/**
 * Which tab to open for step i: the one the reader chose when it applies, else
 * **DOCS** — what the people who wrote this said it is for, before the code
 * that implements it. Only the code register opens on the code, where the
 * source is the thing being read (B4.1). A call no longer opens straight into
 * its contract: the contract is one tab away and the authored sentence is not.
 * @group Journey drill
 */
export function jrnInspTabFor(i) {
  const tabs = jrnInspTabs(i);
  if (S.jrnInspTab && tabs.includes(S.jrnInspTab)) return S.jrnInspTab;
  if (currentLens() === 'code' && tabs.includes('code')) return 'code';
  return 'docs';
}
/**
 * Switch the panel's tab (and select a step first when one is named — the
 * answer box opens its call's contract). The same panel is drawn in the
 * drill's inspector and in the timeline's code pane, so the redraw goes
 * wherever it is open.
 * @group Journey drill
 */
function jrnDrillInspTab(tab, i) {
  S.jrnInspTab = tab;
  if (i != null && i >= 0 && i !== S.journeyActive) { jrnSelect(i); return; }
  if (S.JRN_DRILL) jrnDrillInspect(S.journeyActive);
  else jrnSelect(S.journeyActive, true);
}
/** Open the tests list of the open step, wherever the panel lives (key `t`).
 * @group Journey drill */
export function jrnOpenTests() {
  if (!S.JOURNEY || S.journeyActive == null || S.journeyActive < 0) return;
  jrnDrillInspTab('tests');
}
/**
 * Open the impact answer for the step that is open (key `b` inside a journey —
 * the same key that opens the drawer from a card, because it asks the same
 * question). With nothing selected, or with a step nothing uses, the drawer
 * answers instead, so `b` is never a key that does nothing.
 * @group Journey drill
 */
export function jrnOpenImpact() {
  const id = S.JOURNEY ? jrnStepNodeId(S.journeyActive) : null;
  if (!id) { window.openImpact(null); return; }
  if (!impactHasHops(id)) { window.openImpact(id); return; }
  jrnDrillInspTab('impact');
}
/** The head of the inspector: the beat's word and ordinal, the step's name (method + operationId for a call), its ⧉ line.
 * @group Journey drill */
function jrnInspHeadHtml(i, mk) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const c = n.contract || {};
  const drill = !!(S.JRN_DRILL && S.JRN_DRILL.colOf);
  const bi = drill ? S.JRN_DRILL.colOf[i] : null;
  const layer = drill && mk ? S.JRN_DRILL.layers[jrnDrillLayerOf(mk, S.JRN_DRILL.byKey)] : null;
  // outside the drill there are no beats and no lanes, so the head says what
  // the timeline's own head always said: which step of the walk this is
  // outside the drill there are no beats: the timeline's head says which step of
  // the walk this is — a developer's unit, so the business lens says where it is instead
  const bizWhere = () => (mk && mk.kind === 'call' ? jrnBeatWord({ kind: 'api' })
    : (n.kind === 'component' || n.kind === 'page') ? t('journey.beat.screen') : jrnBeatWord(null));
  // outside the drill the head names the stop the part sits in — the Sheet's column,
  // the drill's rail — and what kind of part it is; never the walk's own index
  // (`STEP 232`), which no other surface prints (swarm 2026-10-05, finding 3)
  const kindWord = mk && mk.kind && S.STRINGS && S.STRINGS['journey.kind.' + mk.kind] ? t('journey.kind.' + mk.kind) : t('journey.kind.step');
  const stopWords = jrnStopText(i);
  const word = !drill ? (currentLens() === 'business' ? bizWhere() : (stopWords ? stopWords + ' · ' : '') + kindWord)
    : mk && mk.kind === 'call' ? jrnBeatWord({ kind: 'api' }) : jrnBeatWord(layer);
  // the same words the chip that opened this panel carries — the core's `title`
  // first, so the head and the marker cannot name one step two ways
  const lens = currentLens();
  const biz = lens === 'business';
  const name = lens === 'code' ? (n.name || '')
    : biz ? (mk && mk.kind === 'call' ? jrnCallWords(mk, n) : plainWords(mk && jrnMarkerTitle(mk)) || plainWords(n.bizLabel) || humanize(String(n.name || '')))
    : (mk && mk.kind === 'call' ? ((c.spec && c.spec.operationId) || n.bizLabel || n.name || '')
      : ((mk && jrnMarkerTitle(mk)) || n.bizLabel || jrnLabel(n)));
  // hybrid keeps both names; business keeps one, and not the code's
  return '<div class="sel"><span class="hud-label">' + esc(word) + (bi != null && !biz ? ' · ' + esc(t('journey.insp.beat').replace('{n}', bi + 1)) : '') + '</span>'
    + '<div class="nm">' + (mk && mk.method && !biz ? '<b>' + esc(mk.method) + '</b>' : '') + esc(name) + (n.name && n.name !== name && lens === 'hybrid' ? '<span class="jrn-code-name">' + esc(n.name) + '</span>' : '') + '</div>'
    + (n.loc && !biz ? '<div class="loc">' + esc(n.loc.path + ':' + n.loc.line) + vsl(n.repo, n.loc.path, n.loc.line) + (n.repo ? ' · ' + esc(n.repo) : '') + '</div>' : '')
    + (c.spec && c.spec.path && !biz ? '<div class="loc">' + esc(c.spec.path + (c.spec.line ? ':' + c.spec.line : '')) + vsl(n.repo, c.spec.path, c.spec.line || 1) + ' · ' + esc(t('journey.contractHead')) + '</div>' : '')
    // every detail is a door (round 2026-10-05 §3.2): where this part is read in full
    + jrnInspDoorsHtml(mk, n)
    + jrnTxLineHtml(mk)
    // what proves this step runs, in the head where the reader already is: the
    // same foot the screen cards and the Verified-by cells draw (B4.2)
    + jrnTestsFootHtml(jrnStepTestFacts(i), { absent: 'journey.insp.noTestStep', tab: true, impact: jrnStepNodeId(i), wider: jrnStepActionFacts(i), cases: jrnStepNodeId(i) ? { node: jrnStepNodeId(i) } : null })
    + '</div>';
}
/**
 * The doors of the open marker, from the one builder the Map uses
 * (lib/detail-links.js): a call reads its contract, its spec line and its
 * handler; a record its card and schema; anything else its code and its card.
 * @group Journey drill
 * @business Where to read this part in full — its contract, or the page it is described on.
 */
function jrnInspDoorsHtml(mk, n) {
  const node = (n && n.id && S.BYID[n.id]) || n;
  if (!node || !node.id) return '';
  const kind = mk && mk.kind === 'call' ? 'call' : mk && (mk.kind === 'record' || mk.kind === 'message' || mk.kind === 'external') ? mk.kind : node.kind;
  const entry = (S.JOURNEY && S.JOURNEY.entry) || {};
  const doors = doorsHtml(doorsFor(kind, node, { handler: (mk && mk.handler) || null, flow: entry.kind === 'flow' ? entry.id : null }));
  return doors ? '<div class="dd-exp jrn-insp-doors" tabindex="0" data-doors>' + doors + '</div>' : '';
}
/** DOCS: the authored description, the links it carries, the gates on this step, the conditions needed to reach it.
 * @group Journey drill
 * @business What the people who wrote this step said it is for, and what must be true to get here. */
function jrnInspDocsHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const c = n.contract || {};
  const mk = jrnMarkerAt(i);
  // one call, several implementations: the candidates come first — one implementation's
  // description must not open the panel as though it were the step's own
  const oneof = mk && mk.choice ? jrnChoiceHtml(mk.choice) : '';
  const text = oneof ? '' : jrnWords(n.bizDescription || n.docs || c.description || c.summary || '');
  const refs = jrnRefAnchors(n);
  let html = oneof || (text ? '<p>' + proseHtml(text) + '</p>' : '<p class="note">' + esc(t('journey.insp.noDocs')) + '</p>');
  if (refs.length) html += '<div class="jrn-refs">' + refs.join(' ') + '</div>';
  // the same words and the same drawn set as the lanes: a checkpoint this
  // register cannot name is counted here, not printed as its identifier
  const gs = jrnGatesShown(s.gates || []);
  if (gs.rows.length) html += '<h4>' + esc(t('journey.insp.gatesHere')) + '</h4><div class="list">' + gs.drawn.map((g) => {
    const gn = S.BYID[g.id];
    return '<div class="r"' + (S.BYID[g.id] ? gateAttrs(g.id, { step: s.order, config: g.config }) : '') + '>' + sym(g.kind === 'rule' ? 'shield' : 'lock') + '<b>' + esc(jrnGateLabel(g)) + '</b>' + (g.planned ? '<span class="api-chip stub">' + esc(t('journey.plannedGate')) + '</span>' : '') + (gn && gn.loc ? vsl(gn.repo, gn.loc.path, gn.loc.line) : '') + '</div>';
  }).join('') + (gs.mute ? '<div class="r note">' + sym('warning') + esc(t('journey.biz.notInWords').replace('{n}', gs.mute)) + '</div>' : '') + '</div>';
  const req = jrnReqChips(i);
  if (req) html += '<h4>' + esc(t('journey.insp.toGetHere')) + '</h4><div class="list">' + req + '</div>';
  const meta = [n.kind, n.group, s.via ? jrnDrillVia(s) : ''].filter(Boolean).join(' · ');
  if (meta && currentLens() !== 'business') html += '<p class="note mono">' + esc(meta) + '</p>';
  return html;
}
/**
 * REQUEST / RESPONSE: the contract block, the parameters, the request body as
 * a small tree (schema, then its fields when the spec names them), every
 * response as a status chip with its description and schema, what it
 * requires — and the honest note that this is the expected shape from the
 * spec, not a captured payload.
 * @group Journey drill
 * @business The promise an API call makes: what it needs, what it sends back, and which answers it can give.
 */
function jrnInspReqHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const c = n.contract;
  if (!c) return '<p class="note">' + esc(t('journey.insp.noContract')) + '</p>';
  // the business lens reads the promise in words: what the call does, and each
  // answer it can give as its description — never the schema, the parameters or
  // the status codes, which are the contract's code
  if (currentLens() === 'business') {
    const what = plainWords(c.description || c.summary || '');
    const answers = (c.responses || []).map((r) => plainWords(r.description || '')).filter(Boolean);
    return (what ? '<p>' + esc(what) + '</p>' : '<p class="note">' + esc(t('journey.biz.noWords')) + '</p>')
      + (answers.length ? '<h4>' + esc(t('journey.insp.responses')) + '</h4><div class="list">' + answers.map((a) => '<div class="r"><span>' + esc(a) + '</span></div>').join('') + '</div>' : '')
      + '<p class="note">' + esc(t('journey.insp.specNote')) + '</p>';
  }
  let html = jrnContractHtml(n);
  const rb = c.requestBody;
  if ((c.params || []).length) html += '<h4>' + esc(t('journey.insp.params')) + '</h4><div class="tree">' + c.params.map((p) =>
    '<div class="f"><span class="tw">├</span><span class="nm">' + esc(p.name || '') + '</span><span class="ty">' + esc(p.in || '') + (p.schema ? ' · ' + esc(p.schema) : '') + '</span>' + (p.required ? '<span class="req">req</span>' : '') + (p.description ? '<span class="ds">' + proseHtml(p.description) + '</span>' : '') + '</div>').join('') + '</div>';
  if (rb) html += '<h4>' + esc(t('journey.insp.request')) + '</h4><div class="tree"><div class="f"><span class="obj">' + esc(rb.schema || rb.contentType || '') + '</span>' + (rb.required ? '<span class="req">' + esc(t('journey.insp.required')) + '</span>' : '') + (rb.contentType && rb.schema ? '<span class="ds">' + esc(rb.contentType) + '</span>' : '') + '</div>'
    + (rb.fields || []).map((f, k, arr) => '<div class="f" style="--d:1"><span class="tw">' + (k === arr.length - 1 ? '└' : '├') + '</span><span class="nm">' + esc(f) + '</span></div>').join('') + '</div>';
  const rs = c.responses || [];
  if (rs.length) html += '<h4>' + esc(t('journey.insp.responses')) + '</h4><div class="list">' + rs.map((r) => {
    const cls = /^2/.test(String(r.status)) ? ' ok' : /^4|^5/.test(String(r.status)) ? ' warn' : '';
    return '<div class="r"><span class="api-chip st' + cls + '">' + esc(String(r.status)) + '</span>' + (r.schema ? '<b class="mono">' + esc(r.schema) + '</b>' : '') + (r.description ? '<span>' + proseHtml(r.description) + '</span>' : '') + '</div>';
  }).join('') + '</div>';
  if ((c.security || []).length) html += '<h4>' + esc(t('journey.insp.security')) + '</h4><div class="list"><div class="r">' + c.security.map((x) => sym('lock') + '<b>' + esc(x) + '</b>').join(' ') + '</div></div>';
  html += '<p class="note">' + esc(t('journey.insp.specNote')) + '</p>';
  return html;
}
/** FORKS: the branch points recorded on this step's node — each with its arms, outcomes and the copyable mock-state recipe.
 * @group Journey drill */
function jrnInspForksHtml(i) {
  const s = S.JOURNEY.steps[i] || {}, n = s.node || {};
  const bps = Array.isArray(n.branches) ? n.branches : [];
  if (!bps.length) return '<p class="note">' + esc(t('journey.insp.noForks')) + '</p>';
  return bps.map((bp, bi) => jrnForkEntryHtml({ i, bi, bp })).join('');
}
// Written out in full: a class attribute assembled from pieces reads as prose
// to the string lint (RULE 1), so each opener is one literal.
const JRN_LIST_ROW = '<li><a class="r" href="#/tests/';
const JRN_EV_CHIP = '<span class="ev ';
const JRN_ST_CHIP = '<span class="st ';
/**
 * TESTS: every test that reaches this step, as a tabbable list — the title,
 * its `file:line` ⧉, how the edge was found (technique · confidence · project
 * · the set-aside twin) and its evidence class. Three facts stay apart on
 * purpose: the **class** is a property of the edge, the **confidence** is a
 * property of the resolution (a declared edge can be HIGH and a reached one
 * LOW), and the **status** is what a run said. A coverage report is not a
 * case: it sits in its own row and says who observed it in the Tests tab's own
 * words, never *verified by a run*. An inactive case is listed — so it is not
 * mistaken for absent — and lifts no chip.
 *
 * A table is tested through its accessors and never directly, so it says so
 * rather than reading as untested.
 * @group Journey drill
 * @business Which tests prove this step, and how — a claim, an import, or an observed run.
 */
function jrnInspTestsHtml(i) {
  const s = S.JOURNEY.steps[i] || {};
  const cov = S.JOURNEY.summary && S.JOURNEY.summary.coverage;
  if (!cov) return '<p class="note">' + esc(t('journey.noTestsSub')) + '</p>';
  const direct = (s.coverage && s.coverage.tests) || [];
  const via = Array.isArray(s.coverageVia) ? s.coverageVia : [];
  const tests = direct.length ? direct : via;
  if (!tests.length) {
    // the action this step belongs to may still be reached: say so, in its own scope
    const wider = jrnStepActionFacts(i);
    const k = wider && wider.counted && wider.counted.tests;
    return '<p class="note">' + sym('warning') + ' ' + esc(t('journey.insp.noTestStep')) + '</p>'
      + (k && k.n ? '<p class="note jrn-twider" data-scope="' + esc(k.scope) + '">' + esc(t('journey.tests.widerScope')).replace('{n}', () => jrnCountedHtml(k, { noFocus: true })) + '</p>' : '');
  }
  const lead = !direct.length && via.length
    ? '<p class="note">' + esc(t('journey.tests.throughAccessors').replace('{n}', s.coverageViaCount != null ? s.coverageViaCount : via.length)) + '</p>'
    : '';
  const shown = tests.slice(0, JRN_INSP_TESTS);
  const rows = shown.map((x) => {
    const cls = x.evidence === 'observed' ? (x.freshness === 'changed' ? 'stale' : 'observed') : x.evidence === 'static' ? 'reached' : 'declared';
    // a run-level row carries the same observed class, attributed to the run
    const evKey = x.runLevel ? 'tests.evidence.runSeen' : 'journey.evidence.' + cls;
    const biz = currentLens() === 'business';
    // where the test lives and how the edge was found are a developer's facts
    const meta = biz ? '' : [
      x.loc && x.loc.path ? x.loc.path + (x.loc.line ? ':' + x.loc.line : '') : '',
      x.technique || '', x.confidence || '', x.project || '',
      x.via && S.BYID[x.via] ? S.BYID[x.via].name : '',
      x.twin ? t('tests.detail.twin').replace('{note}', x.twin.note) : '',
      x.inactive ? t('tests.detail.inactive') : '',
    ].filter(Boolean).join(' · ');
    const status = !x.inactive && x.status && x.status !== 'passed'
      ? JRN_ST_CHIP + esc(x.status) + '" title="' + esc(def('tests.run.' + x.status) || '') + '">' + esc(t('tests.run.' + x.status)) + '</span>' : '';
    return JRN_LIST_ROW + encodeURIComponent(x.id || '') + '"' + (x.runLevel ? ' data-run="1"' : '') + '>'
      + '<span class="t"><span class="nm">' + esc(biz ? (plainWords(x.name) || t('journey.biz.noWords')) : (x.name || x.id || '')) + '</span>' + (meta ? '<span class="cn">' + esc(meta) + '</span>' : '') + '</span>'
      + '<span class="lv ' + esc(x.level === 'e2e' ? 'e2e' : x.level === 'integration' ? 'int' : 'unit') + '">' + esc(t('tests.level.' + (x.level || 'unit'))) + '</span>'
      + (x.inactive ? '' : JRN_EV_CHIP + esc(cls) + '" title="' + esc(def(evKey) || '') + '">'
        + (cls === 'observed' ? sym('live') : cls === 'stale' ? sym('stale') : cls === 'reached' ? sym('step') : '')
        + esc(t(evKey)) + '</span>')
      + status + '</a></li>';
  }).join('');
  const more = tests.length > shown.length
    ? '<li class="more">' + esc(t('journey.moreChips').replace('{n}', tests.length - shown.length)) + '</li>' : '';
  return lead + '<ul class="jrn-tlist" role="list">' + rows + more + '</ul>'
    + '<p class="note">' + esc(t('journey.tests.listHint')) + '</p>';
}
/**
 * Fill the inspector for the selected step: the tab strip, the head, and the
 * open tab's body. -1 leaves the hint. Rings the beat head and the rail stop
 * the step belongs to, and redraws the wires (a selection can open a fold).
 * @group Journey drill
 */
/**
 * The panel itself — the tab strip, the head and the open tab's body — drawn
 * from one place so the drill's inspector and the timeline's code pane answer
 * the same five questions about a step in the same order (B4.1). The caller
 * owns the container: the drill's is `#jrn-insp`, the pane wraps it in
 * `.jrn-insp` for the same content styling.
 * @group Journey drill
 */
export function jrnInspPanelHtml(i) {
  if (i == null || i < 0 || !S.JOURNEY || !S.JOURNEY.steps[i]) {
    return '<div class="body"><div class="jrn-insp-hint">' + esc(t('journey.insp.hint')) + '</div></div>';
  }
  const tabs = jrnInspTabs(i), tab = jrnInspTabFor(i);
  jrnInspImpactAsk(i);
  const body = tab === 'req' ? jrnInspReqHtml(i) : tab === 'code' ? '<div class="jrn-code">' + jrnExpBodyHtml(i) + '</div>'
    : tab === 'forks' ? jrnInspForksHtml(i) : tab === 'tests' ? jrnInspTestsHtml(i)
    : tab === 'impact' ? jrnInspImpactHtml(i) : jrnInspDocsHtml(i);
  // IMPACT keeps the name it already has everywhere else (`impact.title`):
  // a second key with the same words is two names for one thing
  return '<div class="tabs">' + tabs.map((k) => '<button class="' + (k === tab ? 'on' : '') + '" onclick="jrnDrillInspTab(\'' + k + '\')">' + esc(k === 'impact' ? t('impact.title') : t('journey.insp.' + k)) + '</button>').join('')
    + '<button class="x" onclick="jrnSelect(-1)" aria-label="' + esc(t('journey.closeExpanded')) + '" title="' + esc(t('journey.closeExpanded')) + ' (esc)">✕</button></div>'
    + '<div class="body">' + jrnInspHeadHtml(i, jrnMarkerAt(i)) + body + '</div>';
}
function jrnDrillInspect(i) {
  const insp = document.getElementById('jrn-insp');
  if (!insp) return;
  const mk = i >= 0 ? jrnMarkerAt(i) : null;
  const open = !!(i >= 0 && mk);
  insp.innerHTML = jrnInspPanelHtml(open ? i : -1);
  // a panel holding one sentence does not hold 38% of the window: .empty gives
  // the beats the difference back until there is something to read here
  insp.classList.toggle('empty', !open);
  const bi = (S.JRN_DRILL && S.JRN_DRILL.colOf && i >= 0) ? S.JRN_DRILL.colOf[i] : null;
  document.querySelectorAll('#jrn-lanes .jrn-dbh[data-beat]').forEach((el) => el.classList.toggle('on', bi != null && +el.dataset.beat === bi));
  document.querySelectorAll('#jrn-tl .jrn-stop').forEach((el) => el.classList.toggle('on', +el.dataset.col === S.jrnAction));
  jrnDrillWires();
}

// ── index · render · navigate ───────────────────────────────────
/**
 * Index the drill before it is drawn: the actions and layers on S, every
 * marker's row and action (`S.JRN_MARK[order] = {seg,row,col}` — the action a
 * selection must open), and the action to start on — the one the selected
 * step lives in when the same journey is being redrawn, else the first.
 * @group Journey drill
 */
export function jrnDrillIndex(sum, keepActive) {
  const cols = jrnDrillActions(sum), layers = jrnDrillLayers(sum);
  const byKey = {};
  layers.forEach((l, li) => { byKey[l.key] = li; });
  S.JRN_DRILL = { cols, layers, byKey, colOf: {} };
  S.JRN_MARK = {};
  cols.forEach((col) => col.sg.markers.forEach((m) => {
    if (m.moment !== col.mo.index) return;
    S.JRN_MARK[m.stepOrder] = { seg: col.sg.index, row: jrnDrillLayerOf(m, byKey), col: col.index };
  }));
  const keep = keepActive && S.journeyActive >= 0 && S.JRN_MARK[S.journeyActive];
  S.jrnAction = keep ? S.JRN_MARK[S.journeyActive].col : Math.min(S.jrnAction || 0, Math.max(0, cols.length - 1));
  if (!cols.length) S.jrnAction = 0;
}
/** The j/k walk of the drill: every action's markers in step order — the open action's drawn boxes and chips, the others' tier 0–1 parts.
 * @group Journey drill */
export function jrnDrillOrders() {
  const dr = S.JRN_DRILL;
  if (!dr) return [];
  const out = [];
  dr.cols.forEach((col) => col.sg.markers.forEach((m) => {
    if (m.moment !== col.mo.index) return;
    if (col.index === S.jrnAction) { if (S.JRN_DRAWN && S.JRN_DRAWN.has(m.stepOrder)) out.push(m.stepOrder); }
    else if (!m.helper && (m.tier == null || m.tier <= 1)) out.push(m.stepOrder);
  }));
  return out;
}
/** Draw (or redraw) the open action's caption and lanes in place, register its folds and wires, and note what is drawn for j/k.
 * @group Journey drill */
function jrnDrillRenderAction() {
  const dr = S.JRN_DRILL;
  const host = document.getElementById('jrn-dlanes');
  if (!dr || !host || !dr.cols.length) return;
  const col = dr.cols[S.jrnAction] || dr.cols[0];
  S.JRN_FOLDS = []; S.JRN_FOLD_OF = {};
  const model = jrnDrillBeats(col, dr.layers);
  dr.colOf = model.colOf; dr.beats = model.beats;
  S.JRN_WIRES = model.wires;
  const cap = document.getElementById('jrn-dcap');
  if (cap) cap.outerHTML = jrnDrillCaptionHtml(dr.cols, model).replace('class="jrn-dcap"', 'class="jrn-dcap" id="jrn-dcap"');
  host.innerHTML = jrnDrillLanesHtml(dr.cols, dr.layers, model, col);
  S.JRN_DRAWN = new Set(Array.from(host.querySelectorAll('[data-order]')).map((el) => +el.dataset.order));
  document.querySelectorAll('#jrn-tl .jrn-stop').forEach((el) => el.classList.toggle('on', +el.dataset.col === S.jrnAction));
  if (S.jrnDrillRO) S.jrnDrillRO.disconnect();
  if (window.ResizeObserver) {
    S.jrnDrillRO = new ResizeObserver(() => jrnDrillWires());
    S.jrnDrillRO.observe(host);
    const lanes = document.getElementById('jrn-lanes');
    if (lanes) S.jrnDrillRO.observe(lanes);
  }
  requestAnimationFrame(jrnDrillWires);
}
/**
 * The whole drill: the rail, the caption, the lanes of the open action and the
 * inspector. Returns the markup; the lanes and the wires are filled in by
 * `jrnDrillMount()` once the markup is in the DOM.
 * @group Journey drill
 * @business The journey as numbered actions; one opened into its beats with every layer of the system, and a panel that explains the selected step.
 */
export function jrnDrillHtml(sum) {
  const dr = S.JRN_DRILL;
  return '<div class="jrn-drill">' + jrnDrillRailHtml(sum, dr.cols)
    + '<div class="jrn-dcap" id="jrn-dcap"></div>'
    + '<div class="jrn-drill-main"><div class="jrn-lanes-wrap" id="jrn-dlanes"></div>'
    + '<div class="jrn-insp" id="jrn-insp" role="region" aria-label="' + esc(t('journey.insp.title')) + '"></div></div></div>';
}
/** Fill the drill's lanes after its markup landed, and show the inspector's hint.
 * @group Journey drill */
export function jrnDrillMount() {
  jrnDrillRenderAction();
  jrnDrillInspect(-1);
}
/** Open an action from the rail: redraw the lanes for it and select its first drawn step (the action itself).
 * @group Journey drill
 * @business Jumps to one action of the journey and opens its beats. */
function jrnDrillGo(ci) {
  const dr = S.JRN_DRILL;
  if (!dr || !dr.cols[ci]) return;
  S.jrnAction = ci;
  jrnDrillRenderAction();
  const wrap = document.getElementById('jrn-dlanes');
  if (wrap) { wrap.scrollLeft = 0; wrap.scrollTop = 0; }
  const first = jrnDrillOrders().find((o) => S.JRN_MARK[o] && S.JRN_MARK[o].col === ci);
  if (first != null) jrnSelect(first, true); else jrnDrillInspect(-1);
  const stop = document.querySelector('#jrn-tl .jrn-stop[data-col="' + ci + '"]');
  if (stop) stop.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
/** Make sure the action step i lives in is the open one (the selection path calls this before it reveals folds).
 * @group Journey drill */
export function jrnDrillEnsureAction(i) {
  const mk = S.JRN_MARK && S.JRN_MARK[i];
  if (!S.JRN_DRILL || !mk || mk.col === S.jrnAction) return;
  S.jrnAction = mk.col;
  jrnDrillRenderAction();
}
/** Selection hook: the drill's inspector is where a selected step opens (there is no expansion slot and no dock here).
 * @group Journey drill */
export function jrnDrillSelected(i) { jrnDrillInspect(i); }
/** Move to the next / previous action (the `[` / `]` keys).
 * @group Journey drill */
export function jrnDrillStep(d) {
  const dr = S.JRN_DRILL;
  if (!dr || !dr.cols.length) return;
  jrnDrillGo(Math.max(0, Math.min(dr.cols.length - 1, (S.jrnAction || 0) + d)));
}

expose({ jrnDrillGo, jrnDrillInspTab });
