// The journey organisation's words (docs/proposals/journey-organisation-and-config-files.md §4, §7):
// journeys shown by persona, then by group, in the order the manifests and the config declare.
// Spread into STRINGS in strings.ts like strings-deps.ts. Same rules as the rest of the catalog:
// both registers, a define on every word a reader may not know, defines in plain words (no
// backticks, no markdown, no dotted identifiers, no placeholders). The viewer lane adds its
// own words below this block.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const JOURNEYS_STRINGS: Record<string, StringEntry> = {
  'journeys.noGroup': {
    hud: 'Other quests',
    professional: 'Other journeys',
    define: 'Journeys whose design names no group for this person, listed after the groups the design declares.',
  },
  'count.scope.persona': same('for this persona',
    'What the number beside it counts over: the journeys one kind of person lives in, as the design declares it. A journey made for two kinds of person is counted under each.'),
  'count.scope.group': same('in this group',
    'What the number beside it counts over: one group of journeys under one kind of person, such as the ways in or the things a person can do.'),
  'count.unit.journeys': same('{n} journeys',
    'Named journeys the design declares: features a person moves through screen by screen. Across every source each journey is counted once, however many kinds of person it is shown under.'),
  'count.unit.journeysOne': one('1 journey', 'count.unit.journeys'),
  'count.unit.journeysBuilt': same('{n} of {m} journeys built',
    'Journeys whose every screen exists in code, out of the journeys counted beside it. A journey with some screens built and some not is not counted as built.'),
  'count.unit.personas': same('{n} personas',
    'The kinds of person the journeys are for, as the design names them, with a heading of their own. Journeys that name nobody sit under one more heading at the end, which is counted too.'),
  'count.unit.personasOne': one('1 persona', 'count.unit.personas'),
  'count.unit.groups': same('{n} groups',
    'Groups of journeys shown under the kinds of person, such as the ways in and the things a person can do. A group shown under two kinds of person is counted under each.'),
  'count.unit.groupsOne': one('1 group', 'count.unit.groups'),
  // the viewer's words (lane C): the organised front door, its filter and the journey header
  'journeys.persona.title': {
    hud: 'Quest lines', professional: 'Journeys by who uses them',
    define: 'Every journey the design manifests in scope declare, organised by the person it is for and then by its group, in the order the manifests and the configuration declare them.',
  },
  'journeys.persona.sub': same('Who each journey is for, then its group, in the order the manifests declare.'),
  'journeys.persona.undeclared': same('named only by its journeys',
    'A journey names this person, and no manifest or configuration declares it, so it has no description and follows the declared people in alphabetical order.'),
  'journeys.persona.filtered': same('Showing {what} only'),
  'journeys.persona.showAll': same('show everyone'),
  'journeys.persona.toggle': same('Show or hide this group of journeys'),
  'journeys.persona.empty': same('No journey matches this filter.'),
  'journeys.persona.for': same('For',
    'Who this journey is for and the group it sits in, as the design manifest or the configuration declares them.'),
  'journeys.persona.alsoUnder': same('also for {names}',
    'This journey is for more than one person, so it is listed under each of them and counted once in the total.'),
};
