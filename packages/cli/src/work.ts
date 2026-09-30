// `farsight work sync|list|show|links` — the read side of work items
// (docs/proposals/work-items-sync.md §10). Sources come from
// .farsight/settings.json `sources[]` with `type: 'work'`; providers resolve
// through @farsight/work's registry; the cache is .farsight/work.db.
// Words come from the catalog, numbers are Counteds; secrets are resolved in
// process by the engine and never printed.
import { t, countedLine } from '@farsight/core';
import {
  WorkCache, WorkCacheUnavailable, workDbPath, loadWorkSources, providerFor, registerProvider, syncSource, freshness,
  freshnessText, workItemsCounted, syncCounted, itemCounted, WORK_SCHEMA, STATE_CATEGORIES,
  itemStateText, capabilityWords, outboxCounted, previewText, connectSource, applyIntent, LINK_KINDS,
} from '@farsight/work';
import type { Intent, IntentPayload, WorkAction, Verdict, LinkKind, ApplyOutcome } from '@farsight/work';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { SourceConfig, WorkItem, WorkListDocument, StateCategory } from '@farsight/work';
import { fixtureProvider } from '@farsight/work-fixture';
import { jiraProvider } from '@farsight/work-jira';
import { azdoProvider } from '@farsight/work-azdo';

// the providers this CLI ships — one line each
registerProvider(fixtureProvider);
registerProvider(jiraProvider);
registerProvider(azdoProvider);

const R = 'professional' as const;
const say = (key: string, vars: Record<string, string> = {}) =>
  Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t(key, R));

export interface WorkArgs {
  sub: string | undefined;
  positional: string[];
  flag: (name: string) => string | undefined;
  has: (name: string) => boolean;
  workspace: string;
  fail: (msg: string) => never;
}

function openCache(a: WorkArgs): WorkCache {
  try {
    return new WorkCache(a.flag('work-db') ?? workDbPath(a.workspace));
  } catch (err) {
    if (err instanceof WorkCacheUnavailable) a.fail(err.message);
    throw err;
  }
}

function sources(a: WorkArgs): SourceConfig[] {
  const all = loadWorkSources(a.workspace);
  if (!all.length) a.fail(say('sys.work.noSources'));
  const only = a.flag('source');
  if (!only) return all;
  const one = all.filter((s) => s.id === only);
  if (!one.length) a.fail(say('sys.work.unknownSource', { source: only }));
  return one;
}

const line = (i: WorkItem) =>
  `  ${i.key.padEnd(10)} ${i.type.name.padEnd(8)} ${itemStateText(i, R).padEnd(26)} ${i.title}${i.assignee ? `  — ${i.assignee.name}` : ''}`;

const WRITE_VERBS: Record<string, WorkAction> = { comment: 'comment', assign: 'assign', move: 'transition', edit: 'edit', link: 'link' };

const verdictLine = (key: string, v: Verdict) => `  ${t(key, R)}: ${t(v.allowed ? 'work.verdict.yes' : 'work.verdict.no', R)} — ${v.reason}`;

/** The payload for a write verb, from the words after the key. */
function payloadFor(a: WorkArgs, cache: WorkCache, verb: string, item: WorkItem, args: string[]): IntentPayload {
  const usage = () => a.fail(say('sys.work.usage.write'));
  switch (verb) {
    case 'comment': {
      const body = a.flag('body') ?? args.join(' ');
      if (!body.trim()) usage();
      return { body };
    }
    case 'assign': {
      const who = args.join(' ').trim();
      if (!who) usage();
      if (who === 'none') return { assignee: null };
      const byId = cache.getPerson(who);
      if (byId) return { assignee: byId.id };
      const byName = cache.findPeople(who);
      if (byName.length === 1) return { assignee: byName[0]!.id };
      if (byName.length > 1) a.fail(`${who}: ${byName.map((p) => `${p.name} (${p.id})`).join(', ')} — pass the id`);
      return { assignee: who }; // an id the cache has not seen yet: the tracker decides
    }
    case 'move': {
      const to = args[0];
      if (!to || !(STATE_CATEGORIES as readonly string[]).includes(to)) usage();
      const name = a.flag('name');
      return { to: to as StateCategory, ...(name ? { toName: name } : {}) };
    }
    case 'edit': {
      if (!args.length) usage();
      const fields: Record<string, unknown> = {};
      for (const kv of args) {
        const i = kv.indexOf('=');
        if (i <= 0) usage();
        const raw = kv.slice(i + 1);
        let v: unknown = raw;
        try { v = JSON.parse(raw); } catch { /* a plain string */ }
        fields[kv.slice(0, i)] = v;
      }
      return { fields };
    }
    case 'link': {
      const [kind, other] = args;
      if (!kind || !other || !(LINK_KINDS as readonly string[]).includes(kind)) usage();
      const target = cache.findByKey(other!, item.source)[0]?.id ?? other!;
      return { kind: kind as LinkKind, target };
    }
  }
  return usage();
}

