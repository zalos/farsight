// lib/copy-doors.js — copy as MCP call · curl · CLI, on every record (round 2026-10-10, proposal 9).
//
// A person reading the HUD often briefs an agent next. Every record a tool can answer — a gate, a call, a record,
// a journey or a screen, a test, a package, a number — carries three copy doors: the MCP call an agent makes, the
// curl against this server, and the CLI line, each with the record's **full id**, so what is pasted is exactly
// what was on screen. The doors are not code: an agent brief is the business reader's too, so every register
// draws them.
//
// Pure: no DOM, no catalog. `word` is a catalog key the surface translates; `text` is what lands on the clipboard.
// lib/detail-doors.js draws them (`copyDoorsHtml`) and answers the press.

/** The kinds a caller may name, folded onto the tool that answers each. */
const KIND = {
  gate: 'gate', guard: 'gate', rule: 'gate',
  call: 'node', route: 'node', function: 'node',
  record: 'node', table: 'node', store: 'node', message: 'node', queue: 'node', external: 'node',
  journey: 'journey', flow: 'journey', screen: 'journey', page: 'journey', component: 'journey',
  test: 'test',
  package: 'package',
  count: 'count',
};

/** A value in single quotes for a POSIX shell (a `'` closes, escapes and reopens). */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** `tool {"arg":"value"}` — the MCP call as an agent writes it, its arguments as JSON. */
function mcp(tool, args) {
  return tool + ' ' + JSON.stringify(args || {});
}

function curl(origin, path) {
  return 'curl -s ' + shellQuote((origin || 'http://localhost:4477') + path);
}

/** The package's own name: `repo::package::name` → `name`. */
function packageName(node) {
  if (node.package && node.package.name) return node.package.name;
  const id = String(node.id || '');
  const at = id.indexOf('::package::');
  return at >= 0 ? id.slice(at + '::package::'.length) : (node.name || id);
}

/**
 * The three copy doors of one record: `[{ via, word, text }]` in the order they are drawn (MCP · curl · CLI), or
 * `[]` when the record has no id (a count with no re-check). `ctx.origin` is this server's origin, for curl.
 *
 * @param {string} kind  gate · guard · rule · call · route · function · record · table · store · message · queue · external · journey · flow · screen · page · component · test · package · count
 * @param {any} node     the graph node (a `Counted` for `count`)
 * @param {{ origin?: string }} [ctx]
 * @returns {{ via: 'mcp'|'curl'|'cli', word: string, text: string }[]}
 */
export function copyDoors(kind, node, ctx = {}) {
  if (!node) return [];
  const row = KIND[kind] || 'node';
  const origin = ctx.origin;
  const out = (m, c, l) => [
    { via: 'mcp', word: 'door.copy.mcp', text: m },
    { via: 'curl', word: 'door.copy.curl', text: c },
    { via: 'cli', word: 'door.copy.cli', text: l },
  ].filter((d) => d.text);
  if (row === 'count') {
    const r = node.recheck;
    if (!r || !r.cli) return [];
    return out(r.mcp ? mcp(r.mcp, {}) : '', curl(origin, '/api/state'), r.cli);
  }
  const id = node.id;
  if (!id) return [];
  const enc = encodeURIComponent(id);
  if (row === 'gate') return out(mcp('gate', { node_id: id }), curl(origin, '/api/gate?node=' + enc), 'farsight impact ' + shellQuote(id) + ' --tests');
  if (row === 'journey') {
    // a journey walks from its flow; a screen or a page is an entry the journey tool takes too
    return out(mcp('journey', { entry: id }), curl(origin, '/api/journey?entry=' + enc),
      node.kind === 'flow' || kind === 'flow' || kind === 'journey' ? 'farsight journeys' : 'farsight impact ' + shellQuote(id) + ' --flows');
  }
  if (row === 'test') return out(mcp('test_coverage', { test: id }), curl(origin, '/api/tests?node=' + enc), 'farsight tests list'); // str:ok a command line, not prose
  if (row === 'package') {
    const name = packageName(node);
    return out(mcp('describe_node', { node_id: id }), curl(origin, '/api/deps/where?package=' + encodeURIComponent(name)), 'farsight deps where ' + shellQuote(name)); // str:ok a command line, not prose
  }
  return out(mcp('describe_node', { node_id: id }), curl(origin, '/api/impact?node=' + enc), 'farsight impact ' + shellQuote(id) + ' --tests');
}
