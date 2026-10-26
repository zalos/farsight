// Prettier formats JavaScript and TypeScript only for now (see .prettierignore). Each option matches what most of
// the repository already writes, so a formatting PR changes spacing and line breaks, never the program.
/** @type {import('prettier').Config} */
export default {
  printWidth: 120, // the width the clean packages already use (p90 ≈ 121 outside Sentinel)
  singleQuote: true, // 94–100 % today; several tests match source text with single quotes
  semi: true,
  trailingComma: 'all', // every multi-line literal already ends with a comma
  arrowParens: 'always', // Prettier's default; what core, server, the viewer and e2e write
  quoteProps: 'preserve', // never turn 'a': into a: — keeps a formatting PR AST-identical
  objectWrap: 'preserve',
  embeddedLanguageFormatting: 'off', // never touch code inside template literals (worker sources, HTML)
  endOfLine: 'lf',
};
