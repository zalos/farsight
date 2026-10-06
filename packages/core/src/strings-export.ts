// Export's words (round 2026-10-05, lane E): saving the Map's storyline board,
// the journey's storyboard and the Portfolio as a picture, a PDF or (the
// Portfolio) a spreadsheet, the footer written under every saved picture, and
// the pinned, dated link. Spread into STRINGS in strings.ts. Same rules as the
// rest of the catalog: both registers, a define on every word, defines in plain
// words. A save's words are business words in every lens: *save as picture*,
// never *export PNG* alone.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}

export const EXPORT_STRINGS: Record<string, StringEntry> = {
  // the control on each surface, and its menu
  'export.tool': same('Save', 'Saves what this view shows, whole, as a picture or a PDF, with where and when it was true written under it: the source, the sync, its commit, the day and the lens. The file is drawn in this browser; nothing is sent anywhere.'),
  'export.menu': same('Save this view', 'The ways this view can be saved. Each file carries the same footer: what it shows, the sync it was read at, and the day.'),
  'export.png': same('save as picture (PNG)', 'A picture of the whole view, not only the part on screen, with its footer, to paste into a deck or a page.'),
  'export.pdf': same('save as PDF', 'The same picture on one page of a PDF, with its footer, to attach or print.'),
  'export.csv': same('save as spreadsheet (CSV)', 'Every journey row of this table, one line each, with the words its cells show, for a spreadsheet. The first line names the columns; the sync it was read at is in the file name.'),
  'export.working': same('drawing the picture…', 'The view is being drawn into a picture in this browser. A large board takes a few seconds.'),
  'export.done': same('saved {file}', 'The file was drawn in this browser and handed to it to save. Its footer says which sync it shows.'),
  'export.failed': same('the picture could not be drawn: {why}', 'The browser refused to draw this view into a picture. The view itself is unchanged; a screenshot is the fallback.'),
  // why a picture could not be drawn — the reason the failure line names
  'export.why.decode': same('the browser could not read the copy as a picture', 'The copy of the view did not decode as an image. A part of it this browser will not draw inside a picture is the usual cause.'),
  'export.why.tooBig': same('the picture is larger than this browser will draw', 'The view is wider or taller than a canvas this browser allows. Narrow the scope or pick one storyline, and save again.'),
  'export.why.none': same('there is no view here to save', 'This page has no Save control: the Map, a journey and the Portfolio do.'),
  'export.why.notDrawn': same('the view is not drawn yet', 'The view was still loading. Wait for it to draw, then save again.'),
  'export.why.notTable': same('this view is not a table', 'Only the Portfolio is saved as a spreadsheet; the other views are pictures.'),
  // what a saved picture shows, line one of its footer
  'export.surface.map': same('Map', 'The Map: the journeys drawn as one board.'),
  'export.surface.storyboard': same('Storyboard', 'One journey as a person walks it: every screen in order, the things the person does on the open one, and what each does.'),
  'export.surface.portfolio': same('Portfolio', 'The table of every journey: what is built, what it calls, what proves it runs, whether it reaches the ERP and who owns it.'),
  'export.board.all': same('every journey', 'The whole board: every journey, in its bands.'),
  'export.footer.what': same('{surface} · {title}', 'What the saved picture shows: the view, and the journey, storyline or table in it.'),
  'export.footer.facts': same('{source} · sync {n} · source {commit} · as of {date} · {lens}', 'Where and when the picture is true: the source it reads, the sync it was drawn from, the source commit that sync read, the day the sync was taken, and the lens its words are in.'),
  'export.footer.drawn': same('drawn by Farsight {build} · saved {saved}', 'Which Farsight build drew the picture, and the day it was saved. The sync before it says when the facts were true; this says when the file was made.'),
  'export.footer.lens.business': same('business words', 'Read in the business lens: words a person wrote, no code.'),
  'export.footer.lens.hybrid': same('hybrid words', 'Read in the hybrid lens: business names with the code names beside them.'),
  'export.footer.lens.code': same('code words', 'Read in the code lens: the names the code uses.'),
  // the Portfolio's spreadsheet: its columns
  'export.col.persona': same('who', 'The persona the journey is listed under on the Portfolio.'),
  'export.col.group': same('group', 'The group of journeys it is listed in, when the persona has more than one.'),
  // the pinned, dated link (the Share menu)
  'share.pinnedLink': same('Copy pinned link', 'A link to this view that names the sync it was read at and the day, so whoever opens it can tell whether they are looking at the same facts. A server that has synced since says so beside its own sync chip.'),
  'share.pinnedLinkSub': same('pinned to sync {n} · as of {date}', 'The sync and the day this link names. The server that opens it draws its own latest sync, and says so when the two differ.'),
  'share.pinnedNone': same('this graph has no sync number to pin to', 'A graph written without the snapshot history carries no sync number, so a link to it cannot name one. The live link still works.'),
  'share.saveHere': same('Save this view', 'The views that can be saved as a picture or a PDF have a Save control in their own toolbar: the Map, a journey (as its storyboard) and the Portfolio.'),
  'pin.note': same('pinned to sync {n} · this server shows sync {m}', 'This link names the sync it was taken at, and the server is drawing a later or earlier one, so a number here may differ from the one the link was shared with. The person who serves the graph can draw the older sync by starting the server as of that sync.'),
};
