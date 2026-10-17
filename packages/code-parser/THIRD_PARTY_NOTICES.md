# Third-party dependencies

This package depends on, rather than bundles or modifies, these open-source distributions:

- `oxc-parser` 0.138.0 and its platform binding: MIT, https://github.com/oxc-project/oxc/tree/main/napi/parser.
- `@vscode/tree-sitter-wasm` 0.3.1: MIT, https://github.com/microsoft/vscode-tree-sitter-wasm.
  Its installed package provides the runtime, prebuilt Java grammar, license and upstream component manifest.
- `@farsight/graph` at the paired library version: MIT. Its dependency notices are shipped with that package.

Dependency distributions retain their own license files. No native or WASM binaries are copied into this tarball.
