// An import resolver for eslint-plugin-boundaries (resolver interface version 2, read by eslint-module-utils).
// TypeScript sources under NodeNext import their siblings by the emitted name (`../store/objects.js`), and the
// default Node resolver looks for that `.js` file, which exists only in `dist/`. This resolver answers a relative
// specifier with the source file it names: the specifier itself when it exists, else the same path with `.js`,
// `.mjs` or `.cjs` read as `.ts`, `.mts` or `.cts`. A bare specifier (`node:fs`, `@farsight/core/...`) is left
// unresolved, so the boundaries rule treats it as an external module rather than one of the package's elements.
'use strict';

const { statSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const SOURCE_EXTENSION = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

exports.interfaceVersion = 2;

/** Resolves a relative specifier from `file` to an existing source file; anything else is not found. */
exports.resolve = (source, file) => {
  if (!source.startsWith('./') && !source.startsWith('../')) return { found: false };
  const target = resolve(dirname(file), source);
  if (isFile(target)) return { found: true, path: target };
  const extension = Object.keys(SOURCE_EXTENSION).find((e) => target.endsWith(e));
  if (extension) {
    const typed = target.slice(0, -extension.length) + SOURCE_EXTENSION[extension];
    if (isFile(typed)) return { found: true, path: typed };
  }
  return { found: false };
};
