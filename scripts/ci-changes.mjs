#!/usr/bin/env node
// Coarse CI boundaries, not a per-test dependency graph. Unknown inputs run everything.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClosure, workspacePackages } from './pack-preflight.mjs';

const all = () => ({
  validate: true,
  e2e: true,
  echo: true,
  sentinel: true,
  isolation: true,
  recovery: true,
  service: true,
  scannerCli: true,
});

/** validate's unit tests over every package, and over none (only the skills trees changed). */
const EVERY = Object.freeze({ scope: 'all', packages: Object.freeze([]), also: Object.freeze([]) });
const NONE = Object.freeze({ scope: 'none', packages: Object.freeze([]), also: Object.freeze([]) });

/** The only package names the selector emits or the test step hands to pnpm: one output word, no separators. */
const PACKAGE_NAME = /^@farsight\/[a-z0-9-]+$/;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The package directories `sentinel-package` packs: farsight-cli's whole workspace dependency
 * closure (its clean-consumer startup without Sentinel is checked there) and Sentinel's own.
 * Read from the manifests, so a new dependency of the CLI joins the set without editing this file.
 */
export function sentinelPackageInputs(root = repoRoot) {
  const dirs = new Set(['graph', 'code-parser', 'core']);
  for (const entry of ['@farsight/cli', '@farsight/sentinel']) {
    const { closure, missing } = buildClosure(root, entry);
    if (entry === '@farsight/cli' && (!closure.length || missing.length)) throw new Error('CLI closure unreadable');
    for (const pkg of closure) dirs.add(basename(pkg.dir));
  }
  dirs.delete('sentinel'); // its own rules below
  return dirs;
}

/**
 * The package directories `sentinel-isolation` depends on: Sentinel's own workspace build closure (public parser,
 * core and graph today), read from the manifests. Sentinel itself has its own rule below.
 */
export function sentinelIsolationInputs(root = repoRoot) {
  const { closure, missing } = buildClosure(root, '@farsight/sentinel');
  if (!closure.length || missing.length) throw new Error('Sentinel closure unreadable');
  const dirs = new Set(closure.map((pkg) => basename(pkg.dir)));
  dirs.delete('sentinel');
  return dirs;
}

const SCANNER_WORKFLOW = '.github/workflows/sentinel-scanner-cli.yml';
const CODE = /\.(?:[cm]?[jt]s|tsx)$/;
// import and export specifiers, dynamic imports, requires and import.meta-relative file references
const SPECIFIERS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"\n]+)['"]/g,
  /\brequire(?:\.resolve)?\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bnew URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
];
// a compiled file named by its path under a package's dist/, as workers, gates and drivers are ('execution/launch-gate')
const DIST_PATH = /['"`](?:dist\/)?([a-z][\w-]*(?:\/[\w.-]+)+)['"`]/g;
// the published name the consumers import the installed tarball by
const PUBLISHED = new Map([['farsight-sentinel', '@farsight/sentinel']]);
// one string literal, whole: '…', "…" or a template with no substitution
const ONE_LITERAL = /^(?:'([^'\n]*)'|"([^"\n]*)"|`([^`$\n]*)`)$/;
// Where a load starts: import(), require() and require.resolve(), new URL(), and an import or export generated in a
// template (`import x from ${…}`, `import ${…}`), each followed through its balanced arguments, across lines.
// Built from parts so that this file's own source holds none of the shapes it looks for.
const LOAD_START = new RegExp(
  [
    String.raw`\bimport\s*\(`,
    String.raw`\brequire` + String.raw`(?:\.resolve)?\s*\(`,
    String.raw`\bnew\s+URL` + String.raw`\s*\(`,
    String.raw`\b(?:import|export)\s*[\w$*{}\s,]+?\s+from\s*\$` + String.raw`\{`,
    // a bare generated import starts a statement: after the start, a semicolon, a brace or an escaped newline
    String.raw`(?<=(?:^|[;{}]|\\n)\s*)import\s*\$` + String.raw`\{`,
  ].join('|'),
  'g',
);

/** The text between an opening bracket at `open - 1` and its balanced close, strings skipped; null if unbalanced. */
function balanced(text, open) {
  let depth = 1;
  for (let i = open, quote = null; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch) && --depth === 0) return text.slice(open, i);
  }
  return null;
}

/**
 * A file's code with its comments and the text of its strings blanked to spaces, offsets kept: what declares and
 * references names. A template literal's text is blanked and its `${…}` substitutions kept, since they are code; a
 * regular expression literal is blanked where the previous token allows one.
 */
export function codeView(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  // the index just past a template literal starting at `start` (its opening backtick), blanking its text
  const template = (start) => {
    let i = start + 1;
    for (let from = i; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '`') {
        blank(from, i);
        return i + 1;
      } else if (text[i] === '$' && text[i + 1] === '{') {
        blank(from, i);
        i = code(i + 2, '}');
        from = i + 1;
      }
    }
    return i;
  };
  // scans code from `start` to the bracket `close` that ends it (or the end), returning that bracket's index
  const code = (start, close) => {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '/' && text[i + 1] === '/') {
        const end = text.indexOf('\n', i);
        blank(i, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end - 1;
      } else if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        blank(i, end < 0 ? text.length : end + 2);
        i = end < 0 ? text.length : end + 1;
      } else if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        blank(i + 1, j);
        i = j;
      } else if (ch === '`') i = template(i) - 1;
      else if (
        ch === '/' &&
        /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bdo|\belse|\bin|\bof)\s*$/.test(
          text.slice(Math.max(0, i - 12), i),
        )
      ) {
        let j = i + 1;
        for (let inClass = false; j < text.length && text[j] !== '\n'; j++) {
          if (text[j] === '\\') j++;
          else if (text[j] === '[') inClass = true;
          else if (text[j] === ']') inClass = false;
          else if (text[j] === '/' && !inClass) break;
        }
        blank(i + 1, j);
        i = j;
      } else if ('({['.includes(ch)) depth++;
      else if (')}]'.includes(ch)) {
        if (depth === 0 && ch === close) return i;
        depth--;
      }
    }
    return text.length;
  };
  code(0, null);
  return out.join('');
}

