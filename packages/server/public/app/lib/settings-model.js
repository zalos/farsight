// Pure settings operations. Section renderers share this namespace; overlay forms can add folds here.
export const sections = [
  { id: 'workspace', key: 'settings.workspace', businessKey: 'settings.workspace' },
  { id: 'sources', key: 'settings.sources', businessKey: 'settings.systems' },
  { id: 'collections', key: 'settings.collections', businessKey: 'settings.collections' },
  { id: 'configuration', key: 'settings.configuration', businessKey: 'settings.meaning' },
  { id: 'agents', key: 'settings.agents', businessKey: 'settings.agents' },
];

const commonFields = ['name', 'type', 'path', 'enabled'];
export const sourceFields = {
  local: [...commonFields, 'exclude', 'storybook.url', 'storybook.command'],
  git: [...commonFields, 'exclude', 'storybook.url', 'storybook.command'],
  openapi: [...commonFields],
  design: [...commonFields],
  work: [
    ...commonFields,
    'provider',
    'site',
    'org',
    'scope.projects',
    'mode',
    'auth.kind',
    'auth.user',
    'auth.secret',
    'poll',
    'permissions',
  ],
};

export const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (object(a) && object(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}
// Absent defaults and empty optional containers have the same saved meaning.
export function normalized(value) {
  const copy = clone(value);
  function prune(node) {
    if (!object(node)) return;
    for (const key of Object.keys(node)) {
      if (Array.isArray(node[key])) node[key].forEach(prune);
      else prune(node[key]);
      if (node[key] === undefined || (object(node[key]) && !Object.keys(node[key]).length)) delete node[key];
    }
  }
  if (copy.theme === 'system') delete copy.theme;
  if (copy.defaultLens === 'hybrid') delete copy.defaultLens;
  if (copy.mcp?.tools === 'core') delete copy.mcp.tools;
  if (copy.flags?.designShots === false) delete copy.flags.designShots;
  for (const key of ['collections', 'lessons']) if (!copy[key]?.length) delete copy[key];
  for (const source of copy.sources || []) if (!source.exclude?.length) delete source.exclude;
  prune(copy);
  return copy;
}
export const dirty = (loaded, draft) => !equal(normalized(loaded), normalized(draft));

/** Unedited fields use the fresh server value. Explicit edits and deletions win, recursively. */
export function mergeSettings(loaded, draft, current) {
  function merge(before, after, now, path) {
    if (equal(before, after)) return clone(now);
    if (path === 'sources' && Array.isArray(before) && Array.isArray(after) && Array.isArray(now)) {
      const old = new Map(before.map((s) => [s.id, s]));
      const fresh = new Map(now.map((s) => [s.id, s]));
      const edited = new Set(after.map((s) => s.id));
      const rows = after.flatMap((s) => {
        // A concurrent deletion survives unless this draft edited that source.
        if (old.has(s.id) && !fresh.has(s.id) && equal(old.get(s.id), s)) return [];
        return [merge(old.get(s.id), s, fresh.get(s.id), '')];
      });
      // New sources on the server were never removed by this draft.
      return rows.concat(now.filter((s) => !old.has(s.id) && !edited.has(s.id)).map(clone));
    }
    if (object(after) && (before === undefined || object(before))) {
      const result = {};
      const keys = new Set([...Object.keys(before || {}), ...Object.keys(after), ...Object.keys(now || {})]);
      for (const key of keys) {
        const value = merge(before?.[key], after[key], now?.[key], path ? path + '.' + key : key);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    return clone(after);
  }
  return merge(normalized(loaded), normalized(draft), current, '');
}

export function needsSync(before, after) {
  const inputs = (settings) => (settings.sources || []).map(({ status: _status, ...source }) => source);
  return !equal(inputs(before), inputs(after)) || !equal(before.flags, after.flags);
}

export function readAt(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}
export function writeAt(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  for (const key of keys) object = object[key] ||= {};
  if (value === undefined) delete object[last];
  else object[last] = value;
}

/** The one array operation used by every row editor. Mutates the draft, never the loaded settings. */
export function editRows(rows, action, index, value) {
  if (action === 'add') rows.push(value);
  else if (action === 'remove') rows.splice(index, 1);
  else if (action === 'up' && index > 0) rows.splice(index - 1, 0, rows.splice(index, 1)[0]);
  else if (action === 'down' && index < rows.length - 1) rows.splice(index + 1, 0, rows.splice(index, 1)[0]);
  return rows;
}

/** Transport guard, not a settings validator: only references cross the network. Rejected values are discarded. */
export function secretReference(value) {
  return /^(keychain|env):/.test(value) ? value : '';
}

/** Existing overlays can contain fields from a newer build. Preserve them, but expose no editable control. */
export function unavailableFields(settings, version) {
  if (!Array.isArray(version?.configFields) || !Array.isArray(version?.overlayFields)) return [];
  const known = new Set(version?.configFields || []);
  const overlay = new Set(version?.overlayFields || []);
  return (settings.sources || []).flatMap((source, index) =>
    Object.keys(source.config || {})
      .filter(
        (field) => !field.startsWith('$') && !field.startsWith('//') && (!known.has(field) || !overlay.has(field)),
      )
      .map((field) => ({ source: source.name, field, path: `sources[${index}].config.${field}` })),
  );
}

export function sourceId(name, sources) {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'source';
  let id = base;
  for (let suffix = 2; sources.some((source) => source.id === id); suffix++) id = base + '-' + suffix;
  return id;
}

export function changeSourceType(source, type) {
  const old = source.type;
  source.type = type;
  const fields = ['exclude', 'storybook', 'provider', 'site', 'org', 'scope', 'mode', 'auth', 'poll', 'permissions'];
  const keep = new Set((sourceFields[type] || []).map((path) => path.split('.')[0]));
  for (const field of fields) if (!keep.has(field)) delete source[field];
  if (!['local', 'git'].includes(type))
    for (const field of ['config', 'openapi', 'openapiIgnore']) delete source[field];
  if (old !== type) delete source.status;
  if (type === 'work') {
    source.provider ||= 'jira';
    source.mode ||= 'read-only';
    source.auth ||= { kind: 'api-token' };
    delete source.path;
  }
}

const count = (n, unit, scope, source, breakdown) => ({
  n,
  unit,
  bizUnit: unit,
  scope,
  source,
  ...(breakdown ? { breakdown } : {}),
});
export function lessonsCounted(rows) {
  const pinned = rows.filter((row) => row.pinned).length;
  return {
    all: count(rows.length, 'settings.count.lessons', 'count.scope.workspace', 'settings.lessons', [
      { key: 'settings.count.pinned', n: pinned },
      { key: 'settings.count.unpinned', n: rows.length - pinned },
    ]),
    pinned: count(pinned, 'settings.count.pinned', 'count.scope.workspace', 'settings.lessons[].pinned'),
  };
}
// The legacy saved status is prose. Read its known count fields, never print its untyped numeric sentence.
export function sourceStatus(source) {
  const text = source.status || '';
  const key = !source.enabled
    ? 'disabled'
    : !text
      ? 'none'
      : text.startsWith('error:')
        ? 'error'
        : text.startsWith('ok:')
          ? text.includes('not synced')
            ? 'cached'
            : 'ok'
          : 'skipped';
  const counts = [];
  const code = /^ok: (\d+) nodes, (\d+) edges/.exec(text);
  if (code)
    for (const [i, unit] of ['settings.count.parts', 'settings.count.connections'].entries())
      counts.push(count(Number(code[i + 1]), unit, 'count.scope.source', 'settings.sources[].status'));
  const work = /^ok: (\d+) items?/.exec(text) || /showing the cache \((\d+) items?\)/.exec(text);
  if (work)
    counts.push(count(Number(work[1]), 'count.unit.workItems', 'count.scope.workSource', 'settings.sources[].status'));
  const history = /(\d+) commits? read into history · (\d+) ingested by a sync · (\d+) not yet/.exec(text);
  if (history) {
    const units = ['history.fact.read', 'history.fact.ingested', 'history.fact.notYet'];
    for (const [i, unit] of units.entries())
      counts.push(
        count(
          Number(history[i + 1]),
          unit,
          'count.scope.source',
          'historySentence() in settings.sources[].status',
          i === 0
            ? [
                { key: units[1], n: Number(history[2]) },
                { key: units[2], n: Number(history[3]) },
              ]
            : undefined,
        ),
      );
  }
  for (const [pattern, unit, scope] of [
    [/(\d+) new this sync/, 'settings.count.newHistory', 'count.scope.source'],
    [/(\d+) keyed commits? no longer in the history/, 'settings.count.forgotten', 'count.scope.source'],
    [/(\d+) keyed commits? resolved to code/, 'settings.count.resolved', 'count.scope.source'],
    [/(\d+) sent,/, 'settings.count.sent', 'count.scope.workSync'],
    [/(\d+) changed,/, 'settings.count.changed', 'count.scope.workSync'],
    [/(\d+) gone\)/, 'settings.count.gone', 'count.scope.workSync'],
    [/(\d+) links? to the graph/, 'settings.count.links', 'count.scope.workSource'],
  ]) {
    const match = pattern.exec(text);
    if (match) counts.push(count(Number(match[1]), unit, scope, 'settings.sources[].status'));
  }
  const notices = [];
  if (key === 'error' && work) notices.push('settings.status.cached');
  if (/history not indexed/.test(text)) notices.push('settings.status.historyUnavailable');
  if (text.includes('(capped at ')) notices.push('settings.status.historyCapped');
  return {
    key: 'settings.status.' + key,
    counts,
    notices,
    reason: key === 'error' ? text.slice(7).replace(/ — showing the cache \(\d+ items?\)/, '') : '',
  };
}
