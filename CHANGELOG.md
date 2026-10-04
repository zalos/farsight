# Changelog

Every release of `farsight-cli`, newest first. Generated from conventional commits by
`scripts/changelog.mjs` when a release is cut (see [docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

Changes on `main` since the last release: `node scripts/changelog.mjs --dry-run` lists them.

## [0.3.0] — 2026-10-04

### Features

- **core:** the project graph computed once per graph and NX's own project graph read when the workspace wrote one [#39](https://github.com/zalos/farsight/pull/39) ([83b4a3b](https://github.com/zalos/farsight/commit/83b4a3b6cfa6cc2512524b7f93a8baa6225937ac))

### Fixes

- **scripts:** perf commits get a Performance section in the changelog instead of Chores [#42](https://github.com/zalos/farsight/pull/42) ([2a4468b](https://github.com/zalos/farsight/commit/2a4468bb0ca53497195daa2b6d1f95d621e99fdc))

### Performance

- **viewer:** the code map groups and filters from one precomputed index, with a toolbar project picker and app focus [#40](https://github.com/zalos/farsight/pull/40) ([8ec6a5d](https://github.com/zalos/farsight/commit/8ec6a5d75b6785936c612928d0c8c18f1a2fac7f))

### Docs

- the release-PR flow was rehearsed with v0.2.0 ([9d02033](https://github.com/zalos/farsight/commit/9d020338a2cc737f18e3174382ecf947813dba40))
- the code map performance pass in the handoff and two gotchas in AGENTS.md [#41](https://github.com/zalos/farsight/pull/41) ([79f91cd](https://github.com/zalos/farsight/commit/79f91cd1207f29c3bd468dc125b25bd26ab70712))

### Chores

- **ci:** squash-merge PRs and enforce Conventional Commits with a commits check, a commit-msg hook and a PR template [#38](https://github.com/zalos/farsight/pull/38) ([8b722ce](https://github.com/zalos/farsight/commit/8b722ce87beea8f5bda5cc40bf8ba4b217081e32))

## [0.2.0] — 2026-10-04

### Features

- **server:** map model — neighbourhood and street from the design flows and one journey summary ([875edbd](https://github.com/zalos/farsight/commit/875edbde144cecb9de519bc372d3f29108d7dcd4))
- **core:** map property words — the rail's eight tabs, the placeholder, the step bar ([e9c766f](https://github.com/zalos/farsight/commit/e9c766f1e81ae67888479647c0c235a8550e2dd7))
- **server:** map property model — one screen's eight tabs from the journey answer ([c07675a](https://github.com/zalos/farsight/commit/c07675ab9d08c79e999e744c91016001f3872bab))
- **server:** map property surface — the screen as hero, a tabbed rail, a step bar ([617e739](https://github.com/zalos/farsight/commit/617e7398147112b2912b48f5313cf3d229003ad3))
- **core:** the map surface's words — strings-map.ts, spread into the catalog ([593f9b3](https://github.com/zalos/farsight/commit/593f9b30c26b174430cff1cca8f9434b3210560a))
- **server:** the map surface — zoomable board, neighbourhood, street and the property hook ([d922656](https://github.com/zalos/farsight/commit/d9226562545280efa21a9b2aae9227c7b175ab3e))
- **server:** map property opens with the keyboard on Back ([fff0ed9](https://github.com/zalos/farsight/commit/fff0ed90d5eb9bd61a7c37c9260f2c0464d36bfb))
- **server:** map — leaving a screen by a pinch out, fits clear of the chrome ([561facc](https://github.com/zalos/farsight/commit/561facc0d4ebc130cd8f9024066ed33c80313c4b))
- **server:** map neighbourhood — bands by source, rows fitted to the stage, counter-scaled covers ([e04be91](https://github.com/zalos/farsight/commit/e04be910ceb34b57f5de06f1eeec5eff9a4bab19))
- **server:** map covers hold a two-line name, a two-line sentence and the chip row at any zoom ([33445f3](https://github.com/zalos/farsight/commit/33445f36f821291598ea20ce6a998283662c85cf))
- **core:** the map street's fold words — n more, n more calls, fewer, and their scopes ([f56fa54](https://github.com/zalos/farsight/commit/f56fa54d8c44fdced58d59adcb7a12cf7f97c25b))
- **server:** map street folds a long pathway — first three data nodes per call, first four calls per screen ([d5d0181](https://github.com/zalos/farsight/commit/d5d0181aa681ee4cfa59fc68465acf2ddfd4b527))
- **core:** data stores — WIP StoreRef, GraphNode.store, ExternalRef.store, StoreDecl ([2a1f068](https://github.com/zalos/farsight/commit/2a1f068739b01d3b7de0137f7fe7159140305e72))
- **server:** map model — the store on each data node, a reached mode, the journey's stores ([3b78c73](https://github.com/zalos/farsight/commit/3b78c7317a6a80a44931afb282742ce95dcfb84e))
- **server:** data stores on the street and the property ([74f2ff6](https://github.com/zalos/farsight/commit/74f2ff61be5ce0a809ce6a957c0be6399296ceee))
- **parsers:** data stores — store rules, externals as stores, per-method client edges ([cb61dc4](https://github.com/zalos/farsight/commit/cb61dc430e5d71bae408ff29020a71d418955d48))
- **core:** data stores in the journey — store and op on markers, system.stores, counted.stores ([694cc2f](https://github.com/zalos/farsight/commit/694cc2ff4bda57c4681fa01aea934349cdb57353))
- **mcp:** describe_node prints a node's data store and the rule that named it ([2ee4f22](https://github.com/zalos/farsight/commit/2ee4f22055f84f0c0be6b63dd2bb97281254a8e8))
- **core:** GraphStore keeps the store pass's meta per repo ([7874314](https://github.com/zalos/farsight/commit/787431496967fb245ebb817986bc788a0f58e082))
- **server:** map stores on lane P's answers — the stores chip, the legend explains every swatch ([f93732c](https://github.com/zalos/farsight/commit/f93732c6ce6e75032a8de03a1e7c105ea604d1a0))
- **core:** map store words — known from the package the code uses covers an outside system's client library too ([d16ac1c](https://github.com/zalos/farsight/commit/d16ac1cad880aff508ad46a278483d9f7db988f5))
- **core:** a call marker says when its method was assumed; the seam card prints it ([a4ce3e4](https://github.com/zalos/farsight/commit/a4ce3e433c1f13e67bd831b365b82be479dba60e))
- **core:** map keyboard, link and as-of words (§K) ([d16c344](https://github.com/zalos/farsight/commit/d16c3445bdd676737c6b9df702929d5f7daedf93))
- **server:** the Map by keyboard, by ⌘K and by link ([3910be0](https://github.com/zalos/farsight/commit/3910be09a88866befdb977953eab7ced82a62bac))
- **core:** projects and tags as facets on every node, and the project graph fold ([4718f96](https://github.com/zalos/farsight/commit/4718f96a631deeb3179b19a0b91c29cd9163b31a))
- **parsers:** discover NX / workspace projects, stamp every node, read imports between projects ([fc6bfb7](https://github.com/zalos/farsight/commit/fc6bfb74f2861b729cd3d0c7203aeb5e35b8caf2))
- **server:** GET /api/projects and /api/projects/<name>; MCP prints the project ([5f6cf2d](https://github.com/zalos/farsight/commit/5f6cf2d4498b5ed086608fd6d96480e71968c073))
- **core:** the package node kind, GraphNode.package and the diff enum grown by one ([d7c9528](https://github.com/zalos/farsight/commit/d7c95288072807c6061dab4f2960ac94c3fda1ad))
- **parsers:** bare imports become package nodes with imports edges ([4ddc696](https://github.com/zalos/farsight/commit/4ddc6967c2f4d414792f5b06c4c7887b34ad6006))
- **core:** screens reached is its own count; commits touching a set of parts ([a3eab69](https://github.com/zalos/farsight/commit/a3eab697bc1cd4380bc85eb9a38103949c32ac40))
- **server:** /api/history/touching — the application's commits for a screen's parts ([e74f798](https://github.com/zalos/farsight/commit/e74f7986cfd7d5ea1c134af564f84408ae3841ff))
- **core:** packagesOf and importersOf — every package with its ranges, importers and journeys ([aba256e](https://github.com/zalos/farsight/commit/aba256e6f30153ac4a7940fc293b3b6c20e78348))
- **core:** the map's legend, link and business words (§L) ([c50bbbf](https://github.com/zalos/farsight/commit/c50bbbff92bb0ddc2bb9c3dc20332061c75de686))
- **server:** the map canvas normalises wheel input and holds gestures at the owner's stops ([807d331](https://github.com/zalos/farsight/commit/807d331bb3ae532c04fc3f83d5089cb93a56c0b3))
- **parsers:** a workspace package names the NX project it resolves to ([e9b0676](https://github.com/zalos/farsight/commit/e9b0676a73ec555876a629823aa4ec89aeecb4db))
- **server:** GET /api/deps and /api/deps/where ([fb37837](https://github.com/zalos/farsight/commit/fb3783738111b3410ad68224c2edd805ac8267e4))
- **mcp:** describe_node prints a package's scope, range, importers and journeys ([4dc31a6](https://github.com/zalos/farsight/commit/4dc31a6260c8af2eb5cb4ab4cf6e32ad178249b7))
- **cli:** farsight deps list and farsight deps where ([e1780c6](https://github.com/zalos/farsight/commit/e1780c60239d0e03b1a10fe94f6eae53c0c91a4d))
- **server:** code map by project and package — WIP: the pure model, the Map's band by domain, the words ([fb3d7ac](https://github.com/zalos/farsight/commit/fb3d7ac3b0fca57b1ef41102865861b0ce397184))
- **server:** map affected mode — WIP core reach fold, /api/impact reach=1, /api/history/commit ([92639a2](https://github.com/zalos/farsight/commit/92639a2c8511738a8449458b89119a32fba4600e))
- **server:** the Map's Affected mode — bar, dimming at every altitude, the Affected tab ([410e9bf](https://github.com/zalos/farsight/commit/410e9bfd9b4c399011009d9ee30a3a54f17665b1))
- **server:** the code map grouped by project and tag, packages drawn, the two views ([e34af32](https://github.com/zalos/farsight/commit/e34af3205a5aa0321085e95c031badd8edf7dd93))
- **core:** the project picker's words — search, match counts, groups, chips, fast travel ([a79927b](https://github.com/zalos/farsight/commit/a79927b1d85c4f985d0fd9af1fecb6837173e69c))
- **server:** a searchable project picker everywhere a project is picked ([91a4600](https://github.com/zalos/farsight/commit/91a4600a9d0c300cb857c59c1158e8d41f2bb38b))

### Fixes

- **server:** map property Changes tab prints the severity in the catalog's words ([62d0be6](https://github.com/zalos/farsight/commit/62d0be693d9f215b59a485b814d1bcb8bb6ba1d2))
- **server:** the property hero sizes the same on every tab and never covers its chips ([1887042](https://github.com/zalos/farsight/commit/1887042ce84d9467581f442ae590307c5ca9766d))
- **server:** map property on a real screen — the whole picture, clamped text, capped lists ([53e68ba](https://github.com/zalos/farsight/commit/53e68ba8b8df62c17b34a2b30388aa95e1daa698))
- **server:** map stores — a third party's name as written, the store swatch clear of the global chip style, reached never listed for both ([665b8ad](https://github.com/zalos/farsight/commit/665b8ad1d7902ed8bdefec3228823b3f58c2b5c4))
- **parsers:** a fetch wrapper's callers are the fetch sites; a method the code never names assumes GET only when the path needs it ([af78fca](https://github.com/zalos/farsight/commit/af78fca0585ac0fa4facbbdd4ac664f2ce2b2834))
- **e2e:** the map stubs step aside when the page has moved on; handoff for the data-stores pass ([3ad58b2](https://github.com/zalos/farsight/commit/3ad58b25170ad1657de804611ca88a0990f30ddf))
- **server:** a cover's chips are never tab stops, even before the tooltip observer runs ([2a89fcd](https://github.com/zalos/farsight/commit/2a89fcd754abdef8289ee2617a5fa3006b779c0a))
- **server:** the Map says its units — screens reached, evidence beside tests, owner, ERP, commits ([effc911](https://github.com/zalos/farsight/commit/effc911f0ffe08f19338d42dad6291eafc400dd5))
- **server:** the map draws a legend, routed labelled links, whole words, and business words ([e6ebc67](https://github.com/zalos/farsight/commit/e6ebc67973b879cb1d64cf2d2b139db8e7116c70))
- **server:** the map stops at a journey, its calls and one screen; Fit keeps the journey; the toolbar is opaque ([d28aeae](https://github.com/zalos/farsight/commit/d28aeae109bfb5ebaaf3eaa2d6ec6da42e2014ef))
- **parsers:** tsconfig comments are stripped outside strings only ([e27e223](https://github.com/zalos/farsight/commit/e27e223aca51ec466299279eada950d9205247e0))
- **server:** one counted import after the merge; fast travel skips module and package nodes ([b18f894](https://github.com/zalos/farsight/commit/b18f894999c3a4cd80bc39986595f2b5d453406e))
- **server:** the street head's chips sit above the street layer so their tips open on hover ([5eb8bce](https://github.com/zalos/farsight/commit/5eb8bcea84a4609b869d3ee7afc4295a77e45e29))
- **cli:** print a package's ranges only when its package.json files disagree ([66c4d5e](https://github.com/zalos/farsight/commit/66c4d5e732554a0380aff0f5f4821c1e4d362a91))
- **server:** cover chips fold once placed; the crumb keeps its row; test names in words ([e7c1027](https://github.com/zalos/farsight/commit/e7c1027d897725cd04dcac0dd2076033df86d0c0))
- **server:** a business test name drops a route left in its words ([9cf6791](https://github.com/zalos/farsight/commit/9cf67911252f2658917933873c04704d82679257))
- **e2e:** declare the fixture module so the e2e typecheck accepts the projects spec ([caea4fe](https://github.com/zalos/farsight/commit/caea4fe2017c860a2a07e596b06e967063fca5b5))
- **e2e:** drop the now-unused ts-expect-error on the fixture import ([5e91ae5](https://github.com/zalos/farsight/commit/5e91ae556253de7056fb32a41b8cbfb40682f897))
- **examples:** raise vitest and nx past the dependabot advisories ([4b43e2e](https://github.com/zalos/farsight/commit/4b43e2e9620bc1dadfde44f7793a57fcf1c0d9f8))
- **server:** the Map keeps the journey the reader opened, keeps its keys and its zoom anchor ([ea11cd6](https://github.com/zalos/farsight/commit/ea11cd686d980467eca757f8f4d57b881056503d))
- **server:** the Affected mode reads at board altitude — fit these, list these, lit covers, distinct screens ([4d418c1](https://github.com/zalos/farsight/commit/4d418c1bde7be2f580587d237c5da6565d93da66))
- **server:** the Map's legend opens as a strip below the toolbar, call evidence reads without colour, j keeps the street's height ([c15910c](https://github.com/zalos/farsight/commit/c15910ccf912d1a512f989336fc593c8372974f4))
- **server:** scope words, the risk headline, pan bounds and the code map's boxes ([738be08](https://github.com/zalos/farsight/commit/738be088d65aa23325b257f11529460e609b1378))
- **server:** the picker's document listeners wait for a document that has them ([5df9070](https://github.com/zalos/farsight/commit/5df90704ea63f0ba539e07aab1fd9aeb39cff86f))
- **server:** the Projects list stands taller than Tags and Depends on in the scope menu ([bc790ce](https://github.com/zalos/farsight/commit/bc790ce2ae4bb9ab3538fab16ae324db1edbc3bc))

### Docs

- **proposals:** map view — neighbourhood, street, property, with the agreed prototype ([a20363a](https://github.com/zalos/farsight/commit/a20363ab933354a52d78b939cf1ede0cb33ef17a))
- the map surface — MAP-VIEWER section, COUNTS rows, ADR 10, roadmap line ([2d78feb](https://github.com/zalos/farsight/commit/2d78febac0748bbbc7d83441bb537a7c2763e8e1))
- map property — the hook, the eight tabs and what each reads, its counts ([37f1c2e](https://github.com/zalos/farsight/commit/37f1c2e5c6963a5f271f4777f451c797c9ad1229))
- the map's neighbourhood layout rule and counter-scaled covers ([0af4575](https://github.com/zalos/farsight/commit/0af4575a794554448c0171694c1562fd1d1d50a8))
- map property on a real screen — the clamp, the caps and their numbers ([aaa0562](https://github.com/zalos/farsight/commit/aaa05627d37fc2494f7d3efee3e0486c463804dc))
- the map street's fold rule and its two fold numbers ([3f90b08](https://github.com/zalos/farsight/commit/3f90b085c8df0d20debe183b67f20fdd97eba4fd))
- handoff for the map-view pass — current state, what shipped, next work ([eccd5ae](https://github.com/zalos/farsight/commit/eccd5aea21ffc899cca246aa8590981e7a0b7e40))
- **proposals:** data stores — name the store a record lives in, draw store-like externals with reads and writes ([a3a083f](https://github.com/zalos/farsight/commit/a3a083fe8be784a3ba8944cd4e27d146db94ab33))
- data stores on the map — the street, the card, the property, and no new number ([6c17cca](https://github.com/zalos/farsight/commit/6c17cca6338fc71308c3d9ef6ec0e87b39d5363f))
- **proposals:** map pass 2 — the swarm's findings and blast radius; dependencies and NX ([bba5e96](https://github.com/zalos/farsight/commit/bba5e96b75b96b2b50175a8545e3c417e067874d))
- the Map's key table and link grammar ([38729d0](https://github.com/zalos/farsight/commit/38729d0cb56577988fdce5035614716cd606e9e9))
- projects and tags — the counts ledger, the package map, getting started, roadmap ([385a0bc](https://github.com/zalos/farsight/commit/385a0bcfce7433539d4a79748357b518c9b92ba5))
- the Map's units, evidence words, owner, ERP and commits in the ledger and the viewer map ([5b77481](https://github.com/zalos/farsight/commit/5b774811e7171a7b190293b6d9793d00a60d5f98))
- the owner example names a fixture team ([4c26632](https://github.com/zalos/farsight/commit/4c26632138fc453931cc6d28bc75fefd509272d6))
- the map's stops, opening frame, edge cues, chrome band and the reusable canvas engine ([5a9aa66](https://github.com/zalos/farsight/commit/5a9aa66752ba2f2e48338fc02c9351f99ec7b519))
- dependencies in the package map, the counts ledger and the roadmap ([7151c2b](https://github.com/zalos/farsight/commit/7151c2bd63823d741158ef5a4c2e7313d16addf7))
- the map's legend, routed links, whole words and business lens (lane L) ([6689ba2](https://github.com/zalos/farsight/commit/6689ba25265e097ad65785e1a003ad9e55659a14))
- the code map by project and package — counts ledger, viewer map, roadmap, kind colour ([2b55010](https://github.com/zalos/farsight/commit/2b55010d03009e8f2908f3af9dff0675622163b0))
- handoff for map pass 2 — current state, what shipped, swarm round 2, next work ([cb72b76](https://github.com/zalos/farsight/commit/cb72b76178fe817753cb56775187e3a193532909))
- the Map's round 2 in MAP-VIEWER and COUNTS; the property rail's tips open beside it ([7108443](https://github.com/zalos/farsight/commit/7108443fd5ecd3d5b6f618c96cb59406cfc9e4fd))
- handoff — round-2 fixes landed, state table on 5cfbe89 ([b38aab1](https://github.com/zalos/farsight/commit/b38aab17579066cde1f7a4c18b7a73bd89119f48))
- the project picker in MAP-VIEWER and its numbers in COUNTS ([5c9fd59](https://github.com/zalos/farsight/commit/5c9fd59cd45c9e536650903b87ad0916ab336853))
- handoff at session close — the project picker, state table on 8e1c134 ([5708c59](https://github.com/zalos/farsight/commit/5708c5937e4c0cbd1dd04ae1bb96681c78385545))

### Tests

- **e2e:** map property — hero, typed tab counts, calls by service, placeholder, step bar, business words ([5f426bb](https://github.com/zalos/farsight/commit/5f426bbd449571b7a6f1dece38ab1b627b6a1656))
- **e2e:** map street — flag, districts, street, plumbing, property hook, snap, card, business lens ([f2fcd32](https://github.com/zalos/farsight/commit/f2fcd32c6e0cda678ba085f74ccd5e68c4222b91))
- **e2e:** map neighbourhood at the fit — one band, no overlap, names at 12 px or more, part-of on hover ([6585f44](https://github.com/zalos/farsight/commit/6585f44435869da2d12b8bb8c0d32f48b029906f))
- **e2e:** map property on a real-sized screen — whole picture, clamp, caps, folds ([d1d9d9d](https://github.com/zalos/farsight/commit/d1d9d9dde63926ab6b0d2d5daadbc3413c17614e))
- **e2e:** map street folds — a stubbed six-call screen and an eight-record call, opened without overlap ([bdb202d](https://github.com/zalos/farsight/commit/bdb202d9ee138595a85a683ca2753212410ec190))
- **e2e:** data stores on the street and the property ([3c33fa0](https://github.com/zalos/farsight/commit/3c33fa0a407304390c44fd2ccef6fb606afeaef2))
- **parsers:** data stores through the journey; docs: MAP-PACKAGES store pass and per-method client edges ([3cc3e5e](https://github.com/zalos/farsight/commit/3cc3e5e295a9a6a15fd0d2ed0de0e56149474b94))
- **e2e:** map keys, fast travel and the link round-trip ([aa4fd2f](https://github.com/zalos/farsight/commit/aa4fd2f0aef921db924d1061bc09199c1c17d321))
- **parsers:** the invoice example declares its packages and imports one library by alias ([573f80c](https://github.com/zalos/farsight/commit/573f80c0c55dc29f7ca7214de3642b46e4a9c80e))
- **e2e:** the Map's numbers say their units — reached, evidence, owner, ERP, commits ([a693eec](https://github.com/zalos/farsight/commit/a693eec6f3fb469593b0083284b0b2686593dc1d))
- **e2e:** four wheel profiles reach the same map stops; Fit, the open frame, edge cues, the chrome band ([1d7faf7](https://github.com/zalos/farsight/commit/1d7faf7b1cc6d062b313761537334151b0d0877b))
- **e2e:** the map's legend, routed links, whole words and business words ([fa0252c](https://github.com/zalos/farsight/commit/fa0252cdb1930fcc560f227538b2f87b3545a37d))
- **core:** the dependency folds, a package as an impact seed, and the nodeKind enum pinned ([93e07e6](https://github.com/zalos/farsight/commit/93e07e6e1a704882b9d429a6f8d107de4ba14a4a))
- **e2e:** the fixture graph's node total counts its packages and module nodes ([e2d8299](https://github.com/zalos/farsight/commit/e2d829983884c6c2c02cd9764c7c891010348dac))
- **parsers:** the NX example's design manifest and journeys sit under no project ([6a7ae64](https://github.com/zalos/farsight/commit/6a7ae64a9262d016754597d948205c9432ac5cb1))
- **e2e:** code map by project and package, on the fixture and a two-source workspace ([6162956](https://github.com/zalos/farsight/commit/61629562ee03699268bf182cff8d096b8990c54b))
- **e2e:** the Affected mode on the fixture; docs: its counts and its viewer section ([a7179fb](https://github.com/zalos/farsight/commit/a7179fbe08eca8817e186341d89d4856acfeddb2))
- **e2e:** the project picker — narrowing, groups, multi-select to ?project=, chips, keyboard, single-select views, fast travel ([59ec60d](https://github.com/zalos/farsight/commit/59ec60d380616339536ff12a3794b81bfc38b5d1))

## [0.1.2] — 2026-10-03

### Features

- **release:** release.mjs --no-tag, --branch and --commit-notes for a release PR ([c289998](https://github.com/zalos/farsight/commit/c289998f2ccfbb1240afb5acb9c6e4c4d47c85f2))
- **release:** release PR flow under branch protection — release.yml opens it, publish.yml tags and releases ([03f6389](https://github.com/zalos/farsight/commit/03f6389b30b7cb6a57c03c4c4b90741766d2100f))

### Fixes

- **work:** leave an item at the cached revision alone on pull ([ad68e67](https://github.com/zalos/farsight/commit/ad68e67d2305658b1281c89d872c8163c64cb373))
- **work-jira:** zero the recorded XSRF tokens and tenant UUIDs in fixtures; add a gitleaks config ([1a96aed](https://github.com/zalos/farsight/commit/1a96aed61974f7b96acaf02f57e7c24679646ca4))
- **work-jira:** markdown → ADF edges, gateway retries, negative Retry-After ([ec7a9b6](https://github.com/zalos/farsight/commit/ec7a9b6ec38584ee55325bf392411d39ac3dd096))
- **server:** refuse rebound Host names and cross-origin writes; validate PUT /api/settings ([276bae7](https://github.com/zalos/farsight/commit/276bae77e083cfb85786908d7a63474d3808164c))
- **deps:** refresh the MCP SDK's transitive deps past their advisories ([72b5423](https://github.com/zalos/farsight/commit/72b542306c30958d59c042f653631fba2c578f23))
- **cli:** work --help and a bare work print the work usage without touching the workspace ([29ff4c5](https://github.com/zalos/farsight/commit/29ff4c59e3648f956ca038a9e995fd907816b50e))
- **work-azdo:** never replay a write, keep the feed watermark, bullets keep their text ([2e089c3](https://github.com/zalos/farsight/commit/2e089c3dca484e10bf3adf136dfdcf57f3d7afb2))
- **core:** a squash merge's trailing (#58) is a PR number, not an ADO work item ([1d01907](https://github.com/zalos/farsight/commit/1d019077ab85e305e49a50f419e7be7d01c65e8c))
- **work-jira:** a named transition target must be the category the gate checked ([e4bea44](https://github.com/zalos/farsight/commit/e4bea44af23b450485cdabad5ba7f14a4c817f11))
- **work:** of the grants that allow a write, one needing no confirmation wins ([81f9b16](https://github.com/zalos/farsight/commit/81f9b166b678d0343c95907e4140e38c48861783))
- **server:** the outbox applies a request at most once; HUD moves carry their category ([6b745e0](https://github.com/zalos/farsight/commit/6b745e02cc2fc70bb83a7273180a3baae3175232))
- **server:** quote event-handler arguments as JS, not only as HTML ([0d8736e](https://github.com/zalos/farsight/commit/0d8736e007f140b3e8ce338293d127430d923716))

### Docs

- CI status badge at the top of the README ([9833f83](https://github.com/zalos/farsight/commit/9833f8397c0e8208b817f91be8f31ad9d348df8b))
- CI.md — what runs, locally the same, artifacts, e2e env knobs ([e7f7817](https://github.com/zalos/farsight/commit/e7f78173ae6523e6818d912632673ad88e5368b1))
- CI.md carries the measured runner times ([dc8d9bd](https://github.com/zalos/farsight/commit/dc8d9bdba247819e20f0434af1a0cc4da09bc0e2))
- on-demand releases and CI are live — v0.1.1 published and consumer-tested ([f881e06](https://github.com/zalos/farsight/commit/f881e06a8445edbfb70a0b1c7d6a58bd29cdda2e))
- releasing through a release PR — two workflows, RELEASE_TOKEN, the rehearsal ([c4d32ab](https://github.com/zalos/farsight/commit/c4d32ab6e07596b22aa39e6daaecdc071f5eebc0))
- refresh README layout and status, close done roadmap items, fix dead links ([77eecc1](https://github.com/zalos/farsight/commit/77eecc1a81867f549f0bf96058a96a42f1ab6852))
- add CONTRIBUTING with branching, commits, CI, local config twins and LFS ([2627c2e](https://github.com/zalos/farsight/commit/2627c2ee24d2c75c1ab3a54f654473ea68f7d3da))
- AGENTS names the local-config twins rule ([73dafbb](https://github.com/zalos/farsight/commit/73dafbb5db215da22d16886a0446813bc16a2fe0))
- SECURITY.md — how the viewer renders untrusted text ([3161fec](https://github.com/zalos/farsight/commit/3161fec0bb96f14e91a549162f27b1c4323706d4))

### Chores

- build, typecheck, test, string lint and e2e on every push and PR ([5b49129](https://github.com/zalos/farsight/commit/5b49129f0d28cd9ac541d1ad4fa6efb497be5ac4))
- actions on their Node 24 majors ([d412f85](https://github.com/zalos/farsight/commit/d412f8541b07a319c24b6a94d7bcdc8aae3e1814))
- scrub PII and real-looking names from examples, fixtures and docs ([91ec316](https://github.com/zalos/farsight/commit/91ec31642e5e9eaf401da17798e1e8297a1c349b))
- check out with lfs: true in ci, release and publish ([157e172](https://github.com/zalos/farsight/commit/157e172f4b5daf8faa293b91923087b5ab8f6901))
- track binary files with Git LFS ([5c4468c](https://github.com/zalos/farsight/commit/5c4468cb2438256ce93a309d09da8ecc7d54165d))
- scan commits for secrets with gitleaks; docs: SECURITY.md ([46206ce](https://github.com/zalos/farsight/commit/46206ced406e36f1db49e7394eee46613ab235b9))

### Other

- KAN-8: list and count a commit once, and forget commits git no longer has ([f5aa9b7](https://github.com/zalos/farsight/commit/f5aa9b7c8bec345ffb341e1839c307a13f4e67f9))

## [0.1.1] — 2026-10-01

### Features

- **release:** changelog and release notes from conventional commits ([6951fe8](https://github.com/zalos/farsight/commit/6951fe8a172077a8449d1f901ee0940f3a407132))
- **release:** release.mjs bumps, writes the changelog, commits and tags ([852176d](https://github.com/zalos/farsight/commit/852176de2d4514739f55c5cd6776dc050ea11ef4))
- **release:** on-demand release workflow with a smoke-tested tarball ([4fb4ff6](https://github.com/zalos/farsight/commit/4fb4ff650af7fc7467ccf62bbeac98c7672cd556))

### Fixes

- **release:** print a seed commit as a short sha ([fe53d90](https://github.com/zalos/farsight/commit/fe53d90bd652477a8c3a3b04f855571c11fac19e))

### Docs

- how to cut a release and install one ([bd58c3f](https://github.com/zalos/farsight/commit/bd58c3f2c65cd166c70684115628acb5cbd33cdf))

## [0.1.0] — 2026-10-01

### Chores

- keep owner-only notes under .private/, ignored ([2f4f91f](https://github.com/zalos/farsight/commit/2f4f91f4f4829a75da948b39593cd6be92457cf8))

### Other

- KAN-5: the source card names its tracker once ([47c7442](https://github.com/zalos/farsight/commit/47c7442416a2f20f5113fa05c8705d440d4fce35))
- Farsight — initial public commit ([8e8937b](https://github.com/zalos/farsight/commit/8e8937bc725bbb22dae547daf072c01385e5926d))
- KAN-6: every source card says who the tracker knows us as ([1edb19f](https://github.com/zalos/farsight/commit/1edb19f108661b36116a37e3d86d2c8d635d1536))
- #KAN-7 the live test cleans up its label ([5ed8fdd](https://github.com/zalos/farsight/commit/5ed8fdd140a7e1b5f112c142603f4e74f12be99e))
