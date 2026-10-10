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

  // ── the Config files list on the Settings page (docs/proposals/round-2026-10-05.md §6) ──
  'config.title': same('Config files',
    'The Farsight config files each source holds, read when the source was last synced. Read only: edit the files themselves, then sync again.'),
  'config.sub': same('What each farsight.config.json gives, where it applies, and where two files disagree. Read only — edit the files, then sync.',
    'A list of the config files Farsight read for each source: the one in the top folder speaks for the whole source, any other only for the code in its own folder.'),
  'config.scope.root': same('the whole source',
    'This file sits in the top folder of the source, so its words apply to all of the code there.'),
  'config.scope.dir': same('scoped to {dir}/',
    'This file sits in a folder below the top one, so it speaks only for the code in that folder, and the paths it names start from there.'),
  'config.gives': same('gives',
    'The settings this file gives, each counted once whatever it holds.'),
  'config.noFields': same('nothing Farsight reads',
    'The file holds no setting Farsight reads; it may be empty or only carry notes for editors.'),
  'config.ignored': same('ignored',
    'Settings this file gives that Farsight did not apply: a name it does not know, or a setting only the file in the top folder may give.'),
  'config.conflicts': same('Conflicts',
    'Places where two config files of one source say different things about the same name, and which file stands.'),
  'config.notes': same('Notes',
    'What Farsight said while reading the files: a file it could not read, a path that leaves the source, a setting it ignored.'),
  'config.none': same('No config files recorded. The sources have no farsight.config.json, or the graph was written before they were recorded — sync to record them.',
    'Farsight keeps a list of the config files it read at each sync. An older graph has none until the next sync.'),
  'config.failed': same('The config files could not be loaded.',
    'The server did not answer the request for the config files list. Sync the sources, or restart the server, and open Settings again.'),
  'config.open': same('Open in the editor',
    'Open this config file in VS Code. Only shown when the source sits in a folder on this machine.'),
  'config.conflict.glossary': same('Two words for {key} — {files}. Under {kept}’s folder its word stands.',
    'Two config files, one inside the other’s folder, give different words for the same name. For the code under the inner folder the nearer file’s word is the one shown.'),
  'config.conflict.guard': same('{key} is already a check from {files} — {kept}’s stands.',
    'One file turned a function into a check, and a later file names it as a check under another name. The first one stays.'),
  'config.conflict.external': same('The third party {key} is declared twice — {files}. {kept}’s is kept.',
    'Two config files declare the same outside system. The first declaration is kept and the second is not applied.'),
  'config.conflict.store': same('{key} is named as two different stores — {files}. {kept}’s is kept.',
    'Two config files name the same data store differently, or put the same table in different stores. The nearer file’s word stands for its own folder; otherwise the first is kept.'),
  'config.conflict.lifecycle': same('{key} has two words for one status — {files}. {kept}’s stands.',
    'Two config files, or two words in one file, name the same status of a record differently for the same kind of user. The nearer file’s word is the one shown.'),
  'config.conflict.tag': same('{key} is tagged differently — {files}. {kept}’s stands.',
    'Two config files tag the same part in ways that disagree. The file named last is the one that stands.'),

  // the settings a config file may give, in words for the business lens (the code and hybrid lenses print the name as written)
  'config.field.tags': same('tags', 'Labels attached to parts of the code by matching their path or name.'),
  'config.field.glossary': same('business words', 'Plain words for the names in the code, shown in the business lens instead of the name.'),
  'config.field.guards': same('checks', 'Functions or web addresses to treat as checks a request must pass, such as signing in.'),
  'config.field.entrypoints': same('ways in', 'Code that starts work by itself, such as a nightly job or a queue reader, so a journey can start there.'),
  'config.field.setup': same('start-up code', 'The code that builds the running application when it starts, kept apart from what a user does.'),
  'config.field.plumbing': same('plumbing', 'Folders of helper code: shown inside journeys, but never counted as a feature or a way in.'),
  'config.field.design': same('screen designs', 'Where the descriptions of the screens and the journeys through them are kept.'),
  'config.field.openapi': same('API descriptions', 'Documents describing the web addresses this code serves, beyond the ones Farsight finds by itself.'),
  'config.field.tests': same('test reports', 'Where the test runs leave their results and coverage, so Farsight can say which code a test ran.'),
  'config.field.storybook': same('component gallery', 'Where the gallery of the screens’ building blocks lives and how it is started.'),
  'config.field.externals': same('outside systems', 'Third-party systems the code talks to that Farsight cannot see by itself, with a name and a kind.'),
  'config.field.stores': same('data stores', 'Which database or store the records live in, where the code does not say.'),
  'config.field.journeys': same('journey order', 'How the journeys are organised: for whom each one is, which group it sits in, and in what order.'),
  'config.field.projects': same('project words', 'How the projects of the workspace group, and words for their tags. Only the file in the top folder may give it.'),
  'config.field.lifecycle': same('status words', 'The words people use for a record’s statuses, for each kind of user, and the conditions they see that are not a status. The code still decides which statuses exist and what moves a record between them.'),
  'config.field.tooling': same('tooling folders', 'Folders of scripts a person runs by hand, kept out of the running application. Only the file in the top folder may give it.'),
};
