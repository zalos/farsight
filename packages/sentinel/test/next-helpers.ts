// PR 14 lockfile fixtures. A supported package is recorded exactly as the public registry recorded it for PR 01
// (version, tarball URL, the pinned integrity); any other version gets a well-formed synthetic integrity, so a
// "near neighbour" lock is a registry lock in every respect except the version. Built as text inside temporary trees
// only: no manifest or lockfile is committed, so nothing is discovered or installed.
import { createHash } from 'node:crypto';
import { NEXT_SUPPORT } from '../dist/frameworks/next/index.js';

export const VERSIONS = { next: '14.2.25', react: '18.3.1', 'react-dom': '18.3.1' };

export const integrityOf = (name: string, version: string): string => {
  const pin = (NEXT_SUPPORT.packages as Record<string, { version: string; integrity: string }>)[name];
  return pin && pin.version === version
    ? pin.integrity
    : `sha512-${createHash('sha512').update(`synthetic ${name}@${version}`).digest('base64')}`;
};

export const registryEntry = (name: string, version: string) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  integrity: integrityOf(name, version),
});

/** An npm lockfile v3 with registry entries for `pkgs`, plus raw `extra` entries (which may override). */
export const npmLock = (pkgs: Record<string, string> = VERSIONS, extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      name: 'fixture',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', version: '0.0.0', dependencies: pkgs },
        ...Object.fromEntries(Object.entries(pkgs).map(([k, v]) => [`node_modules/${k}`, registryEntry(k, v)])),
        ...extra,
      },
    },
    null,
    2,
  ) + '\n';

/** A pnpm 9.0 lockfile: importers → their next version, react 18.3.1, and a packages section with integrities. */
export const pnpmLock = (importers: Record<string, string>, resolution?: (name: string, version: string) => string) => {
  const res = resolution ?? ((n: string, v: string) => `{integrity: ${integrityOf(n, v)}}`);
  const versions = new Set<string>();
  const body = Object.entries(importers).flatMap(([imp, next]) => {
    versions.add(`next@${next}`);
    return [
      `  ${imp}:`,
      '    dependencies:',
      '      next:',
      `        specifier: ${next}`,
      `        version: ${next}(react-dom@18.3.1(react@18.3.1))(react@18.3.1)`,
      '      react:',
      '        specifier: 18.3.1',
      '        version: 18.3.1',
      '      react-dom:',
      '        specifier: 18.3.1',
      '        version: 18.3.1(react@18.3.1)',
      '',
    ];
  });
  versions.add('react@18.3.1');
  versions.add('react-dom@18.3.1');
  const packages = [...versions].sort().flatMap((k) => {
    const at = k.lastIndexOf('@');
    return [`  ${k}:`, `    resolution: ${res(k.slice(0, at), k.slice(at + 1))}`, ''];
  });
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '',
    'importers:',
    '',
    ...body,
    'packages:',
    '',
    ...packages,
  ].join('\n');
};
