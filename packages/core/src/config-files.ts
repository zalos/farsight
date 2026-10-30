/**
 * The config files of each source as data the surfaces print (docs/proposals/journey-organisation-and-config-files.md
 * §5.3–5.4): one fold over `meta.config`, so the MCP `config_files` tool, `farsight config list`,
 * `graph_overview` and `/api/config` cannot disagree. Reading the files is the parsers' job
 * (`loadWorkspaceConfig`); this module never touches the disk.
 */
import type { ConfigMeta, OpenApiMeta } from './graph.js';
import { counted, countedText, breakdownText, type Counted } from './counts.js';
import { t } from './strings.js';

const SOURCE = 'parsers shared/config-files.ts loadWorkspaceConfig → meta.config[repo]';

/** Applied and candidate documents of one source, plus each document's declared operations. */
export function openApiCounts(meta: OpenApiMeta): {
  applied: Counted;
  candidates: Counted;
  operations: Record<string, Counted>;
} {
  const count = (kind: 'applied' | 'candidates') => {
    const unit = kind === 'applied' ? 'count.unit.openapiApplied' : 'count.unit.openapiCandidates';
    return counted(meta[kind].length, unit, 'count.scope.source', `meta.openapi[repo].${kind}`, { bizUnit: unit });
  };
  return {
    applied: count('applied'),
    candidates: count('candidates'),
    operations: Object.fromEntries(
      [...meta.applied, ...meta.candidates].map((d) => [
        d.path,
        counted(
          d.operations,
          'count.unit.openapiOperations',
          'count.scope.document',
          'meta.openapi[repo].document.operations',
          { bizUnit: 'count.unit.openapiOperations' },
        ),
      ]),
    ),
  };
}

/** Shell-safe arguments, including source names and document paths supplied by a repository. */
function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function openApiOverviewLines(metas: Record<string, OpenApiMeta> | undefined): string[] {
  return Object.entries(metas ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([repo, meta]) => {
      if (!meta.candidates.length) return [];
      const count = openApiCounts(meta).candidates;
      const key = count.n === 1 ? 'config.openapi.overviewOne' : 'config.openapi.overview';
      return [
        `${repo} — ${t(key, 'professional')
          .replace('{count}', countedText(count, { scope: false }))
          .replace('{paths}', meta.candidates.map((d) => d.path).join(' · '))}`,
      ];
    });
}

/** One shared text fold for CLI candidates/list and read-only MCP config_files. */
export function openApiFilesText(
  metas: Record<string, OpenApiMeta> | undefined,
  repo?: string,
  candidatesOnly = false,
): string[] {
  if (!metas) return [t('config.openapi.none', 'professional')];
  if (repo && !Object.hasOwn(metas, repo))
    return [t('config.openapi.noSource', 'professional').replace('{source}', repo)];
  const entries = Object.entries(metas ?? {})
    .filter(([r]) => !repo || r === repo)
    .sort(([a], [b]) => a.localeCompare(b));
  const out: string[] = [];
  for (const [r, meta] of entries) {
    const counts = openApiCounts(meta);
    out.push(
      `${r} — ${t('config.openapi.title', 'professional')}: ${candidatesOnly ? '' : countedText(counts.applied) + ' · '}${countedText(counts.candidates)}`,
    );
    for (const d of [...(candidatesOnly ? [] : meta.applied), ...meta.candidates]) {
      const candidate = meta.candidates.includes(d);
      out.push(
        `  ${d.path} · ${d.title}${d.version ? ` ${d.version}` : ''} · ${countedText(counts.operations[d.path]!)} · ${t('config.openapi.origin.' + (candidate ? 'candidate' : d.origin), 'professional')}`,
      );
      if (candidate)
        out.push(
          '  ' +
            t('config.openapi.command', 'professional').replace(
              '{command}',
              `farsight api register ${shellArg(r)} ${shellArg(d.path)}`,
            ),
        );
    }
  }
  return out.length ? out : [countedText(openApiCounts({ applied: [], candidates: [] }).candidates, { scope: false })];
}