function printOutcome(o: ApplyOutcome): void {
  if (o.verdicts) {
    console.log(verdictLine('work.verdict.policy', o.verdicts.policy));
    console.log(verdictLine('work.verdict.tracker', o.verdicts.tracker));
    console.log(verdictLine('work.verdict.credential', o.verdicts.credential));
  }
  if (o.preview) console.log(`  ${previewText(o.preview, R)}`);
  if (o.state === 'confirmed') console.log(t('work.outcome.confirmed', R));
  else if (o.pending) console.log(t('work.outcome.pending', R));
  else if (o.state === 'conflict') console.log(t('work.outcome.conflict', R));
  else if (o.state === 'denied') console.log(t('work.outcome.denied', R));
  else console.log(t('work.outcome.failed', R).replace('{reason}', o.reason ?? o.result?.error ?? '?'));
}

function findItem(a: WorkArgs, cache: WorkCache, key: string): WorkItem {
  const found = cache.findByKey(key, a.flag('source'));
  if (!found.length) a.fail(say('sys.work.notFound', { key }));
  if (found.length > 1) a.fail(say('sys.work.ambiguous', { key }));
  return found[0]!;
}

export async function runWork(a: WorkArgs): Promise<void> {
  const cache = openCache(a);
  try {
    switch (a.sub) {
      case 'sync': {
        let failed = false;
        for (const cfg of sources(a)) {
          const provider = providerFor(cfg.provider);
          if (!provider) { console.error(say('sys.work.unknownProvider', { provider: cfg.provider, source: cfg.id })); failed = true; continue; }
          const r = await syncSource(cfg, provider, cache);
          if (r.error) {
            console.error(say('sys.work.syncFailed', { source: cfg.id, error: r.error }));
            failed = true;
          }
          const c = syncCounted(r);
          console.log(`${cfg.id} · sync ${r.syncNo} · ${freshnessText(freshness(cache.getSource(cfg.id)), R)}`);
          console.log(`  ${countedLine([c.pulled, c.changed, c.gone], { zeroes: true })}`);
          console.log(`  ${countedLine([workItemsCounted(cache.listItems({ source: cfg.id }), 'count.scope.workSource')], { zeroes: true })}`);
        }
        if (failed) process.exitCode = 1;
        break;
      }
      case 'list': {
        const srcs = sources(a);
        const state = a.flag('state');
        if (state && !(STATE_CATEGORIES as readonly string[]).includes(state)) a.fail(`--state expects ${STATE_CATEGORIES.join('|')}`);
        const assignee = a.flag('assignee');
        const items = srcs.flatMap((s) => cache.listItems({ source: s.id, ...(state ? { state: state as StateCategory } : {}), ...(assignee ? { assignee } : {}) }));
        if (a.has('json')) {
          const doc: WorkListDocument = { schema: WORK_SCHEMA, generatedAt: new Date().toISOString(), sources: srcs.map((s) => s.id), items };
          console.log(JSON.stringify(doc, null, 2));
          break;
        }
        for (const s of srcs) {
          const mode = t(s.mode === 'edit' ? 'work.mode.edit' : 'work.mode.readOnly', R);
          console.log(`${s.id} · ${mode} · ${freshnessText(freshness(cache.getSource(s.id)), R)}`);
        }
        console.log(countedLine([workItemsCounted(items, srcs.length === 1 ? 'count.scope.workSource' : 'count.scope.workSources')], { zeroes: true }));
        if (!items.length) console.log(`  ${t('work.none', R)}`);
        for (const i of items) console.log(line(i));
        break;
      }
      case 'show': {
        const key = a.positional[0];
        if (!key) a.fail('usage: farsight work show <key> [--source id] [--json]');
        const item = findItem(a, cache, key);
        if (a.has('json')) { console.log(JSON.stringify(item, null, 2)); break; }
        const c = itemCounted(item, cache.linksFor(item.id).length);
        console.log(`${item.key} · ${item.type.name} · ${itemStateText(item, R)}`);
        console.log(item.title);
        console.log(item.url);
        console.log(`  ${t('work.label.assignee', R)}: ${item.assignee?.name ?? t('work.label.unassigned', R)}`);
        if (item.reporter) console.log(`  ${t('work.label.reporter', R)}: ${item.reporter.name}`);
        if (item.parent) console.log(`  ${t('work.label.parent', R)}: ${cache.getItem(item.parent)?.key ?? item.parent}`);
        if (item.labels.length) console.log(`  ${t('work.label.labels', R)}: ${item.labels.join(', ')}`);
        if (item.area) console.log(`  ${t('work.label.area', R)}: ${item.area}`);
        if (item.iteration) console.log(`  ${t('work.label.iteration', R)}: ${item.iteration.name}`);
        if (item.estimate) console.log(`  ${t('work.label.estimate', R)}: ${item.estimate.value} ${item.estimate.unit}`);
        console.log(`  ${t('work.label.updated', R)}: ${item.updated} · ${freshnessText(freshness(cache.getSource(item.source)), R)}`);
        if (item.body?.text) console.log(`\n${item.body.text}\n`);
        console.log(countedLine([c.comments, c.changes, c.links], { zeroes: true }));
        for (const cm of item.comments) console.log(`  ${cm.created.slice(0, 16).replace('T', ' ')}  ${cm.author.name}: ${cm.body.text}`);
        if (item.history.length) console.log(`${t('work.label.history', R)}:`);
        for (const h of item.history) console.log(`  ${h.at.slice(0, 16).replace('T', ' ')}  ${h.by?.name ?? ''}  ${h.field}: ${h.from ?? ''} → ${h.to ?? ''}`);
        break;
      }
      case 'links': {
        const key = a.positional[0];
        if (!key) a.fail('usage: farsight work links <key> [--source id]');
        const item = findItem(a, cache, key);
        const graph = cache.linksFor(item.id);
        console.log(`${item.key} · ${item.title}`);
        console.log(countedLine([itemCounted(item, graph.length).links], { zeroes: true }));
        if (!graph.length) console.log(`  ${t('work.noLinks', R)}`);
        for (const l of graph) console.log(`  ${l.kind} → ${l.node}  (${l.provenance}, ${l.tier}${l.detail ? ` · ${l.detail}` : ''})`);
        if (item.links.length) console.log(`${t('work.label.links', R)}:`);
        for (const l of item.links) console.log(`  ${l.kind} → ${cache.getItem(l.target)?.key ?? l.target}  (${l.native})`);
        break;
      }
      case 'status': {
        for (const cfg of sources(a)) {
          const row = cache.getSource(cfg.id);
          const provider = providerFor(cfg.provider);
          const mode = t(cfg.mode === 'edit' ? 'work.mode.edit' : 'work.mode.readOnly', R);
          console.log(`${cfg.id} · ${cfg.provider} · ${mode} · ${freshnessText(freshness(row), R)}`);
          if (provider) console.log(`  ${capabilityWords(provider.capabilities, R).join(' · ')}`);
          else console.log(`  ${say('sys.work.unknownProvider', { provider: cfg.provider, source: cfg.id })}`);
          if (row?.lastSync) console.log(`  ${t('work.status.lastSync', R).replace('{n}', String(row.lastSync))}${row.lastOkAt ? ` · ${row.lastOkAt}` : ''}`);
          if (row?.lastError) console.log(`  ${row.lastError}`);
          const ob = outboxCounted(cache.listOutbox({ source: cfg.id }));
          console.log(`  ${countedLine([workItemsCounted(cache.listItems({ source: cfg.id }), 'count.scope.workSource'), ob.queued, ob.conflicts], { zeroes: true })}`);
        }
        break;
      }
      case 'comment': case 'assign': case 'move': case 'edit': case 'link': {
        const key = a.positional[0];
        if (!key) a.fail(say('sys.work.usage.write'));
        const item = findItem(a, cache, key);
        const cfg = loadWorkSources(a.workspace).find((s) => s.id === item.source);
        if (!cfg) a.fail(say('sys.work.unknownSource', { source: item.source }));
        const provider = providerFor(cfg.provider);
        if (!provider) a.fail(say('sys.work.unknownProvider', { provider: cfg.provider, source: cfg.id }));
        const action = WRITE_VERBS[a.sub]!;
        const payload = payloadFor(a, cache, a.sub, item, a.positional.slice(1));
        // confirming the same write that is waiting in the outbox confirms that intent, not a second one
        const waiting = a.has('confirm')
          ? cache.listOutbox({ item: item.id, state: 'queued' }).find((r) => r.intent.action === action && JSON.stringify(r.intent.payload) === JSON.stringify(payload))
          : undefined;
        const intent: Intent = waiting?.intent ?? {
          id: randomUUID(), item: item.id, action, payload,
          requestedBy: { kind: 'human', id: `cli:${userInfo().username}` },
        };
        // the source is connected only when the policy lets the write go further
        const outcome = await applyIntent(intent, {
          cfg, provider, cache, confirmed: a.has('confirm'),
          session: () => connectSource(cfg, provider, { schema: cache.getSource(cfg.id)?.schema ?? null }),
        });
        console.log(`${item.key} · ${a.sub} · ${outcome.item ? itemStateText(outcome.item, R) : itemStateText(item, R)}`);
        printOutcome(outcome);
        process.exitCode = outcome.state === 'confirmed' ? 0 : outcome.pending ? 2 : 1;
        break;
      }
      default:
        a.fail('usage: farsight work sync|status|list|show <key>|links <key>|comment|assign|move|edit|link <key> … [--source id] — see farsight --help');
    }
  } finally {
    cache.close();
  }
}
