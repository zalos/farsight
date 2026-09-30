// The WORK surface's words (Lane E — the HUD side of work items). Spread into
// STRINGS in strings.ts; kept apart so the server lane's `work.*` block and this
// one merge without touching each other. Same rules as the rest of the catalog:
// both registers, a define on every word a reader may not know, defines in plain
// words (no backticks, no markdown, no dotted identifiers, no placeholders).
import type { StringEntry } from './strings.js';

function same(word: string, define?: string): StringEntry {
  return define ? { hud: word, professional: word, define } : { hud: word, professional: word };
}
function one(word: string, pluralKey: string): StringEntry {
  return { hud: word, professional: word, singularOf: pluralKey };
}

export const WORK_HUD_STRINGS: Record<string, StringEntry> = {
  'nav.work': {
    hud: 'Bounty Board',
    professional: 'Work',
    define: 'Work items from the trackers this workspace reads, such as Jira and Azure DevOps: who is on each one, where it stands, and what it changed in the code.',
  },
  'sys.workFailed': {
    hud: 'Could not load the work items.',
    professional: 'Could not load the work items.',
    invariant: true,
    define: 'The request did not return an answer. Nothing on this page is measured, and no absence shown here is a fact about the trackers.',
  },
  'work.hud.sub': same(
    'What the trackers say is being worked on, as of their last sync, joined to the code it changed. The tracker’s own words for every state sit beside the colour.',
    'The Work surface reads the trackers through Farsight’s cache: every item is as of the last sync of its source, and every write goes through your policy, the tracker and the credential before it is sent.',
  ),
  'work.hud.loading': same('loading work items…', 'The page has asked the server for the work items and has no answer yet. This is not an empty result.'),
  'work.hud.retry': same('ask again', 'Repeat the same request. Nothing on the page is kept from the failure.'),
  'work.hud.empty': same('No work source is configured in this workspace.',
    'No tracker is connected. A work source is added to the workspace settings with its tracker, its site and its mode; until then nothing here is a fact about the work.'),

  // views
  'work.hud.view.list': { hud: 'Ledger', professional: 'List', define: 'One row per work item, newest change first.' },
  'work.hud.view.board': { hud: 'Board', professional: 'Board', define: 'The same items in columns by where they stand: to do, in progress, done, removed.' },
  'work.hud.view.sources': { hud: 'Outposts', professional: 'Sources', define: 'The trackers this workspace reads, what each one lets Farsight do, and the writes waiting to be sent.' },

  // filters
  'work.hud.filter.source': same('source', 'Only the items of one tracker.'),
  'work.hud.filter.state': same('state', 'Only the items that stand in one place: to do, in progress, done or removed.'),
  'work.hud.filter.assignee': same('assignee', 'Only the items one person is on, or the ones nobody is on.'),
  'work.hud.filter.search': same('search titles and keys'),
  'work.hud.filter.all': same('all'),
  'work.hud.filter.anyone': same('anyone'),
  'work.hud.filter.clear': same('clear filters'),

  // a breakdown part (the state parts are count.part.work*)
  'work.hud.part.parts': same('{n} parts'),

  // counts (every one arrives from the server as a typed count)
  'work.hud.count.sources': same('{n} trackers', 'The work sources this workspace reads, each counted once, whether or not it answered at its last sync.'),
  'work.hud.count.sourcesOne': one('1 tracker', 'work.hud.count.sources'),
  'work.hud.count.commits': same('{n} commits', 'Commits that name this item: in their subject, on a branch named after it, in a merge, or through a link. Each commit counted once.'),
  'work.hud.count.commitsOne': one('1 commit', 'work.hud.count.commits'),
  'work.hud.count.commitsBiz': same('{n} code changes', 'Changes to the code that name this piece of work, each counted once.'),
  'work.hud.count.commitsBizOne': one('1 code change', 'work.hud.count.commitsBiz'),
  'work.hud.count.touched': same('{n} parts touched', 'The distinct parts of the code that the commits naming this item changed, across all of them. A part two commits changed is counted once.'),
  'work.hud.count.touchedOne': one('1 part touched', 'work.hud.count.touched'),

  // scopes
  'work.hud.scope.flow': same('linked to this journey', 'What the number beside it counts over: the work items linked to this journey or to one of its screens, each counted once.'),
  'work.hud.scope.node': same('linked to this part', 'What the number beside it counts over: the work items linked to this one part of the code.'),

  // source cards
  'work.hud.provider.jira': same('Jira'),
  'work.hud.provider.ado': same('Azure DevOps'),
  'work.hud.provider.fixture': same('recorded tracker', 'A tracker recorded to files, used for tests and demonstrations. Nothing it says is live.'),
  'work.hud.src.as': same('as {name}'),
  'work.hud.cap.head': same('can', 'What this tracker lets Farsight do, as the tracker declares it: never assumed.'),
  'work.hud.cap.commentsRw': same('reads and writes comments'),
  'work.hud.cap.commentsRo': same('reads comments'),
  'work.hud.cap.actions': same('may {actions}'),
  'work.hud.cap.revision': same('checks the item’s version before a write', 'Before sending a change, Farsight asks the tracker whether the item is still the version it read. If not, the change waits as a conflict for a person to decide.'),
  'work.hud.cap.compare': same('checks the last update before a write', 'Before sending a change, Farsight reads when the item last changed. If it changed since Farsight read it, the change waits as a conflict for a person to decide.'),
  'work.hud.cap.moveGraph': same('knows every state move in advance'),
  'work.hud.cap.movePerItem': same('asks per item which moves exist'),

  // freshness — never a bare timestamp
  'work.hud.syncNow': { hud: 'Resync', professional: 'sync now', define: 'Ask every work source for what changed since its last sync, now. The page redraws with the answer.' },
  'work.hud.syncing': same('syncing…'),

  // the list
  'work.hud.col.item': same('item'),
  'work.hud.col.state': same('state', 'Where the item stands: the colour and word are the category, the words beside them the tracker’s own state name.'),
  'work.hud.col.type': same('type'),
  'work.hud.col.links': same('linked', 'Parts of the code this item is linked to.'),
  'work.hud.col.commits': same('commits', 'Commits that name this item.'),
  'work.hud.col.commitsBiz': same('code changes', 'Changes to the code that name this piece of work.'),

  // the item pane
  'work.hud.back': same('all work'),
  'work.hud.openIn': same('open in {tracker}'),
  'work.hud.pane.description': same('Description'),
  'work.hud.pane.comments': same('Comments'),
  'work.hud.pane.history': same('History', 'Changes to the item’s fields as the tracker recorded them, oldest first.'),
  'work.hud.pane.changed': same('What this work changed', 'The commits that name this item and the parts of the code they changed, read from the repository’s history.'),
  'work.hud.pane.links': same('Linked parts', 'The parts of the code this item is about, each with how the link was found and how sure it is.'),
  'work.hud.pane.findings': same('Where the tracker and the code disagree', 'A fact from the tracker beside a fact from the code that does not agree with it. Both are shown; neither wins.'),
  'work.hud.pane.raw': same('Raw record', 'The tracker’s own record of this item, as it was read.'),
  'work.hud.pane.waiting': same('Waiting to be written', 'Writes to this item that have not been sent: some wait for a person to confirm them, some for a person to decide a conflict.'),
  'work.hud.field.type': same('type'),
  'work.hud.noDescription': same('nobody wrote a description'),
  'work.hud.noComments': same('no comments yet'),
  'work.hud.noHistory': same('no field changes recorded'),
  'work.hud.noCommits': same('no commit names this item', 'No commit subject, branch, merge or link in the repository’s history names this item. It says nothing about work done outside the history Farsight read.'),
  'work.hud.noLinks': same('no part of the code is linked to this item'),
  'work.hud.loadingItem': same('loading the work item…'),

  // the closed set of write actions, in words
  'work.hud.action.comment': same('comment'),
  'work.hud.action.edit': same('edit'),
  'work.hud.action.assign': same('assign'),
  'work.hud.action.transition': same('move'),
  'work.hud.action.link': same('link'),
  'work.hud.action.label': same('label'),
  'work.hud.action.create': same('create'),

  // edits
  'work.hud.edit.assign': same('assign'),
  'work.hud.edit.move': same('move to'),
  'work.hud.edit.comment': same('add a comment'),
  'work.hud.edit.post': same('post comment'),
  'work.hud.edit.title': same('edit title'),
  'work.hud.edit.description': same('edit description'),
  'work.hud.edit.save': same('save'),
  'work.hud.edit.cancel': same('cancel'),
  'work.hud.edit.pick': same('pick a person'),
  'work.hud.edit.preview': same('preview', 'Ask the tracker to check this change without saving it. Only a tracker that can check a write offers it; nothing is written.'),
  'work.hud.edit.nobody': same('nobody'),
  'work.hud.edit.readOnly': same('read-only: this source takes no edits from here', 'The source is set to read-only in the workspace settings. Change its mode to edit to write from here.'),
  'work.hud.edit.notGranted': same('your policy does not grant: {actions}', 'The workspace policy for this source does not allow these writes. A grant is added in the source’s permissions in the workspace settings.'),

  // the answer to a write
  'work.hud.ans.sending': same('sending…'),
  'work.hud.ans.previewed': same('preview: the tracker would take this, nothing was written', 'The tracker checked the change without saving it and did not refuse it. The item is unchanged; save to send it.'),
  'work.hud.ans.applied': same('applied: the tracker now says so', 'The tracker took the change, and Farsight read the item back from it. What is shown is the tracker’s copy.'),
  'work.hud.ans.pending': same('waiting for your confirmation', 'The policy puts a person between this request and the tracker. Nothing has been written; confirm to send it, drop to forget it.'),
  'work.hud.ans.confirm': same('confirm'),
  'work.hud.ans.drop': same('drop'),
  'work.hud.ans.conflict': same('the tracker changed since your copy', 'The item changed in the tracker after Farsight read it, so the write was not sent. Re-base to send it over the tracker’s version, or drop it.'),
  'work.hud.ans.theirs': same('the tracker now says'),
  'work.hud.ans.yours': same('you asked for'),
  'work.hud.ans.rebase': same('re-base'),
  'work.hud.ans.denied': same('not allowed: nothing was written', 'A write is sent only when your policy, the tracker and the credential all say yes. At least one said no; each answer is printed.'),
  'work.hud.ans.policy': same('your policy says'),
  'work.hud.ans.tracker': same('{tracker} says'),
  'work.hud.ans.credential': same('the credential can'),
  'work.hud.ans.failed': same('the write failed', 'The request did not complete. The tracker’s own words, where it gave any, are printed beside it.'),
  'work.hud.ans.dropped': same('dropped: nothing was written'),
  'work.hud.ans.yes': same('yes'),
  'work.hud.ans.no': same('no'),
  'work.hud.attrib.agent': same('written by an agent through Farsight', 'An AI agent asked for this comment through Farsight, and a person confirmed it before it was sent. It is sent as that person.'),
  'work.hud.attrib.human': same('asked by a person'),

  // what this work changed
  'work.hud.via.subject': same('named in the subject'),
  'work.hud.via.branch': same('on its branch'),
  'work.hud.via.merge': same('in a merge'),
  'work.hud.via.url': same('by its link'),
  'work.hud.via.declared': same('declared', 'Somebody wrote the link down: on a screen in the design manifest, or in a comment in the code.'),
  'work.hud.via.commit': same('through a commit'),
  'work.hud.tier.high': same('certain', 'Declared by a person, so the link is as sure as the person who wrote it.'),
  'work.hud.tier.medium': same('detected', 'Found through the history: a commit or a branch names the item, and the files it changed hold this part.'),
  'work.hud.tier.low': same('a name match', 'Only a link or a name in the item’s text matches this part. Treat it as a lead, not a fact.'),
  'work.hud.fstatus.added': same('added'),
  'work.hud.fstatus.modified': same('modified'),
  'work.hud.fstatus.deleted': same('deleted'),
  'work.hud.fstatus.renamed': same('renamed'),
  'work.hud.diff.show': same('show the change'),
  'work.hud.diff.hide': same('hide the change'),
  'work.hud.diff.loading': same('reading the commit…'),
  'work.hud.diff.failed': same('could not read this commit', 'The repository did not give the change back: the commit may be outside the checkout Farsight reads.'),
  'work.hud.seeImpact': same('see what uses these', 'Opens the change-impact panel on the parts this work touched, one at a time: what uses each part, by distance.'),
  'work.hud.finding.doneNotBuilt': same('done, not built', 'The tracker says the item is finished and no code Farsight read is linked to it.'),
  'work.hud.finding.todoButCommitted': same('to do, but committed', 'The tracker says nobody has started, and commits already name the item.'),
  'work.hud.finding.noCode': same('no code', 'No part of the code is linked to this item.'),
  'work.hud.finding.other': same('disagreement'),
  'work.hud.prov.tracker': same('the tracker says'),
  'work.hud.prov.code': same('the code says'),

  // chips on other surfaces
  'work.hud.chip.trackedBy': same('tracked by {item} ({state}, {source})', 'A work item in a tracker is linked to this part of the code. Open it for what was asked and what changed.'),
  'work.hud.insp.head': same('Tracked work'),
  'work.hud.outbox.head': same('Waiting to be written', 'Writes that have not been sent to a tracker: the ones a person must confirm, and the ones stopped by a conflict.'),
  'work.hud.outbox.empty': same('nothing is waiting'),
  'work.hud.outbox.agent': same('asked by an agent'),
};
