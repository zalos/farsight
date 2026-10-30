/**
 * The config files of each source as data the surfaces print (docs/proposals/journey-organisation-and-config-files.md
 * §5.3–5.4): one fold over `meta.config`, so the MCP `config_files` tool, `farsight config list`,
 * `graph_overview` and `/api/config` cannot disagree. Reading the files is the parsers' job
 * (`loadWorkspaceConfig`); this module never touches the disk.
 */
import type { ConfigMeta, OpenApiMeta } from './graph.js';
import { counted, countedText, breakdownText, type Counted } from './counts.js';
import { t, type Register } from './strings.js';

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
  knownRepos: readonly string[] = [],
): string[] {
  if (repo && !metas?.[repo] && knownRepos.includes(repo))
    return [t('config.openapi.noInventory', 'professional').replace('{source}', repo)];
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
  const workspace = meta.files.filter((f) => f.from === 'workspace').length;
  return {
    // the same words in the business lens: a config file is a file a person edits, whoever reads the count
    files: counted(meta.files.length, 'count.unit.configFiles', 'count.scope.source', `${SOURCE}.files`, {
      bizUnit: 'count.unit.configFiles',
      breakdown: [
        { key: 'count.part.configRoot', n: root },
        { key: 'count.part.configScoped', n: meta.files.length - root - workspace },
        ...(workspace ? [{ key: 'count.part.configWorkspace', n: workspace }] : []),
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
export function configFilesText(
  metas: Record<string, ConfigMeta> | undefined,
  repo?: string,
  register: Register = 'professional',
  patterns?: Record<string, import('./graph.js').PatternsMeta>,
): string[] {
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
      const where =
        f.from === 'workspace'
          ? t('config.scope.workspace', 'hud')
          : f.root
            ? 'root — the whole source'
            : `scoped to ${f.dir}/`;
      out.push(
        `${f.path} — ${where} · ${f.fields.length ? f.fields.join(', ') : 'no fields'}${f.ignored.length ? ` · ignored: ${f.ignored.join(', ')}` : ''}`,
      );
      for (const [group, names] of Object.entries(f.frameworks ?? {})) {
        out.push(`  ${t(`config.alias.${group}`, register)}: ${names.map((name) => JSON.stringify(name)).join(', ')}`);
      }
      for (const node of f.nodes ?? [])
        out.push(
          `  ${t('config.nodes.title', register)} · ${t(`config.nodes.kind.${node.kind}`, register)}: ${node.name}${node.business ? ` — ${node.business}` : ''}`,
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
  return [...out, ...patternFilesText(patterns, repo)];
}

/** Each rule's numbers, in report order so equal rule ids in different config files stay distinct. */
export function patternCounts(meta: import('./graph.js').PatternsMeta, repo: string) {
  return meta.rules.map((row, index) => {
    const source = `meta.patterns[${JSON.stringify(repo)}].rules[${index}]`;
    const count = (key: 'matched' | 'nodes' | 'edges' | 'unresolved' | 'skipped') => {
      const omitted = key === 'unresolved' ? row.unresolvedOmitted : key === 'skipped' ? row.skippedOmitted : 0;
      return counted(
        (Array.isArray(row[key]) ? row[key].length : (row[key] as number)) + (omitted ?? 0),
        `count.unit.pattern${key[0]!.toUpperCase()}${key.slice(1)}`,
        'count.scope.pattern',
        `${source}.${key}${Array.isArray(row[key]) ? '.length' : ''}${omitted ? ` + ${source}.${key}Omitted` : ''}`,
        { bizUnit: `count.unit.pattern${key[0]!.toUpperCase()}${key.slice(1)}Biz` },
      );
    };
    const omittedCount = (key: 'unresolved' | 'skipped') =>
      counted(
        row[`${key}Omitted`] ?? 0,
        `count.unit.pattern${key[0]!.toUpperCase()}${key.slice(1)}Omitted`,
        'count.scope.pattern',
        `${source}.${key}Omitted`,
        { bizUnit: `count.unit.pattern${key[0]!.toUpperCase()}${key.slice(1)}Omitted` },
      );
    return {
      matched: count('matched'),
      nodes: count('nodes'),
      edges: count('edges'),
      unresolved: count('unresolved'),
      skipped: count('skipped'),
      ...(row.unresolvedOmitted ? { unresolvedOmitted: omittedCount('unresolved') } : {}),
      ...(row.skippedOmitted ? { skippedOmitted: omittedCount('skipped') } : {}),
    };
  });
}

export function patternFilesText(
  metas: Record<string, import('./graph.js').PatternsMeta> | undefined,
  repo?: string,
): string[] {
  return Object.entries(metas ?? {})
    .filter(([r]) => !repo || r === repo)
    .flatMap(([r, meta]) => {
      const counts = patternCounts(meta, r);
      return [
        `${r} — ${t('config.patterns.title', 'professional')}`,
        ...meta.rules.flatMap((row, i) => [
          `  ${row.id} · ${row.file} · ${Object.entries(counts[i]!)
            .filter(([key]) => !key.endsWith('Omitted'))
            .map(([, value]) => value)
            .map((c) => countedText(c))
            .join(' · ')}`,
          ...row.unresolved.map(
            (u) =>
              `    ${u.path}:${u.line} · ${t('config.patterns.unresolved', 'professional')} ${JSON.stringify(u.capture)}`,
          ),
          ...(counts[i]!.unresolvedOmitted ? [`    ${countedText(counts[i]!.unresolvedOmitted!)}`] : []),
          ...row.skipped.map((s) => `    ${s.path} · ${s.reason}`),
          ...(counts[i]!.skippedOmitted ? [`    ${countedText(counts[i]!.skippedOmitted!)}`] : []),
        ]),
      ];
    });
}

export function patternOverviewLines(metas: Record<string, import('./graph.js').PatternsMeta> | undefined): string[] {
  return Object.entries(metas ?? {}).map(([repo, meta]) => {
    const counts = patternCounts(meta, repo);
    return `${repo} — ${t('config.patterns.title', 'professional')}: ${meta.rules
      .map(
        (r, i) =>
          `${r.id} (${Object.entries(counts[i]!)
            .filter(([key]) => !key.endsWith('Omitted'))
            .map(([, value]) => value)
            .map((c) => countedText(c))
            .join(' · ')})`,
      )
      .join('; ')}`;
  });
}

/** The explicitly bounded dry-run list, kept apart from the rule's total matches. */
export function patternMatchCounts(total: number, returned: number, repo: string) {
  const count = (n: number, kind: 'Returned' | 'Omitted') =>
    counted(
      n,
      'count.unit.pattern' + kind,
      'count.scope.source',
      `patterns test[${JSON.stringify(repo)}].matches.${kind.toLowerCase()}`,
      { bizUnit: 'count.unit.pattern' + kind },
    );
  return { returned: count(returned, 'Returned'), omitted: count(total - returned, 'Omitted') };
}
