// Intent → one JSON Patch (docs/proposals/work-items-sync.md §8), pure.
//
// Every patch starts with `{"op":"test","path":"/rev","value":<base revision>}`;
// ADO answers a stale one with 412 TestPatchOperationFailedException (VS403351),
// which the provider reports as a conflict. Never `bypassRules`, never
// `suppressNotifications` — those are not parameters this module can build.
import type { Intent, StateCategory } from '@farsight/work';
import { joinTags, splitTags, LINK_REL_FOR, STATE_CATEGORY_MAP, type TypeInfo } from './map.js';
import { markdownToHtml } from './html.js';

export interface PatchOp { op: 'add' | 'remove' | 'replace' | 'test'; path: string; value?: unknown }

/** What the provider read from the tracker just before building the patch. */
export interface CurrentItem {
  id: string;
  rev: number;
  fields: Record<string, any>;
  multilineFieldsFormat?: Record<string, string>;
}

export interface PatchContext {
  org: string;
  /** the item's type, for `transition` */
  type?: TypeInfo;
  /** canonical → reference name, for `edit` */
  fieldRef: (canonical: string) => string | undefined;
}

export type PatchResult = { ops: PatchOp[] } | { error: string };

/** Intent actions a PATCH carries. `comment` is its own endpoint; `create` is not built. */
export const PATCH_ACTIONS = ['edit', 'assign', 'transition', 'link', 'label'] as const;

/** Resolve a transition target: a named state, or the one reachable state of a category. */
export function transitionTarget(type: TypeInfo, from: string, to?: StateCategory, toName?: string): { state: string } | { error: string } {
  const reachable = (type.transitions[from] ?? []).filter((s) => s !== from);
  if (!type.states.has(from)) return { error: `${type.name} items have no state ${from}` };
  if (toName) {
    if (!type.states.has(toName)) return { error: `${type.name} items have no state ${toName}` };
    if (!reachable.includes(toName)) return { error: `${type.name} items cannot move from ${from} to ${toName}` };
    if (to && STATE_CATEGORY_MAP[type.states.get(toName)!] !== to) return { error: `${toName} is not ${to}` };
    return { state: toName };
  }
  if (!to) return { error: 'a transition names a state or a state category' };
  const hits = reachable.filter((s) => STATE_CATEGORY_MAP[type.states.get(s) ?? ''] === to);
  if (hits.length === 1) return { state: hits[0]! };
  if (!hits.length) return { error: `${type.name} items cannot move from ${from} to any ${to} state` };
  return { error: `more than one ${to} state is reachable from ${from} (${hits.join(', ')}) — name one` };
}

/** Build the patch for one intent against the item as just read. */
export function buildPatch(intent: Intent, cur: CurrentItem, ctx: PatchContext): PatchResult {
  const base = Number(intent.baseRevision ?? cur.rev);
  if (!Number.isFinite(base)) return { error: `the base revision ${intent.baseRevision} is not an Azure DevOps revision` };
  const ops: PatchOp[] = [{ op: 'test', path: '/rev', value: base }];
  const p = intent.payload ?? {};
  const setField = (ref: string, value: unknown) => ops.push({ op: cur.fields[ref] === undefined ? 'add' : 'replace', path: `/fields/${ref}`, value });
  switch (intent.action) {
    case 'edit': {
      const fields = p.fields ?? {};
      const names = Object.keys(fields);
      if (!names.length) return { error: 'an edit names at least one field' };
      for (const name of names) {
        const v = fields[name];
        if (name === 'labels') {
          if (!Array.isArray(v)) return { error: 'labels is a list of tags' };
          setField('System.Tags', joinTags(v.map(String)));
          continue;
        }
        if (name === 'title') {
          if (!String(v ?? '').trim()) return { error: 'a title has words' };
          setField('System.Title', String(v));
          continue;
        }
        if (name === 'description') {
          const md = String(v ?? '');
          const fmt = String(cur.multilineFieldsFormat?.['System.Description'] ?? 'html').toLowerCase();
          setField('System.Description', fmt === 'markdown' ? md : markdownToHtml(md));
          continue;
        }
        if (name === 'state' || name === 'assignee' || name === 'parent') return { error: `${name} is changed by its own action, not an edit` };
        const ref = ctx.fieldRef(name);
        if (!ref) return { error: `${name} is not a field this project has` };
        if (v === null || v === undefined) { if (cur.fields[ref] !== undefined) ops.push({ op: 'remove', path: `/fields/${ref}` }); }
        else setField(ref, v);
      }
      return { ops };
    }
    case 'assign': {
      const a = p.assignee;
      if (a === null || a === undefined || a === '') {
        if (cur.fields['System.AssignedTo'] !== undefined) ops.push({ op: 'remove', path: '/fields/System.AssignedTo' });
        else return { error: 'the item has no assignee to remove' };
        return { ops };
      }
      // an email / unique name is accepted as a string; anything else is a
      // descriptor and goes as an IdentityRef. Never an `{id}`-only ref: ADO
      // accepts it and assigns nobody (measured 2026-09-30).
      const value = String(a).includes('@') ? String(a) : { descriptor: String(a) };
      setField('System.AssignedTo', value);
      return { ops };
    }
    case 'transition': {
      if (!ctx.type) return { error: 'the item type is not known — discover the source first' };
      const target = transitionTarget(ctx.type, String(cur.fields['System.State'] ?? ''), p.to, p.toName);
      if ('error' in target) return target;
      ops.push({ op: 'replace', path: '/fields/System.State', value: target.state });
      return { ops };
    }
    case 'label': {
      const add = (p.add ?? []).map(String).filter(Boolean);
      const remove = new Set((p.remove ?? []).map((s) => String(s).toLowerCase()));
      if (!add.length && !remove.size) return { error: 'a label change adds or removes at least one tag' };
      const now = splitTags(cur.fields['System.Tags']);
      const next = now.filter((t) => !remove.has(t.toLowerCase()));
      for (const t of add) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
      if (next.join(';') === now.join(';')) return { error: 'the tags are already so' };
      if (!next.length) ops.push({ op: 'remove', path: '/fields/System.Tags' });
      else setField('System.Tags', joinTags(next));
      return { ops };
    }
    case 'link': {
      const kind = p.kind ?? 'relates';
      const rel = (typeof p.native === 'string' && p.native) || LINK_REL_FOR[kind];
      if (!rel) return { error: `a ${kind} link needs the Azure DevOps link type named` };
      const target = String(p.target ?? '');
      const id = /(\d+)$/.exec(target)?.[1];
      if (!id) return { error: `${target || 'the target'} is not an Azure DevOps work item` };
      if (id === cur.id) return { error: 'an item cannot link to itself' };
      ops.push({ op: 'add', path: '/relations/-', value: { rel, url: `${ctx.org}/_apis/wit/workItems/${id}` } });
      return { ops };
    }
    default:
      return { error: `${intent.action} is not a field change` };
  }
}
