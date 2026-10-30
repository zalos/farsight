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
export const dirty = (loaded, draft) => !equal(loaded, draft);

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
  return merge(loaded, draft, current, '');
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
