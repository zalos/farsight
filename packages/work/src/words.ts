// Words and typed counts for work items. Every word comes from core's catalog
// (strings.ts, both registers + define) and every number is a Counted
// (counts.ts, listed in docs/COUNTS.md) — the CLI, MCP and HUD print these.
import { t, counted, countKey, type Counted, type CountPart, type Register } from '@farsight/core';
import type { StateCategory, WorkItem } from './contract.js';
import type { Freshness } from './engine.js';
import type { Capabilities } from './provider.js';
import type { OutboxRow } from './cache.js';
import type { SyncReport } from './engine.js';

const STATE_KEY: Record<StateCategory, string> = {
  todo: 'work.state.todo', 'in-progress': 'work.state.inProgress', done: 'work.state.done', removed: 'work.state.removed',
};
const PART_KEY: Record<StateCategory, string> = {
  todo: 'count.part.workTodo', 'in-progress': 'count.part.workInProgress', done: 'count.part.workDone', removed: 'count.part.workRemoved',
};

/**
 * The category word printed beside the tracker's own status name. With
 * `undefinedByType` (the item's type defines no such state; the provider used the
 * category as a stand-in — `fields.stateUndefinedByType`) the note follows it.
 */
export function stateWord(c: StateCategory, register: Register = 'professional', opts: { undefinedByType?: boolean } = {}): string {
  const word = t(STATE_KEY[c], register);
  return opts.undefinedByType ? `${word} · ${t('work.state.undefinedByType', register)}` : word;
}

/** True when the provider marked the item's state as one its type does not define. */
export function stateUndefinedByType(item: WorkItem): boolean {
  return item.fields.stateUndefinedByType === true;
}

/** `In Progress · in progress` — the tracker's name, then the category (and the undefined-by-type note). */
export function itemStateText(item: WorkItem, register: Register = 'professional'): string {
  return `${item.state.name} · ${stateWord(item.state.category, register, { undefinedByType: stateUndefinedByType(item) })}`;
}

/** The tracker's dry-run answer: *dry run: ok* · *dry run: <reason>*. */
export function previewText(p: { ok: boolean; reason: string }, register: Register = 'professional'): string {
  return p.ok ? t('work.preview.ok', register) : t('work.preview.refused', register).replace('{reason}', p.reason);
}

/** "3 minutes ago" from milliseconds. */
export function agoText(ms: number, register: Register = 'professional'): string {
  const n = (u: number) => Math.floor(ms / u);
  const pick = (key: string, v: number) => t(countKey(key, v), register).replace('{n}', String(v));
  if (ms < 60_000) return t('work.ago.now', register);
  if (ms < 3600_000) return pick('work.ago.minutes', n(60_000));
  if (ms < 86400_000) return pick('work.ago.hours', n(3600_000));
  return pick('work.ago.days', n(86400_000));
}

/** The §6.2 freshness sentence. */
export function freshnessText(f: Freshness, register: Register = 'professional'): string {
  switch (f.state) {
    case 'synced': return t('work.fresh.synced', register).replace('{ago}', agoText(f.ago ?? 0, register));
    case 'unreachable': return t('work.fresh.unreachable', register).replace('{since}', f.since ? f.since.slice(0, 16).replace('T', ' ') + ' UTC' : '?');
    case 'credential-expired': return t('work.fresh.credential', register);
    default: return t('work.fresh.never', register);
  }
}

/** Items counted once, with a partition by the tracker's state category. */
export function workItemsCounted(items: WorkItem[], scope: 'count.scope.workSource' | 'count.scope.workSources', source = 'cache.listItems'): Counted {
  const by = new Map<StateCategory, number>();
  for (const i of items) by.set(i.state.category, (by.get(i.state.category) ?? 0) + 1);
  const breakdown: CountPart[] = (['todo', 'in-progress', 'done', 'removed'] as StateCategory[])
    .filter((c) => by.get(c))
    .map((c) => ({ key: PART_KEY[c], n: by.get(c)! }));
  return counted(items.length, 'count.unit.workItems', scope, `work ${source}`, { bizUnit: 'count.unit.workItems', breakdown });
}

/** A sync's three numbers. */
export function syncCounted(r: SyncReport): { pulled: Counted; changed: Counted; gone: Counted } {
  const src = 'work syncSource → SyncReport';
  return {
    pulled: counted(r.pulled, 'count.unit.workPulled', 'count.scope.workSync', `${src}.pulled`, { bizUnit: 'count.unit.workPulled' }),
    changed: counted(r.changed, 'count.unit.workChanged', 'count.scope.workSync', `${src}.changed`, { bizUnit: 'count.unit.workChanged' }),
    gone: counted(r.deleted, 'count.unit.workGone', 'count.scope.workSync', `${src}.deleted`, { bizUnit: 'count.unit.workGone' }),
  };
}

/** One item's numbers, and `stateNote` — the undefined-by-type words to print beside the category, when they apply. */
export function itemCounted(item: WorkItem, links: number, register: Register = 'professional'): { comments: Counted; changes: Counted; links: Counted; stateNote?: string } {
  return {
    ...(stateUndefinedByType(item) ? { stateNote: t('work.state.undefinedByType', register) } : {}),
    comments: counted(item.comments.length, 'count.unit.workComments', 'count.scope.workItem', 'WorkItem.comments', { bizUnit: 'count.unit.workComments' }),
    changes: counted(item.history.length, 'count.unit.workChanges', 'count.scope.workItem', 'WorkItem.history'),
    links: counted(links, 'count.unit.workLinks', 'count.scope.workItem', 'cache.linksFor', { bizUnit: 'count.unit.workLinks' }),
  };
}

/** What a source declares it can do, in words: *comments in markdown · conflicts found by revision · deletions seen · dry run before a write*. */
export function capabilityWords(c: Capabilities, register: Register = 'professional'): string[] {
  return [
    c.comments.write ? t('work.cap.comments', register).replace('{format}', c.comments.format) : t('work.cap.commentsReadOnly', register),
    t(c.transitions === 'graph' ? 'work.cap.transitionsGraph' : 'work.cap.transitionsPerItem', register),
    t(c.concurrency === 'revision' ? 'work.cap.concurrencyRevision' : 'work.cap.concurrencyUpdated', register),
    t(c.deletesVisible ? 'work.cap.deletesVisible' : 'work.cap.deletesReconcile', register),
    ...(c.dryRun ? [t('work.cap.dryRun', register)] : []),
  ];
}

/** The outbox of one source: writes waiting for a person, writes in conflict. */
export function outboxCounted(rows: OutboxRow[]): { queued: Counted; conflicts: Counted } {
  return {
    queued: counted(rows.filter((r) => r.state === 'queued').length, 'count.unit.workQueued', 'count.scope.workSource', 'WorkCache.listOutbox state=queued', { bizUnit: 'count.unit.workQueued' }),
    conflicts: counted(rows.filter((r) => r.state === 'conflict').length, 'count.unit.workConflicts', 'count.scope.workSource', 'WorkCache.listOutbox state=conflict', { bizUnit: 'count.unit.workConflicts' }),
  };
}