/** How many config files one source holds (the root's and the scoped ones), and how many conflicts they have. */
export function configCounts(meta: ConfigMeta): { files: Counted; conflicts: Counted } {
  const root = meta.files.filter((f) => f.root).length;
  return {
    // the same words in the business lens: a config file is a file a person edits, whoever reads the count
    files: counted(meta.files.length, 'count.unit.configFiles', 'count.scope.source', `${SOURCE}.files`, {
      bizUnit: 'count.unit.configFiles',
      breakdown: [
        { key: 'count.part.configRoot', n: root },
        { key: 'count.part.configScoped', n: meta.files.length - root },
      ],
    }),
    conflicts: counted(
      meta.conflicts.length,
      'count.unit.configConflicts',
      'count.scope.source',
      `${SOURCE}.conflicts`,
      { bizUnit: 'count.unit.configConflicts' },
    ),
  };
}

/**
 * `3 config files in this source (1 for the whole source · 2 for one folder) · 1 conflict` — the scope
 * said once, after the first number (`scope: false` leaves it to the caller).
 */
export function configSummary(meta: ConfigMeta, opts: { scope?: boolean } = {}): string {
  const { files, conflicts } = configCounts(meta);
  const parts = breakdownText({ ...files, breakdown: files.breakdown?.filter((p) => p.n) });
  return `${countedText(files, { scope: opts.scope !== false })}${parts ? ` (${parts})` : ''}${conflicts.n ? ` · ${countedText(conflicts, { scope: false })}` : ''}`;
}

/**
 * One `graph_overview` line per source that holds more than its root file (or has something to
 * say): `config: nx-workspace — 3 config files (…) · 1 conflict`. A source with only a root file
 * says nothing — that is every source before nested files existed.
 */
export function configOverviewLines(metas: Record<string, ConfigMeta> | undefined): string[] {
  const out: string[] = [];
  for (const [repo, meta] of Object.entries(metas ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    const scoped = meta.files.some((f) => !f.root);
    if (!scoped && !meta.conflicts.length && !meta.notes.length) continue;
    out.push(
      `config: ${repo} — ${configSummary(meta, { scope: false })}${meta.notes.length ? ` · ${meta.notes.length} note(s)` : ''} — config_files lists them`,
    );
  }
  return out;
}

/**
 * The config files as text, per source: one line per file (path, root or the folder it is scoped
 * to, the fields it gives, what was ignored), then the conflicts and the notes.
 */
export function configFilesText(metas: Record<string, ConfigMeta> | undefined, repo?: string): string[] {
  const entries = Object.entries(metas ?? {})
    .filter(([r]) => !repo || r === repo)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!entries.length) {
    return [
      repo
        ? `No config files recorded for ${repo}: it has no farsight.config.json, or the graph was written before config files were recorded — re-ingest to record them.`
        : 'No config files recorded: no source has a farsight.config.json, or the graph was written before config files were recorded — re-ingest to record them.',
    ];
  }
  const out: string[] = [];
  for (const [r, meta] of entries) {
    if (out.length) out.push('');
    out.push(`## ${r} — ${configSummary(meta)}`);
    for (const f of meta.files) {
      const where = f.root ? 'root — the whole source' : `scoped to ${f.dir}/`;
      out.push(
        `${f.path} — ${where} · ${f.fields.length ? f.fields.join(', ') : 'no fields'}${f.ignored.length ? ` · ignored: ${f.ignored.join(', ')}` : ''}`,
      );
    }
    if (meta.conflicts.length) {
      out.push('conflicts:');
      for (const c of meta.conflicts) {
        const stands = c.kind === 'glossary' ? `${c.kept}'s word stands under its folder` : `${c.kept}'s is kept`;
        out.push(`  ${c.kind} ${JSON.stringify(c.key)}: ${c.files.join(', ')} — ${stands}`);
      }
    }
    if (meta.notes.length) {
      out.push('notes:');
      for (const n of meta.notes) out.push(`  ${n}`);
    }
  }
  return out;
}
