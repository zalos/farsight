// Work-item keys in free text — commit subjects, branch names, doc comments,
// item bodies (docs/proposals/work-items-sync.md §9: work → commit → function).
//
// Jira:   ACME-123 bare · #ACME-123 · [ACME-123] · ACME-123: · any https://<host>/browse/ACME-123
//         (any host, self-hosted too; a configured host only marks the match `configured`)
// ADO:    AB#4711 (always) · #4711 (only when an Azure DevOps source exists — otherwise a bare
//         #12 is a GitHub issue) · https://dev.azure.com/<org>/<project>/_workitems/edit/4711
//         and https://<org>.visualstudio.com/<project>/_workitems/edit/4711
// Branch: feature/ORG-12345-some-story · ORG-12345/… · users/x/AB#12 (pass { branch: true }).
//
// A key never matches inside a word, its project part is ≥ 2 characters, and a
// short stop list of things shaped like keys (SHA-256, UTF-8, ISO-8601, RFC-7231,
// ES-2015, TLS-1, HTTP-2) is refused.

export type KeyVia = 'key' | 'hash' | 'bracket' | 'url' | 'branch';

export interface DetectedKey {
  key: string;
  provider: 'jira' | 'azure-devops';
  via: KeyVia;
  /** offset of the match in the text */
  index: number;
  /** the host of a URL match */
  host?: string;
  /** Azure DevOps org of a URL match */
  org?: string;
  /** the URL's host or org is one the caller configured */
  configured?: boolean;
}

export interface DetectOptions {
  /** hosts of configured Jira sites (`example.atlassian.net`, `jira.example.com`) */
  jiraHosts?: string[];
  /** configured Azure DevOps orgs (names or URLs); non-empty turns on bare `#4711` */
  adoOrgs?: string[];
  /** the text is a branch name: every match reports via 'branch' */
  branch?: boolean;
}

export const KEY_STOP_LIST = ['SHA', 'UTF', 'ISO', 'RFC', 'ES', 'TLS', 'HTTP'] as const;
const STOP = new Set<string>(KEY_STOP_LIST);

const hostOf = (h: string) => h.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const orgOf = (o: string) => {
  const s = o.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const dev = /^dev\.azure\.com\/([^/]+)/.exec(s);
  if (dev) return dev[1]!;
  const vs = /^([^.]+)\.visualstudio\.com/.exec(s);
  return vs ? vs[1]! : s;
};

// a key's project part: uppercase letter, then ≥ 1 of [A-Z0-9_]
const KEY = '[A-Z][A-Z0-9_]+-\\d+';
const RULES: { re: RegExp; kind: 'jira-url' | 'ado-url' | 'ado-vs-url' | 'ab' | 'jira-hash' | 'jira-bracket' | 'jira' | 'ado-hash' }[] = [
  { re: /https?:\/\/([^\s/]+)(?:\/[^\s]*?)?\/browse\/([A-Z][A-Z0-9_]+-\d+)(?![A-Za-z0-9_])/g, kind: 'jira-url' },
  { re: /https?:\/\/dev\.azure\.com\/([^\s/]+)\/[^\s/]+(?:\/[^\s/]+)?\/_workitems\/edit\/(\d+)/g, kind: 'ado-url' },
  { re: /https?:\/\/([^\s./]+)\.visualstudio\.com\/(?:[^\s/]+\/){1,2}_workitems\/edit\/(\d+)/g, kind: 'ado-vs-url' },
  { re: /(?<![A-Za-z0-9_])AB#(\d+)(?![A-Za-z0-9_])/g, kind: 'ab' },
  { re: new RegExp(`\\[(${KEY})\\]`, 'g'), kind: 'jira-bracket' },
  { re: new RegExp(`(?<![A-Za-z0-9_&])#(${KEY})(?![A-Za-z0-9_])`, 'g'), kind: 'jira-hash' },
  { re: new RegExp(`(?<![A-Za-z0-9_#])(?<![A-Z0-9_]-)(${KEY})(?![A-Za-z0-9_])`, 'g'), kind: 'jira' },
  { re: /(?<![A-Za-z0-9_&#])#(\d+)(?![A-Za-z0-9_])/g, kind: 'ado-hash' },
];

export function detectWorkKeys(text: string, opts: DetectOptions = {}): DetectedKey[] {
  const hosts = new Set((opts.jiraHosts ?? []).map(hostOf));
  const orgs = new Set((opts.adoOrgs ?? []).map(orgOf));
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  const found: DetectedKey[] = [];

  for (const { re, kind } of RULES) {
    if (kind === 'ado-hash' && !orgs.size) continue;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      let hit: DetectedKey | null = null;
      switch (kind) {
        case 'jira-url': {
          const host = m[1]!.toLowerCase();
          hit = { key: m[2]!, provider: 'jira', via: 'url', index: start, host, configured: hosts.has(host) };
          break;
        }
        case 'ado-url':
        case 'ado-vs-url': {
          const org = m[1]!.toLowerCase();
          hit = { key: m[2]!, provider: 'azure-devops', via: 'url', index: start, org, configured: orgs.has(org) };
          break;
        }
        case 'ab':
          hit = { key: m[1]!, provider: 'azure-devops', via: 'hash', index: start };
          break;
        case 'ado-hash':
          hit = { key: m[1]!, provider: 'azure-devops', via: 'hash', index: start };
          break;
        case 'jira-bracket':
        case 'jira-hash':
        case 'jira': {
          const key = m[1]!;
          if (STOP.has(key.slice(0, key.lastIndexOf('-')))) continue;
          hit = { key, provider: 'jira', via: kind === 'jira-bracket' ? 'bracket' : kind === 'jira-hash' ? 'hash' : 'key', index: start };
          break;
        }
      }
      if (!hit) continue;
      if (opts.branch) hit.via = 'branch';
      taken.push([start, end]);
      found.push(hit);
    }
  }

  // one entry per (provider, key), at its first appearance; URL evidence wins when both are present
  found.sort((a, b) => a.index - b.index);
  const out = new Map<string, DetectedKey>();
  for (const f of found) {
    const k = `${f.provider}:${f.key}`;
    const prev = out.get(k);
    if (!prev) out.set(k, f);
    else if (f.via === 'url' && prev.via !== 'url') out.set(k, { ...f, index: prev.index });
  }
  return [...out.values()];
}
