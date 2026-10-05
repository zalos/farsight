// lib/search-model.js — fast travel's (⌘K) index and ranking, pure and unit-tested
// (packages/server/test/search-model.test.ts). No DOM, no store: the caller hands in the nodes and the
// two name functions, so the same code ranks in the page and in node:test.
//
// The ranking is shell.js `searchNodes` as it was — a node is matched on its identifier and its business
// name in every register, an exact hit on either outranks everything, tags and then the words around it
// (docs, path) count less, and on a tie the product outranks the plumbing — computed per keystroke over
// strings folded **once per graph** instead of per node per keystroke (bizName / bizLabel / lower-casing
// 250k nodes took seconds a key on a thousand-project workspace). A query that extends the last one
// without a new word only re-ranks the nodes the last one matched, and the best twelve are kept as the
// scan goes instead of sorting every match.

/** On a tie the product outranks the plumbing: a journey, then a screen. */
export const KIND_BONUS = { flow: 3, page: 2, route: 1, api: 1, work: 1 };
/** How many results the palette shows. */
export const LIMIT = 12;

/**
 * Fold every searchable node once: what it is matched on, lower-cased. Module and package nodes are left
 * out — fast travel to either arrives nowhere visible.
 * @param {object[]} nodes
 * @param {{ bizName: (n: object) => string, bizLabel: (n: object) => string, repoOf: (n: object) => string }} fns
 */
export function buildSearchIndex(nodes, fns) {
  const index = startSearchIndex(nodes, fns);
  continueSearchIndex(index, Infinity);
  return index;
}

/**
 * The same index, folded a slice at a time: `startSearchIndex` holds the nodes, `continueSearchIndex` folds
 * for about `ms` milliseconds and says whether it finished — so the page can fold in idle time after it
 * boots and the first keystroke finds the index ready. `searchIndex` finishes whatever is left.
 */
export function startSearchIndex(nodes, fns) {
  return { rows: [], nodes, fns, pos: 0, done: false, last: null };
}
export function continueSearchIndex(index, ms) {
  const t0 = Date.now();
  const { nodes, fns } = index;
  while (index.pos < nodes.length) {
    const n = nodes[index.pos++];
    if (n.kind !== 'module' && n.kind !== 'package') index.rows.push(rowOf(n, fns));
    if ((index.pos & 511) === 0 && Date.now() - t0 > ms) return false;
  }
  index.done = true;
  return true;
}
function rowOf(n, fns) {
  const name = String(n.name || '').toLowerCase();
  const tags = (n.tags || []).map(String);
  return {
    n,
    repo: fns.repoOf(n),
    name,
    ident: name.split(':')[0].trim(),
    tail: String(n.id || '').split('::').pop().toLowerCase(),
    words: String(fns.bizName(n)).toLowerCase(),
    label: String(fns.bizLabel(n)).toLowerCase(),
    tags,
    // the rest of what a person might type — tags, docs and the file — as one string, scanned last (the name
    // and the words around it were already tried, so this is what the old haystack added)
    rest: (tags.join(' ') + ' ' + (n.docs || '') + ' ' + ((n.loc && n.loc.path) || '')).toLowerCase(),
    bonus: KIND_BONUS[n.kind] || 0,
  };
}

/** One node's score for a query, the way searchNodes always scored it (0 = no match). */
export function scoreRow(r, raw, terms) {
  let score = 0;
  if (r.ident === raw || r.tail === raw || r.name === raw || r.words === raw || r.label === raw) score += 100;
  for (const term of terms) {
    if (r.ident === term || r.words === term || r.label === term) score += 10;
    else if (r.ident.includes(term) || r.name.includes(term) || r.words.includes(term) || r.label.includes(term)) score += 5;
    else if (r.tags.some((x) => x.includes(term))) score += 4;
    else if (r.rest.includes(term)) score += 1;
  }
  return score > 0 ? score + r.bonus : 0;
}

/**
 * The best `limit` rows for a query, in rank order (score, then the order the graph lists them — the
 * stable sort the palette always used). `repos` narrows to the sources in scope (null = all). Returns
 * `{ hits: [{ n, score }], matched }` — `matched` counts every row with a score.
 */
export function searchIndex(index, q, repos, limit = LIMIT) {
  const raw = String(q || '').trim().toLowerCase();
  const terms = raw.split(/\s+/).filter(Boolean);
  if (!terms.length) { index.last = null; return { hits: [], matched: 0 }; }
  if (!index.done) continueSearchIndex(index, Infinity);
  // a query that only grew its last word matches a subset of what the last one matched
  const last = index.last;
  const narrow = last && last.repos === repos && raw.startsWith(last.raw) && !/\s/.test(raw.slice(last.raw.length));
  const pool = narrow ? last.matches : index.rows;
  const matches = [];
  const top = []; // [{ r, score, i }] best first
  for (let i = 0; i < pool.length; i++) {
    const r = pool[i];
    if (repos && !repos.has(r.repo)) continue;
    const score = scoreRow(r, raw, terms);
    if (!score) continue;
    matches.push(r);
    if (top.length === limit && score <= top[limit - 1].score) continue;
    // insert after every row that scores as high (the earlier row wins a tie)
    let k = top.length;
    while (k > 0 && top[k - 1].score < score) k--;
    top.splice(k, 0, { r, score });
    if (top.length > limit) top.pop();
  }
  index.last = { raw, repos, matches };
  return { hits: top.map((x) => ({ n: x.r.n, score: x.score })), matched: matches.length };
}
