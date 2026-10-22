# Advisory adapter fixtures

Original synthetic data written for Sentinel's OSV adapter tests (MIT, like the package). Every package name is a
made-up `sentinel-fixture-*` (npm) or `org.example.sentinel:*` (Maven) name, and every advisory is a made-up
`SENTINEL-FIXTURE-*` record in the OSV schema; none describes real software. Dependency files keep non-manifest names
(`package-lock-json.fixture`, `pnpm-lock-yaml.fixture`, `pom-xml.fixture`, `bom-cdx-json.fixture`) so no package manager,
workspace tool or dependency alert treats them as real manifests. The tests write their real names only inside a
temporary captured tree, and nothing is ever installed.

- `inputs/`: an npm lockfile (v3), a pnpm lockfile (v9), a Maven manifest with exact, property, range and managed
  versions, and a CycloneDX SBOM with resolved direct and transitive Maven components.
- `advisories/`: the synthetic advisories. Snapshot 1 is 0001, 0002, 0003 and 0005; snapshot 2 adds 0004, an advisory
  for a component the source already had, so the same source meets a new advisory.
