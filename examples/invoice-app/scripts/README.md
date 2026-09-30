# invoice-app fixture scripts

`node examples/invoice-app/scripts/make-coverage.mjs` (after `pnpm build`) regenerates the
fixture's run artefacts from the fixture's own source:

- writes `coverage/coverage-final.json` — istanbul-shaped, with the declaration lines read
  from the same oxc parse the graph uses, so editing `src/server/invoiceService.ts` can no
  longer silently break the observed edges;
- stamps `farsight.sourceDigest` (the digest `farsight digest --repo invoice-app` prints)
  into that file and into `coverage/vitest-results.json` and `e2e/results.json`, so all three
  reports prove "unchanged since the run".

Run it whenever anything under `examples/invoice-app` that ingest walks changes — the parser
test *the fixture's coverage report is current* fails and names this command when you forget.
`e2e/coverage/coverage-final.json` is declared in `farsight.config.json` and deliberately does
not exist: it is the missing-artefact blind spot the tests assert on.
