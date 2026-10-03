// The dependencies pass's words (docs/proposals/dependencies-and-nx.md §2.1, §2.3): packages as
// nodes — third-party packages and workspace libraries — the files that import them and the
// journeys they reach. Spread into STRINGS in strings.ts like strings-map.ts. Same rules as the
// rest of the catalog: both registers, a define on every word a reader may not know, defines in
// plain words (no backticks, no markdown, no dotted identifiers, no placeholders). The code map
// lane (C) adds its viewer words below this block.
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const DEPS_STRINGS: Record<string, StringEntry> = {
  'surf.kind.package': same('dependency',
    'A package the code is built on: one somebody else publishes, or a library of this workspace that other parts import by name.'),
  'surf.kind.module': same('file',
    'One source file, as the list of packages it imports.'),
  'count.scope.package': same('for this package',
    'What the number beside it counts over: one package as one source imports it, every file of that source that imports it, wherever the file sits.'),
  'count.unit.packages': same('{n} packages',
    'Dependencies the code imports, each counted once per source: packages somebody else publishes and libraries of this workspace imported by name. The runtime’s own modules are not counted.'),
  'count.unit.packagesOne': one('1 package', 'count.unit.packages'),
  'count.part.packagesThirdParty': same('{n} third-party',
    'Packages somebody else publishes, imported by name from a package registry.'),
  'count.part.packagesThirdPartyOne': one('1 third-party', 'count.part.packagesThirdParty'),
  'count.part.packagesWorkspace': same('{n} from this workspace',
    'Libraries that live in this codebase and are imported by a name, the way a published package would be, rather than by a file path.'),
  'count.part.packagesWorkspaceOne': one('1 from this workspace', 'count.part.packagesWorkspace'),
  'count.unit.importers': same('{n} files import it',
    'Source files that import this package, each counted once however many times it names it. Test and story files are not read for this.'),
  'count.unit.importersOne': one('1 file imports it', 'count.unit.importers'),
  'count.unit.journeysReached': same('{n} journeys reach it',
    'Journeys whose path passes through code that uses this package, or through code that calls that code. Shared helpers are listed but not followed further, so this is a floor.'),
  'count.unit.journeysReachedOne': one('1 journey reaches it', 'count.unit.journeysReached'),
};
