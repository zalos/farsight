# @farsight/code-parser

Repository code extraction for Node 24+ ESM, with TypeScript declarations. MIT licensed.
Uses the existing Oxc 0.138.0 native TS/JS parser and the ABI-matched Java grammar/runtime from Microsoft's
`@vscode/tree-sitter-wasm` 0.3.1. It does not depend on Farsight's application packages.

```js
import { writeFileSync } from 'node:fs';
import { createParser } from '@farsight/code-parser';
import { tsJsAdapter } from '@farsight/code-parser/adapters/tsjs';
import { javaAdapter } from '@farsight/code-parser/adapters/java';
import { serializeGraph } from '@farsight/graph';

const parser = createParser({ adapters: [tsJsAdapter, javaAdapter] });
const result = await parser.parseRepository({
  root: './checkout',
  sourceId: 'invoice-service',
  include: ['src/**'],
  exclude: ['src/generated/**'],
  testFiles: 'exclude',
  limits: { maxFiles: 10_000, maxFileBytes: 4 * 1024 * 1024 },
});
writeFileSync('analysis.json', JSON.stringify(result));
writeFileSync('graph.json', serializeGraph(result.graph));
if (!result.analysis.complete) console.error(result.analysis.diagnostics);
```

The result is deeply frozen and contains a portable graph, schema version, per-file outcomes, structured
diagnostics, capabilities/limits, parser and adapter versions, all observed input fingerprints, and one SHA-256
analysis fingerprint. The root directory and wall-clock dates are excluded. Identical inputs under the same
explicit `sourceId` produce identical canonical artifacts after relocation or mtime-only changes. Use
`canonicalJson(result)` from `@farsight/graph` for canonical artifact JSON. A second process can load the saved
graph with `deserializeGraph()` and run structural analysis without loading this parser.

The fingerprint covers the bytes actually read, successful and missing resolution probes, directory entries,
dependency manifests/lockfiles, TS configuration, explicit extraction options, resource limits, adapter order
and versions, supplied input identities, and the analysis outcome. Reads are cached for the duration of a run;
the bytes hashed are the bytes parsed. The directory fingerprint deliberately invalidates conservatively
when filenames change. It is not an atomic filesystem snapshot: analyze a stable checkout. Farsight's existing
`sourceDigest` remains a separate test-freshness signal, not a cache key for this artifact.

`include`/`exclude` match relative paths (`*`, `**`, `?`); includes select files without preventing descent to
their directories. Empty `include` selects nothing. Build/vendor/hidden directories and declaration files are
excluded. Test files are ordinary source by default; `testFiles: 'exclude'` applies the existing path/import
classifier, with optional `testGlobs`. These options do not enable test reports or other enrichment.

Default limits are 10,000 source files, 4 MiB per input, 128 MiB total input bytes, 100,000 directory entries and
60 seconds. They are configurable positive integers. `signal` accepts an AbortSignal. Cancellation/time limits
are cooperative between operations; a synchronous native parse is not preempted. Oversized, failed, unsupported,
unreadable and cancelled inputs remain explicit. `complete` means the selected supported file analysis finished
without reported gaps. It does **not** prove exhaustive call resolution, control flow, data flow or security.

Built-in reads stay beneath the source root, refuse symlink components (including in-root links), cache source
bytes, and never execute code, package scripts, NX, Git, a network request or an enrichment service. Out-of-root
TS configuration is refused with a diagnostic. On-disk config changes cannot enable external access. Unsupported
source languages are reported. Arbitrary custom adapters are trusted JavaScript, not sandboxed plugins.

TS/JS extracts symbols, call/render/HTTP/data relationships, annotations, and existing resolution evidence.
Java retains the existing Spring/JPA/security heuristics. Repeated resolved call sites retain their positions and
available conditions in `edge.occurrences`; Farsight keeps its relationship-level view. Evidence is syntax-based;
unresolved alternatives and confidence remain meaningful. Cross-source host matching is not provided here.

Farsight uses the same installed adapter implementation through the instance's `extractRepository(root,
options)` composition API. That low-level API returns the original fragments and deliberately retains legacy IO,
metadata and option semantics; it is **not** the bounded portable API. Farsight loads configuration before it,
applies configuration once, then adds routes/design/stores/tests/Storybook/projects in the existing order.
Independent consumers should use `parseRepository`. No mutable global adapter registry is used.

Public exports: root API; `adapters/tsjs`; `adapters/java`; `support` (the named low-level discovery, syntax,
annotation and IO helpers shared with Farsight); and `package.json`. Register custom adapters with a unique id,
version, extensions and asynchronous `ingest`. Inside `parseRepository`, the `support` helpers `collectFiles`,
`readFileSync`, `statSync`, `readdirSync`, `checkpoint`, `fileStatus` and `parseError` use the current isolated read
context. A custom adapter must use them to honor bounds and account for its files; direct filesystem/network
access bypasses that contract. Explicit external inputs must be immutable and identified in `inputs`.

Install optional dependencies: Oxc needs the platform's native binding. Java's runtime/grammar loads from the
installed dependency, without a compiler or download at parse time. The package test matrix targets Linux x64
and macOS; other Oxc-supported platforms are not a verified support claim for this first release.

See `docs/PARSER-LIBRARIES.md` in the repository for building tarballs, checking a clean external consumer and
the independent paired library release workflow. Registry names remain subject to the owner's npm access.