/** An argument list split at its top-level commas. */
function topLevelArgs(list) {
  const args = [];
  let start = 0;
  for (let i = 0, depth = 0, quote = null; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      args.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(list.slice(start).trim());
  return args.filter((arg, i) => arg || i === 0);
}

/** `name(inner)` taking the whole expression, or null. */
function wholeCall(expression, name) {
  if (!expression.startsWith(`${name}(`) || !expression.endsWith(')')) return null;
  const inner = balanced(expression, name.length + 1);
  return inner !== null && inner.length === expression.length - name.length - 2 ? inner : null;
}

/**
 * A load's path expression without the wrappers that keep its target: `${…}`, parentheses, JSON.stringify, String,
 * pathToFileURL, fileURLToPath, `.href` and a `'file://' +` prefix.
 */
function unwrapLoad(expression) {
  let e = expression.trim();
  for (let previous = null; previous !== e;) {
    previous = e;
    if (e.startsWith('${') && e.endsWith('}') && balanced(e, 2)?.length === e.length - 3) e = e.slice(2, -1).trim();
    for (const name of ['', 'JSON.stringify', 'String', 'pathToFileURL', 'fileURLToPath'])
      e = wholeCall(e, name)?.trim() ?? e;
    if (/\.href$/.test(e) && e.endsWith(').href')) e = e.slice(0, -'.href'.length).trim();
    e = e.replace(/^(['"])file:\/\/\1\s*\+\s*/, '').trim();
  }
  return e;
}

/**
 * Every load in a file, comment lines aside, with its line: a dynamic import, a require or require.resolve, a new
 * URL(…, import.meta.url), and an import generated in a template. Their brackets are followed across lines, so a load
 * split over several is one load. One whose path is a single literal ('…', "…" or a template with no substitution)
 * carries it as `literal`, and the walk follows it; any other carries its path expression unwrapped (null when its
 * brackets do not close). So no load is neither followed nor reported.
 */
export function loadSites(text) {
  const sites = [];
  for (const match of text.matchAll(LOAD_START)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(text.slice(lineStart, match.index))) continue;
    const line = text.slice(0, match.index).split('\n').length;
    const generated = match[0].endsWith('{') && match[0].includes('$');
    const inner = balanced(text, match.index + match[0].length);
    if (inner === null) {
      sites.push({ line, index: match.index, expression: null });
      continue;
    }
    const args = generated ? [`\${${inner}}`] : topLevelArgs(inner);
    const first = args[0] ?? '';
    // a URL with another base is not a module load; `import()` with nothing in it is prose
    if (/^new\s+URL/.test(match[0]) ? args[1] !== 'import.meta.url' : !first) continue;
    const literal = ONE_LITERAL.exec(first);
    if (literal) sites.push({ line, index: match.index, literal: literal[1] ?? literal[2] ?? literal[3] });
    else sites.push({ line, index: match.index, expression: unwrapLoad(first) });
  }
  return sites;
}

/** The loads in a file whose path is not one literal: what `loadSites` cannot hand the walk as a specifier. */
export function computedLoadSites(text) {
  return loadSites(text)
    .filter((site) => site.literal === undefined)
    .map(({ line, expression }) => ({ line, expression }));
}

/**
 * Where a computed load in one file may point, selected whole because the walk cannot tell which file it is: a
 * package source's own `src/`; a package script's `src/` and `scripts/`; a package test's `src/` and
 * `test/fixtures/` (the workers and data a test loads by path); a root script's neighbours in `scripts/` and the
 * `src/` and `scripts/` of every package the workflow builds, whose `dist/` it can load by path.
 */
function computedArea(file, built) {
  const inPackage = /^packages\/([^/]+)\/([^/]+)\//.exec(file);
  if (!inPackage)
    return ['scripts/', ...[...built].flatMap((dir) => [`packages/${dir}/src/`, `packages/${dir}/scripts/`])];
  const [, dir, top] = inPackage;
  const second = { scripts: 'scripts/', test: 'test/fixtures/' }[top];
  return [`packages/${dir}/src/`, ...(second ? [`packages/${dir}/${second}`] : [])];
}

/** A compiled file's source: `packages/<p>/dist/x.js` is `packages/<p>/src/x.ts` (or .tsx, .js, .mjs). */
function sourceOf(root, path) {
  const dist = /^(packages\/[^/]+)\/dist\/(.+?)\.(?:js|mjs|d\.ts)$/.exec(path);
  const candidates = dist
    ? ['ts', 'tsx', 'js', 'mjs'].map((ext) => `${dist[1]}/src/${dist[2]}.${ext}`)
    : [path, ...(path.endsWith('.js') ? [path.replace(/\.js$/, '.ts')] : [])];
  return candidates.find((candidate) => existsSync(join(root, candidate))) ?? null;
}

/** The file a package subpath (`.` or `./x`) names, by its manifest's `exports` (patterns included), else its `main`. */
function exportTarget(manifest, sub) {
  const { exports } = manifest;
  if (exports === undefined) return sub === '.' ? (manifest.main ?? 'index.js') : sub;
  const map =
    typeof exports === 'string' || !Object.keys(exports).some((k) => k.startsWith('.')) ? { '.': exports } : exports;
  const pick = (entry) => (typeof entry === 'string' ? entry : (entry?.import ?? entry?.default ?? null));
  if (map[sub] !== undefined) return pick(map[sub]);
  for (const [key, entry] of Object.entries(map)) {
    const star = key.indexOf('*');
    const [head, tail] = [key.slice(0, star), key.slice(star + 1)];
    if (star >= 0 && sub.startsWith(head) && sub.endsWith(tail) && sub.length >= head.length + tail.length)
      return pick(entry)?.replace('*', sub.slice(head.length, sub.length - tail.length)) ?? null;
  }
  return null;
}

/** The files the sentinel-scanner-cli workflow's steps name: tests, scripts, the packer, the package's command. */
function scannerCliEntries(workflow, sentinel) {
  const entries = new Set();
  for (const [file] of workflow.matchAll(/\btest\/[\w.-]+\.test\.ts\b/g)) entries.add(`packages/sentinel/${file}`);
  for (const [, file] of workflow.matchAll(/(?<![\w/.-])((?:packages\/sentinel\/)?scripts\/[\w.-]+\.mjs)\b/g))
    entries.add(file);
  // the packer bundles every export of the package, so each export's file is built into what the consumers run
  if (/\bpnpm pack:sentinel\b/.test(workflow)) {
    entries.add('scripts/pack-sentinel.mjs');
    for (const key of Object.keys(sentinel.exports ?? {})) {
      const file = !key.includes('*') && exportTarget(sentinel, key);
      if (file) entries.add(join('packages/sentinel', file).split(sep).join('/'));
    }
  }
  for (const bin of Object.values(sentinel.bin ?? {})) entries.add(join('packages/sentinel', bin).split(sep).join('/'));
  return entries;
}

/**
 * Every file the sentinel-scanner-cli workflow executes, from the files its steps name: the test files it runs, the
 * scripts it runs (`pnpm pack:sentinel` is the packer), and, because its consumers install the tarball and run it, the
 * package's command. Followed through every import, export, dynamic import, require and import.meta file reference,
 * workspace packages (and the published name) through their `exports`, and through compiled `dist/` paths named as
 * strings (workers, gates, drivers), each mapped to its source. A load it cannot follow (an import, require or
 * import.meta URL whose path is computed) is recorded with its file and line, and the area it may point into is
 * selected whole (`computedArea`). Returns the root, the files (repository paths), the folders read whole (the
 * example application the full-report tests ingest), the packages its build step builds (both closures, read from
 * the manifests), the text of the test and script files reached, which names the fixtures they read, and the
 * computed loads with the areas they select. Unreadable inputs throw, and the caller then selects every check.
 */
export function scannerCliClosure(root = repoRoot) {
  const workflow = readFileSync(join(root, SCANNER_WORKFLOW), 'utf8');
  const packages = workspacePackages(root);
  const dirOf = new Map([...packages].map(([name, { dir }]) => [name, `packages/${basename(dir)}`]));
  const sentinel = packages.get('@farsight/sentinel')?.manifest;
  if (!sentinel) throw new Error('@farsight/sentinel has no manifest');
  const resolveFrom = (from, spec) => {
    let target = null;
    if (spec.startsWith('.')) target = relative(root, resolve(root, dirname(from), spec));
    else {
      const [, bare, rest] = /^((?:@[\w.-]+\/)?[\w.-]+)(?:\/(.*))?$/.exec(spec) ?? [];
      const name = PUBLISHED.get(bare) ?? bare;
      const file = packages.has(name) ? exportTarget(packages.get(name).manifest, rest ? `./${rest}` : '.') : null;
      if (file) target = join(dirOf.get(name), file);
    }
    return target && !target.startsWith('..') ? sourceOf(root, target.split(sep).join('/')) : null;
  };
  const built = new Set();
  for (const entry of ['@farsight/sentinel', '@farsight/parsers']) {
    const { closure, missing } = buildClosure(root, entry);
    if (!closure.length || missing.length) throw new Error(`${entry} closure unreadable`);
    for (const pkg of closure) built.add(basename(pkg.dir));
  }
  // A computed load whose target is still one literal, once its wrappers are off: a URL against the module, a
  // resolved specifier, a dist/ path joined to a known package root (below), or a module the same file writes from
  // a literal (its text is followed with the file's). Anything else is null: its area is selected.
  const QUOTED = String.raw`('[^'\n]*'|"[^"\n]*"|\x60[^\x60$\n]*\x60)`;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The workspace package a base names at a load: proven only when the file's code (comments and string text aside,
  // codeView) declares the name exactly once, as `const <base> = join(…, <a package root>)`, with no other binding
  // of it anywhere (another declaration, a destructuring, a parameter, a catch, an assignment), and the load lies
  // after that declaration inside the block that holds it. A package root is an installed tarball
  // (`'node_modules/farsight-sentinel'`) or a workspace folder (`'packages', 'sentinel'`, `'packages/sentinel'`).
  // Anything short of that is unknown, and the load keeps its area.
  const packageOf = (text, code, base, index) => {
    if (!/^[\w$]+$/.test(base)) return null;
    const name = String.raw`(?<![\w$.])${escape(base)}(?![\w$])`;
    const declared = [...code.matchAll(new RegExp(String.raw`\bconst\s+${escape(base)}\s*=(?![=>])\s*([^;\n]*)`, 'g'))];
    if (declared.length !== 1) return null;
    const others = [
      String.raw`\b(?:let|var)\s+${escape(base)}(?![\w$])`,
      String.raw`\b(?:const|let|var)\s*[{[][^=;]*?${name}`,
      String.raw`\b(?:function\s*\*?|class)\s+${escape(base)}(?![\w$])`,
      String.raw`\bimport\b[^;]*?${name}[^;]*?\bfrom\b`,
      String.raw`${name}\s*=>`,
    ];
    if (others.some((pattern) => new RegExp(pattern).test(code))) return null;
    const assignments = code.match(
      new RegExp(String.raw`${name}\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|\?\?|&&|\|\|)?=(?![=>])`, 'g'),
    );
    if (assignments?.length !== 1) return null; // the declaration's own
    // a parameter list or a catch clause naming it shadows the declaration somewhere
    for (const open of code.matchAll(/\(/g)) {
      const inner = balanced(code, open.index + 1);
      if (inner === null || !new RegExp(name).test(inner)) continue;
      const before = code.slice(Math.max(0, open.index - 40), open.index);
      const after = code.slice(open.index + inner.length + 2, open.index + inner.length + 40);
      const method =
        /\{/.test(after.trimStart()[0] ?? '') &&
        /(?<![\w$.])(?!(?:if|for|while|switch|with|return|typeof|await|in|of|new|void|delete|else)\b)[\w$]+\s*$/.test(
          before,
        );
      if (/^\s*=>/.test(after) || /\bfunction\s*\*?\s*[\w$]*\s*$/.test(before) || /\bcatch\s*$/.test(before) || method)
        return null;
    }
    // the load lies after the declaration, inside the block that holds it
    const at = declared[0].index;
    if (index <= at) return null;
    const stack = [];
    for (let i = 0; i < at; i++)
      if (code[i] === '{') stack.push(i);
      else if (code[i] === '}') stack.pop();
    const open = stack.at(-1);
    if (open !== undefined) {
      const body = balanced(code, open + 1);
      if (body === null || index > open + body.length) return null;
    }
    // the value as written (the code view blanks its literals): the declaration's own text, from the same offset
    const written = new RegExp(String.raw`const\s+${escape(base)}\s*=\s*([^;\n]*)`, 'y');
    written.lastIndex = at;
    const value = (written.exec(text)?.[1] ?? '').replace(/[,;]\s*$/, '').trim();
    const tail = new RegExp(String.raw`^join\(.*?,\s*${QUOTED}(?:\s*,\s*${QUOTED})?\s*\)$`).exec(value);
    if (!tail) return null;
    const path = [tail[1], tail[2]]
      .filter(Boolean)
      .map((part) => part.slice(1, -1))
      .join('/');
    const installed = /^node_modules\/((?:@[\w.-]+\/)?[\w.-]+)$/.exec(path)?.[1];
    if (installed) {
      const pkg = PUBLISHED.get(installed) ?? installed;
      return packages.has(pkg) ? dirOf.get(pkg) : null;
    }
    const folder = /^packages\/([\w.-]+)$/.exec(path)?.[1];
    return folder && built.has(folder) ? `packages/${folder}` : null;
  };
  const resolveLoad = (source, text, code, expression, index) => {
    const url = new RegExp(String.raw`^new\s+URL\(\s*${QUOTED}\s*,\s*import\.meta\.url\s*\)$`).exec(expression);
    const specifier = new RegExp(String.raw`^require\.resolve\(\s*${QUOTED}\s*\)$`).exec(expression);
    if (url || specifier) return [resolveFrom(source, (url ?? specifier)[1].slice(1, -1))];
    const joined = new RegExp(String.raw`^join\(\s*([\w$]+(?:\.[\w$]+)*)\s*,\s*${QUOTED}\s*\)$`).exec(expression);
    if (!joined) return null;
    const [, base, literal] = joined;
    const path = literal.slice(1, -1);
    if (path.startsWith('dist/')) {
      const pkg = packageOf(text, code, base, index); // a dist/ tail counts only under a base proven to be a package root
      const target =
        pkg && sourceOf(root, `${pkg}/dist/${path.slice('dist/'.length).replace(/\.(?:m?js|d\.ts)$/, '')}.js`);
      return target ? [target] : null;
    }
    const writes = String.raw`writeFileSync\(\s*join\(\s*${escape(base)}\s*,\s*${escape(literal)}\s*\)\s*,\s*${QUOTED}\s*[,)]`;
    return new RegExp(writes).test(text) ? [] : null;
  };
  const files = new Set(),
    dirs = new Set(),
    unresolved = [],
    areas = new Set();
  let mentions = '';
  for (const queue = [...scannerCliEntries(workflow, sentinel)]; queue.length;) {
    const next = queue.pop();
    const source = next && sourceOf(root, next);
    if (!source || files.has(source)) continue;
    if (statSync(join(root, source)).isDirectory()) {
      // a folder a test reads whole (the example application it ingests, a fixture tree), not a base path to resolve from
      if (!/^(?:|packages\/[^/]+(?:\/(?:src|test|dist))?)$/.test(source)) dirs.add(source);
      continue;
    }
    files.add(source);
    if (!CODE.test(source)) continue;
    const text = readFileSync(join(root, source), 'utf8');
    if (/^(?:scripts|packages\/[^/]+\/(?:test|scripts))\//.test(source)) mentions += `\n${text}`;
    const code = codeView(text);
    for (const { line, index, literal, expression } of loadSites(text)) {
      if (literal !== undefined) {
        queue.push(resolveFrom(source, literal));
        continue;
      }
      const targets = expression === null ? null : resolveLoad(source, text, code, expression, index);
      if (targets) {
        queue.push(...targets);
        continue;
      }
      const area = computedArea(source, built);
      if (unresolved.some(({ site }) => site === `${source}:${line}`)) continue; // two loads on one line
      unresolved.push({ site: `${source}:${line}`, area });
      for (const prefix of area) areas.add(prefix);
    }
    for (const pattern of SPECIFIERS)
      for (const [, spec] of text.matchAll(pattern)) queue.push(resolveFrom(source, spec));
    // a package's own dist/ paths; a script's are the installed Sentinel tarball's
    const own = /^(packages\/[^/]+)\//.exec(source)?.[1] ?? 'packages/sentinel';
    for (const [, stem] of text.matchAll(DIST_PATH))
      queue.push(`${own}/dist/${stem.replace(/\.(?:m?js|d\.ts)$/, '')}.js`);
  }
  if (!files.size) throw new Error('The scanner workflow names no files');
  unresolved.sort((a, b) => a.site.localeCompare(b.site, 'en'));
  return { root, files, dirs, packages: built, mentions, unresolved, areas };
}

/**
 * Whether one changed path reaches the sentinel-scanner-cli workflow, by that closure: a file it executes, or one in
 * a folder it reads whole; one in the area of a computed load; a fixture or other test data a reached test or script
 * names; a built package's other build inputs (its manifest, its tsconfig, Sentinel's rules, assets and scripts),
 * outside `src/` and `test/`; and a source path that no longer exists (deleted, or renamed away), which the closure
 * of the tree as it is now cannot rule out.
 */
function reachesScannerCli(path, scanner) {
  if (scanner.files.has(path) || [...scanner.dirs].some((dir) => path.startsWith(`${dir}/`))) return true;
  if ([...scanner.areas].some((prefix) => path.startsWith(prefix))) return true; // a computed load may name it
  const inPackage = /^packages\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!inPackage) return false;
  const [, pkg, top, rest = ''] = inPackage;
  if (!scanner.packages.has(pkg)) return false;
  if (top === 'src') return !existsSync(join(scanner.root, path)); // a source it executes is in `files` already
  if (top !== 'test') return true; // build inputs
  if (pkg !== 'sentinel') return false; // another package's own tests
  const parts = rest.split('/');
  if (parts[0] !== 'fixtures' && CODE.test(path)) return false; // a test file or helper no step runs or imports
  // test data, fixtures included: reached when a reached test or script names its folder or file
  const name = (parts[0] === 'fixtures' ? parts[1] : parts[0])?.replace(/\.[^.]+$/, '');
  if (!name) return false;
  const quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:fixtures/|['"/])${quoted}\\b`).test(scanner.mentions);
}

/** The skills trees: read only by the script tests (scripts/check-skills-mirror.mjs), never by a package's tests. */
const SKILLS = /^\.(?:claude|agents)\/skills\//;

/** The checks one changed path selects, or `null` when it selects every check. */
function pathChecks(path, inputs, isolation, scanner) {
  const checks = { validate: false, e2e: false, echo: false, sentinel: false, isolation: false };
  checks.scannerCli = scanner ? reachesScannerCli(path, scanner) : false;
  // These Markdown files are shipped in the Echo tarball, so still check packaging.
  if (
    [
      'docs/ECHO.md',
      'packages/echo/README.md',
      'scripts/pack-echo.mjs',
      'scripts/test-echo-package.mjs',
      '.echo/settings.example.json',
      '.echo/connection.example.json',
    ].includes(path)
  ) {
    checks.echo = true;
  } else if (
    [
      'scripts/npm-acceptance.mjs',
      'scripts/sentinel-release-acceptance.mjs',
      'scripts/sentinel-native-helper.mjs',
    ].includes(path)
  ) {
    // The clean npm acceptance both packages' tarballs run through in sentinel-package, and its script tests.
    // (npm-consumer.mjs, which it builds on, is shared packaging and selects everything below.)
    checks.validate = checks.sentinel = true;
  } else if (path === 'scripts/pack-sentinel.mjs') {
    // Sentinel's tarball; its review-package unit test packs it too.
    checks.validate = checks.sentinel = true;
  } else if (['packages/sentinel/README.md', 'scripts/test-sentinel-package.mjs'].includes(path)) {
    // Sentinel's tarball and its packaging; Farsight's package does not include it.
    checks.sentinel = true;
  } else if (SKILLS.test(path)) {
    // The two skills trees must stay identical: scripts/check-skills-mirror.mjs runs under pnpm test:scripts.
    checks.validate = true;
  } else if (/^(?:[^/]+\.md|docs\/.*\.md|\.(?:github|claude|agents)\/.*\.md)$/s.test(path) || path === 'LICENSE') {
    // Only known documentation locations; Markdown in fixtures can affect tests.
  } else if (path === 'scripts/synth-graph.mjs') {
    // The perf suite's synthetic workspace; the server's search and fold tests import it too.
    checks.e2e = checks.validate = true;
  } else if (path.startsWith('e2e/') || /^scripts\/(?:e2e|e2e-perf)\.mjs$/.test(path)) {
    checks.e2e = true;
  } else if (/^packages\/sentinel\/(?!test\/)/.test(path)) {
    // Sentinel's offline HTML delivery is checked by the browser-provisioned e2e job. The isolation
    // canaries exercise the execution code and everything it is built on, so any Sentinel code selects them.
    checks.validate = checks.e2e = checks.sentinel = checks.isolation = true;
  } else if (path.startsWith('packages/sentinel/test/')) {
    checks.validate = checks.e2e = checks.isolation = true;
  } else if (
    /^packages\/[^/]+\/test\//.test(path) ||
    path.startsWith('scripts/test/') ||
    /^scripts\/(?:changelog|release|release-manifest|verify-release|install-hooks|lint-commits)\.mjs$/.test(path)
  ) {
    checks.validate = true;
  } else if (/^(?:packages|examples|schemas)\//.test(path)) {
    checks.validate = checks.e2e = true;
    if (/^packages\/(?:graph|core|echo)\//.test(path)) checks.echo = true;
    // farsight-cli's closure (it must still pack and start without Sentinel) and Sentinel's own;
    // the package smoke also ingests the invoice example.
    if (inputs.has(/^packages\/([^/]+)\//.exec(path)?.[1]) || path.startsWith('examples/invoice-app/'))
      checks.sentinel = true;
    if (isolation.has(/^packages\/([^/]+)\//.exec(path)?.[1])) checks.isolation = true;
  } else {
    return null; // includes build/config/dependencies, workflows and this selector
  }
  return checks;
}

export function selectChecks(paths, { root = repoRoot, packageInputs, isolationInputs, scannerInputs } = {}) {
  let inputs, isolation, scanner;
  try {
    inputs = packageInputs ?? sentinelPackageInputs(root);
    isolation = isolationInputs ?? sentinelIsolationInputs(root);
    scanner = scannerInputs ?? scannerCliClosure(root);
  } catch {
    return all();
  } // unreadable manifests: everything
  const checks = {
    validate: false,
    e2e: false,
    echo: false,
    sentinel: false,
    isolation: false,
    recovery: false,
    service: false,
    scannerCli: false,
  };
  for (const path of paths) {
    const selected = pathChecks(path, inputs, isolation, scanner);
    if (!selected) return all();
    for (const [name, run] of Object.entries(selected)) if (run) checks[name] = true;
  }
  // The recovery smoke runs the coordinator over the same execution and store code as the isolation canaries.
  checks.recovery = checks.isolation;
  // Sentinel's process suite (packages/sentinel/test/process-suite.txt) runs only in sentinel-service and validate
  // runs the rest, so that job runs exactly when validate tests Sentinel.
  if (checks.validate) {
    const tests = selectTests(paths, { root, packageInputs: inputs, isolationInputs: isolation });
    checks.service = tests.scope === 'all' || tests.packages.includes('@farsight/sentinel');
  }
  return checks;
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * The workspace's dependency graph: package directory → its name and the directories of the packages that depend on
 * it, over every dependency field (devDependencies too, as pnpm's own workspace graph counts them).
 */
export function workspaceGraph(root = repoRoot) {
  const packages = workspacePackages(root);
  if (!packages.size) throw new Error('No workspace packages');
  // A name is written into the step outputs and onto pnpm's command line; anything else selects every check.
  for (const name of packages.keys())
    if (!PACKAGE_NAME.test(name)) throw new Error(`Unexpected workspace package name: ${JSON.stringify(name)}`);
  const dirOf = new Map([...packages].map(([name, { dir }]) => [name, basename(dir)]));
  const graph = new Map([...packages].map(([name, { dir }]) => [basename(dir), { name, dependents: new Set() }]));
  for (const [name, { manifest }] of packages)
    for (const field of DEPENDENCY_FIELDS)
      for (const dep of Object.keys(manifest[field] ?? {}))
        if (dirOf.has(dep) && dep !== name) graph.get(dirOf.get(dep)).dependents.add(dirOf.get(name));
  return graph;
}

// A test reaching into another workspace package: `packages/<dir>/dist`, `../../<dir>/dist`, or
// `join(here, '..', '..', '<dir>', 'dist')`, for the folders a package's tests can read.
const READS = 'dist|src|test|public|bin';
const REFERENCE = new RegExp(
  String.raw`(?:packages/|(?:\.\./)+)([a-z0-9][\w.-]*)/(?:${READS})(?=[/'"\x60])` +
    String.raw`|['"]\.\.['"],\s*['"]\.\.['"],\s*['"]([a-z0-9][\w.-]*)['"],\s*['"](?:${READS})['"]`,
  'g',
);

/**
 * Test files whose reference to another package's files runs only outside validate, so validate need not test them
 * when that package changes. `gate` is the condition in the file that keeps it out of validate; the selector test
 * fails if the file loses it.
 */
export const OUTSIDE_VALIDATE = {
  // The CLI's dist is read only with SENTINEL_OWNER_UI_BROWSER=1, which the e2e job alone sets (and e2e runs for
  // every package change).
  'packages/sentinel/test/owner-ui-browser.test.ts': {
    packages: ['cli'],
    gate: "process.env.SENTINEL_OWNER_UI_BROWSER !== '1'",
  },
};

function sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return []; // a package with no tests
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Package tests that read the files of a workspace package their manifest does not depend on (an ingest through the
 * parsers' dist, a spawned CLI), which pnpm's dependency walk cannot see: consumer directory → provider directories.
 * Read from every package's `test/` folder, whole-line comments ignored, so a new reference joins without editing
 * this file. Unreadable test folders throw.
 */
export function testReach(root = repoRoot, graph = workspaceGraph(root)) {
  const reach = new Map();
  for (const consumer of graph.keys()) {
    const tests = join(root, 'packages', consumer, 'test');
    for (const file of sourceFiles(tests)) {
      const relative = `packages/${consumer}/test/${file
        .slice(tests.length + 1)
        .split(/[\\/]/)
        .join('/')}`;
      const outside = OUTSIDE_VALIDATE[relative]?.packages ?? [];
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
        .join('\n');
      for (const match of code.matchAll(REFERENCE)) {
        const provider = match[1] ?? match[2];
        if (provider === consumer || !graph.has(provider) || outside.includes(provider)) continue;
        if (!reach.has(consumer)) reach.set(consumer, new Set());
        reach.get(consumer).add(provider);
      }
    }
  }
  return reach;
}

/**
 * The package tests validate runs: every package with a changed path (both sides of a rename, from the selector's
 * `--no-renames` diff), every package that depends on one (from the manifests), and the packages whose tests read a
 * selected package's files without depending on it (`also`; alone, because their own code did not change, so their
 * dependents need nothing). validate passes the names to pnpm, one `--filter` each; the selector is the only place
 * the set is worked out. A path that selects validate from outside a workspace package (root files, the lockfile,
 * `scripts/`, `schemas/`, `examples/`, workflows) or an unreadable workspace tests every package: `scope` is `all`.
 * An empty set (only the skills trees changed) is `scope: 'none'`: no package's tests; the script tests still run.
 */
export function selectTests(paths, { root = repoRoot, graph, reach, packageInputs, isolationInputs } = {}) {
  let inputs, isolation;
  try {
    graph ??= workspaceGraph(root);
    reach ??= testReach(root, graph);
    inputs = packageInputs ?? sentinelPackageInputs(root);
    isolation = isolationInputs ?? sentinelIsolationInputs(root);
  } catch {
    return EVERY;
  }
  const changed = new Set();
  for (const path of paths) {
    const checks = pathChecks(path, inputs, isolation);
    // documentation, e2e and packaging inputs, and the skills trees: no package's unit test reads them
    if ((checks && !checks.validate) || SKILLS.test(path)) continue;
    const dir = /^packages\/([^/]+)\//.exec(path)?.[1];
    if (!checks || !graph.has(dir)) return EVERY;
    changed.add(dir);
  }
  const selected = new Set(changed);
  for (const queue = [...changed]; queue.length;)
    for (const dependent of graph.get(queue.pop()).dependents)
      if (!selected.has(dependent)) (selected.add(dependent), queue.push(dependent));
  const also = [...reach.keys()].filter(
    (consumer) => !selected.has(consumer) && [...reach.get(consumer)].some((provider) => selected.has(provider)),
  );
  const names = (dirs) => dirs.map((dir) => graph.get(dir).name).sort();
  const packages = names([...selected, ...also]);
  if (!packages.every((name) => PACKAGE_NAME.test(name))) return EVERY;
  return packages.length ? { scope: 'packages', packages, also: names(also) } : NONE;
}

/**
 * The selector's step outputs. Each check is `true` or `false`; `testScope` is `packages` with at least one name,
 * or `all` or `none` with none, and every name has the strict package shape, so no value can carry a separator
 * into another output record. Anything else is written as every check and every package.
 */
export function selectorOutput(checks, tests) {
  const safe =
    Object.values(checks).every((run) => typeof run === 'boolean') &&
    ['all', 'packages', 'none'].includes(tests?.scope) &&
    Array.isArray(tests.packages) &&
    tests.packages.every((name) => typeof name === 'string' && PACKAGE_NAME.test(name)) &&
    (tests.scope === 'packages') === tests.packages.length > 0;
  const [emitted, scope] = safe ? [checks, tests] : [all(), EVERY];
  return (
    Object.entries(emitted)
      .map(([name, run]) => `${name}=${run}`)
      .join('\n') + `\ntestScope=${scope.scope}\ntestPackages=${scope.packages.join(' ')}\n`
  );
}

/**
 * The pnpm arguments validate's test step runs, from the selector's two outputs as the workflow hands them over:
 * one `--filter <name>` per package when `scope` is `packages`; `null` (no package tests) only for `none` with no
 * names; every package for anything else, including `packages` with a missing or empty list and a missing scope.
 * A name without the package shape, or (given `members`, the workspace's names) not a workspace package, throws
 * rather than reaching pnpm, where it would match nothing.
 */
export function pnpmTestArgs(scope, packages = '', members) {
  const names = String(packages ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (scope === 'none' && !names.length) return null;
  if (scope !== 'packages' || !names.length) return ['-r', 'test'];
  for (const name of names) {
    if (!PACKAGE_NAME.test(name)) throw new Error(`Unexpected package name: ${JSON.stringify(name)}`);
    if (members && !members.has(name)) throw new Error(`Not a workspace package: ${name}`);
  }
  return ['-r', ...names.flatMap((name) => ['--filter', name]), 'test'];
}

/** The changed paths: a PR's from its merge base, a push's across every pushed commit. */
export function changedPaths({ base, head, event, cwd = process.cwd() }) {
  // Only event-provided commit IDs; never accept a revision option from an input.
  if (![base, head].every((sha) => /^[a-f0-9]{40,64}$/.test(sha ?? '') && !/^0+$/.test(sha))) {
    throw new Error('No usable base/head commit');
  }
  if (!['pull_request', 'push'].includes(event)) throw new Error('Unknown event');
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  // PRs compare from their branch point, pushes compare the entire pushed range.
  const from = event === 'pull_request' ? git(['merge-base', base, head]).trim() : base;
  // No rename detection: consider BOTH the deleted old path and the added new path.
  // NUL delimiters preserve spaces/newlines; no GitHub API file-list limit.
  return git(['diff', '--name-only', '--no-renames', '-z', from, head, '--']).split('\0').filter(Boolean);
}

export function detectChecks({ root = repoRoot, ...range } = {}) {
  try {
    const paths = changedPaths(range);
    workspaceGraph(root); // an unreadable workspace, or a package name unsafe to emit, selects every check
    const scanner = scannerCliClosure(root);
    const checks = selectChecks(paths, {
      root,
      packageInputs: sentinelPackageInputs(root),
      isolationInputs: sentinelIsolationInputs(root),
      scannerInputs: scanner,
    });
    return {
      checks,
      tests: checks.validate ? selectTests(paths, { root }) : EVERY,
      reason: `${paths.length} changed paths`,
      scannerLoads: scanner.unresolved,
    };
  } catch {
    return {
      checks: all(),
      tests: EVERY,
      reason: 'Change range or workspace unavailable; running every check',
      scannerLoads: [],
    };
  }
}

/**
 * The computed loads the scanner closure met, grouped by the area each selects in its place, for the selector's
 * printed output and step summary (never `GITHUB_OUTPUT`, whose values stay strict).
 */
export function scannerLoadsText(loads) {
  if (!loads.length) return '- sentinel-scanner-cli: no computed loads in its closure';
  const byArea = new Map();
  for (const { site, area } of loads) byArea.set(area.join(', '), [...(byArea.get(area.join(', ')) ?? []), site]);
  return [
    `- sentinel-scanner-cli: ${loads.length} computed loads in its closure, each selecting its whole area:`,
    ...[...byArea].map(([area, sites]) => `  - ${sites.join(', ')} select ${area}`),
  ].join('\n');
}

function testsLine({ scope, packages, also }) {
  if (scope === 'none') return '- validate tests: no package (the script tests still run)';
  if (scope !== 'packages') return '- validate tests: every package';
  const extra = also.length ? `, with ${also.join(', ')}, whose tests read a reached package's files` : '';
  return `- validate tests: ${packages.join(', ')} (the changed packages and their dependents${extra})`;
}

/**
 * `--run-tests`: validate's test step. In CI it reads the selector's outputs from `TEST_SCOPE` and `TEST_PACKAGES`;
 * run locally with `BASE_SHA`, `HEAD_SHA` and `GITHUB_EVENT_NAME` instead, it selects the same way first.
 */
function runTests() {
  let tests;
  if (process.env.TEST_SCOPE !== undefined) {
    tests = { scope: process.env.TEST_SCOPE, packages: [process.env.TEST_PACKAGES ?? ''] };
  } else {
    const local = detectChecks({
      base: process.env.BASE_SHA,
      head: process.env.HEAD_SHA,
      event: process.env.GITHUB_EVENT_NAME,
    });
    console.log(`${local.reason}\n${testsLine(local.tests).slice(2)}`);
    if (!local.checks.validate) {
      console.log('validate is not selected for these changes; no package tests to run.');
      return 0;
    }
    tests = local.tests;
  }
  let members = null;
  try {
    members = new Set([...workspaceGraph().values()].map(({ name }) => name));
  } catch {
    // the workspace cannot be read, so membership cannot be checked: every package
  }
  const args = members ? pnpmTestArgs(tests.scope, tests.packages.join(' '), members) : ['-r', 'test'];
  if (!args) {
    console.log('No package is reached; no package tests to run.');
    return 0;
  }
  console.log(`pnpm ${args.join(' ')}`);
  const run = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (run.error) throw run.error;
  return run.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--run-tests') process.exit(runTests());
  const { checks, tests, reason, scannerLoads } = detectChecks({
    base: process.env.BASE_SHA,
    head: process.env.HEAD_SHA,
    event: process.env.GITHUB_EVENT_NAME,
  });
  const output = selectorOutput(checks, tests);
  console.log(`${reason}\n${output}${scannerLoadsText(scannerLoads)}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Affected checks\n\n${reason}.\n\n` +
        Object.entries(checks)
          .map(
            ([name, run]) =>
              `- ${{ echo: 'echo-package', sentinel: 'sentinel-package', isolation: 'sentinel-isolation', recovery: 'sentinel-recovery', service: 'sentinel-service', scannerCli: 'sentinel-scanner-cli (its own workflow)' }[name] ?? name}: ${run ? 'run' : 'skip'}`,
          )
          .join('\n') +
        (checks.validate ? `\n${testsLine(tests)}` : '') +
        `\n${scannerLoadsText(scannerLoads)}` +
        '\n\nSecret scanning and PR commit conventions run independently.\n',
    );
  }
}
