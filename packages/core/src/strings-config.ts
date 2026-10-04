// The config files pass's words (docs/proposals/journey-organisation-and-config-files.md §5, §7): every
// Farsight config file a source holds, the one at its top folder and the ones scoped to a folder below
// it. Spread into STRINGS in strings.ts like strings-deps.ts. Same rules as the rest of the catalog:
// both registers, a define on every word a reader may not know, defines in plain words (no backticks,
// no markdown, no dotted identifiers, no placeholders).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const CONFIG_STRINGS: Record<string, StringEntry> = {
  'count.unit.configFiles': same('{n} config files',
    'Farsight config files one source holds, each counted once: the one in its top folder, which speaks for the whole source, and any in a folder below it, which speaks only for the code in that folder. A file that could not be read is not counted; it is named in the notes.'),
  'count.unit.configFilesOne': one('1 config file', 'count.unit.configFiles'),
  'count.part.configRoot': same('{n} for the whole source',
    'The config file in the top folder of the source. Its words apply to all of the code, and only it may say how projects group and which folders are tooling.'),
  'count.part.configRootOne': one('1 for the whole source', 'count.part.configRoot'),
  'count.part.configScoped': same('{n} for one folder',
    'Config files in a folder below the top one. Each speaks only for the code in its own folder, and the paths it names start from that folder. Where two files name the same thing, the nearer one wins.'),
  'count.part.configScopedOne': one('1 for one folder', 'count.part.configScoped'),
  'count.unit.configConflicts': same('{n} conflicts',
    'Places where two config files of one source say different things about the same name: two words for one function, a second declaration of a third party or a data store, or a check one file already made. The file whose word stands is named beside each.'),
  'count.unit.configConflictsOne': one('1 conflict', 'count.unit.configConflicts'),
};
