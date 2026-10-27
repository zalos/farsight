/**
 * Budgeted answers (round 2026-10-10, proposal 9). An agent pays for every token it reads, so every tool's
 * answer is held to a budget, and an answer over it is **cut at a clean boundary** — a whole section, a
 * journey's segment, a list's rows — never mid-line. What was cut is not silently gone: the answer ends with
 * `## left out`, naming the ids the cut parts held and the exact call that returns them (`expand`).
 *
 * The count is rough on purpose: a token is taken as four characters (`estimateTokens`), which over-counts
 * prose a little and under-counts ids a little; the define says so. A JSON answer is a contract (the frozen
 * documents, a `raw` surface) and is returned whole: cutting it would hand a CI job an invalid document.
 *
 * Pure: text in, text and the left-out parts out. The server keeps the parts so `expand` can return them.
 */

/** The default budget, in tokens, when neither the call nor `.farsight/settings.json → mcp.budget` names one. */
export const DEFAULT_BUDGET = 8000;
/** The smallest budget a call may ask for — below it even the head of an answer does not fit. */
export const MIN_BUDGET = 500;
/** Characters per token in the rough count. */
export const CHARS_PER_TOKEN = 4;

/** A rough token count: characters ÷ 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** One part of an answer that was left out: where it sat (its heading path), the ids it named, its text. */
export interface LeftOutPart {
  /** the headings above it, outermost first (`what the system does › segment 4 · Review`); empty for rows of the head */
  where: string[];
  /** a heading block's own heading, or null for loose rows */
  heading: string | null;
  /** the graph ids the part names in backticks (`repo::path::name`), in order, each once */
  ids: string[];
  /** how many lines it held */
  lines: number;
  text: string;
}

export interface BudgetCut {
  /** the answer as sent: the kept part, then `## left out` when anything was cut */
  text: string;
  /** false when the answer fit (then `text` is the input unchanged) */
  cut: boolean;
  budget: number;
  /** the whole answer's rough size */
  tokens: number;
  leftOut: LeftOutPart[];
  /** every id the left-out parts name, each once — `excluded_by_budget` */
  excluded: string[];
}

/** A node of the answer's outline: a heading with what is under it, or one row. */
interface Block {
  heading: string | null;
  level: number;
  lines: string[]; // the heading line (if any) and its loose rows, before any child heading
  children: Block[];
}

const HEADING = /^(#{1,6}) +\S/;
/** an id in backticks: anything with a `::` (graph node ids are `repo::…`), or a `cut:N` handle */
const ID_IN_TICKS = /`([^`\s]*::[^`]*)`/g;

/** The graph ids a piece of text names in backticks, in order, each once. */
export function idsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  ID_IN_TICKS.lastIndex = 0;
  for (let m = ID_IN_TICKS.exec(text); m; m = ID_IN_TICKS.exec(text)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Outline the answer: line 0 and every row before the first heading are the head; headings nest by level. */
function outline(lines: string[]): { head: string[]; blocks: Block[] } {
  const head: string[] = [];
  const root: Block = { heading: null, level: 0, lines: [], children: [] };
  const stack: Block[] = [root];
  let i = 0;
  // the head: everything before the first heading after line 0 (a `# title` on line 0 is the head's own)
  for (; i < lines.length; i++) {
    if (i > 0 && HEADING.test(lines[i]!)) break;
    head.push(lines[i]!);
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop();
      const b: Block = { heading: line.replace(/^#+ +/, ''), level, lines: [line], children: [] };
      stack[stack.length - 1]!.children.push(b);
      stack.push(b);
    } else {
      // a row belongs to the deepest heading open above it — which never has children yet, so a block's own
      // rows always come before its children, as `blockText` prints them
      stack[stack.length - 1]!.lines.push(line);
    }
  }
  return { head, blocks: root.children };
}

const blockText = (b: Block): string =>
  [b.lines.join('\n'), ...b.children.map(blockText)].filter((x) => x !== '').join('\n');
const blockSize = (b: Block): number => blockText(b).length + 1;

/**
 * Cut `text` to `budget` tokens. `call` names the tool and its arguments, so `## left out` can print the exact
 * call that returns the whole answer (the same call with a larger budget) beside the `expand` call. `handle`
 * is the server's name for this cut (`cut:3`), which `expand` also takes. Returns the input unchanged when it
 * fits, or when it is a JSON document.
 */
export function cutToBudget(
  text: string,
  budget: number,
  call: { tool: string; args?: Record<string, unknown> } = { tool: '?' },
  handle?: string,
): BudgetCut {
  const tokens = estimateTokens(text);
  const whole: BudgetCut = { text, cut: false, budget, tokens, leftOut: [], excluded: [] };
  if (tokens <= budget || isJson(text)) return whole;

  const lines = text.split('\n');
  const { head, blocks } = outline(lines);
  // room for the kept part: the budget less what `## left out` itself takes. Estimated first, then checked: when
  // the section came out longer than the estimate, the cut is made again with that much less room
  let reserve = Math.min(Math.floor(budget * CHARS_PER_TOKEN * 0.2), 2000);
  let result = cutOnce(head, blocks, budget * CHARS_PER_TOKEN - reserve);
  for (let tries = 0; tries < 4; tries++) {
    const excluded = [...new Set(result.leftOut.flatMap((p) => p.ids))];
    const section = leftOutSection({
      budget,
      tokens,
      leftOut: result.leftOut,
      excluded,
      call,
      ...(handle ? { handle } : {}),
    });
    const out = [...result.kept, '', ...section].join('\n');
    if (estimateTokens(out) <= budget || tries === 3)
      return { text: out, cut: true, budget, tokens, leftOut: result.leftOut, excluded };
    reserve += out.length - budget * CHARS_PER_TOKEN + 200;
    result = cutOnce(head, blocks, budget * CHARS_PER_TOKEN - reserve);
  }
  return whole; // not reached
}

/**
 * One pass of the cut with `room` characters. A cut is a prefix: once a part is left out, every part after it is
 * too. A section (`#`, `##`) that does not fit whole is opened — its heading and the rows that fit are kept, then
 * its children are tried; a deeper part (a journey's `### segment`, an `#### action`) is kept whole or left out
 * whole, unless it is the first part of its parent (then its rows are cut, so something of it is read).
 */
function cutOnce(head: string[], blocks: Block[], room: number): { kept: string[]; leftOut: LeftOutPart[] } {
  const kept: string[] = [];
  const leftOut: LeftOutPart[] = [];
  let full = false;
  const leave = (where: string[], heading: string | null, body: string) => {
    if (!body.trim()) return;
    leftOut.push({ where, heading, ids: idsIn(body), lines: body.split('\n').length, text: body });
  };
  // the head is kept row by row: its first line always, so the answer still says what it is
  for (const [i, line] of head.entries()) {
    if (i === 0 || line.length + 1 <= room) {
      kept.push(line);
      room -= line.length + 1;
    } else {
      full = true;
      leave([], null, head.slice(i).join('\n'));
      break;
    }
  }
  const walk = (bs: Block[], where: string[]) => {
    let keptHere = 0;
    for (const b of bs) {
      if (full) {
        leave(where, b.heading, blockText(b));
        continue;
      }
      const size = blockSize(b);
      if (size <= room) {
        kept.push(blockText(b));
        room -= size;
        keptHere++;
        continue;
      }
      const openable = b.level <= 2 || keptHere === 0;
      const headLine = b.lines[0]!;
      if (!openable || headLine.length + 1 > room) {
        full = true;
        leave(where, b.heading, blockText(b));
        continue;
      }
      kept.push(headLine);
      room -= headLine.length + 1;
      keptHere++;
      const inner = [...where, b.heading ?? ''];
      let r = 1;
      for (; r < b.lines.length; r++) {
        const line = b.lines[r]!;
        if (line.length + 1 > room) break;
        kept.push(line);
        room -= line.length + 1;
      }
      if (r < b.lines.length) {
        full = true;
        leave(inner, null, b.lines.slice(r).join('\n'));
      }
      walk(b.children, inner);
    }
  };
  walk(blocks, []);
  return { kept, leftOut };
}

/** The ids `## left out` prints by name before it says how many more there are. */
const IDS_SHOWN = 40;
/** The left-out sections it names by heading before it counts the rest. */
const PARTS_SHOWN = 12;

/**
 * `## left out`: why, what (by heading, then the ids), and the two calls that return it — `expand` with the ids
 * (or the cut's handle, which returns everything), and the same call again with a budget the whole answer fits.
 * Then the same facts as one JSON line, `excluded_by_budget` and `expand`, for an agent that parses.
 */
export function leftOutSection(o: {
  budget: number;
  tokens: number;
  leftOut: LeftOutPart[];
  excluded: string[];
  call: { tool: string; args?: Record<string, unknown> };
  handle?: string;
}): string[] {
  const parts = o.leftOut;
  const rows = parts.reduce((s, p) => s + p.lines, 0);
  const out = [
    '## left out',
    `cut to stay under the budget of ${o.budget} tokens (a rough count: characters ÷ 4; the whole answer is about ${o.tokens}) — ${rows} line(s) in ${parts.length} part(s), naming ${o.excluded.length} id(s):`,
  ];
  for (const p of parts.slice(0, PARTS_SHOWN)) {
    const where =
      [...p.where.filter(Boolean), ...(p.heading ? [p.heading] : [])].map(shortHeading).join(' › ') ||
      'the head of the answer';
    out.push(`- ${where} — ${p.lines} line(s)${p.ids.length ? `, ${p.ids.length} id(s)` : ''}`);
  }
  if (parts.length > PARTS_SHOWN) out.push(`- … +${parts.length - PARTS_SHOWN} more part(s)`);
  if (o.excluded.length) {
    out.push(
      `ids: ${o.excluded
        .slice(0, IDS_SHOWN)
        .map((id) => `\`${id}\``)
        .join(' · ')}${o.excluded.length > IDS_SHOWN ? ` · … +${o.excluded.length - IDS_SHOWN} more` : ''}`,
    );
  }
  const expandIds = o.handle ? [o.handle] : o.excluded.slice(0, IDS_SHOWN);
  const again = { ...(o.call.args ?? {}), budget: Math.ceil(o.tokens * 1.1) };
  out.push(
    `expand them: expand ${JSON.stringify({ ids: expandIds })}${o.handle ? ` (${o.handle} returns every part left out of this answer; ids return the parts that name them)` : ''} — or the whole answer: ${o.call.tool} ${JSON.stringify(again)}`,
  );
  // the JSON line names the same ids, as many as the text does; `excluded_total` says how many there are in all
  out.push(
    JSON.stringify({
      excluded_by_budget: o.excluded.slice(0, IDS_SHOWN),
      ...(o.excluded.length > IDS_SHOWN ? { excluded_total: o.excluded.length } : {}),
      expand: { tool: 'expand', args: { ids: expandIds } },
    }),
  );
  return out;
}

/** A heading as `## left out` names it: up to its first ` — ` (a segment's counts follow it), at most 70 characters. */
export function shortHeading(h: string): string {
  const name = h.split(' — ')[0]!.trim();
  return name.length > 70 ? `${name.slice(0, 69)}…` : name;
}

/** A JSON document (an object or an array that parses) — returned whole, never cut. */
export function isJson(text: string): boolean {
  const s = text.trimStart();
  if (!(s.startsWith('{') || s.startsWith('['))) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The budget a call runs under: its own, else the workspace's, else the default; never under the floor. */
export function budgetFor(asked: number | undefined, workspace: number | undefined): number {
  const b = asked ?? workspace ?? DEFAULT_BUDGET;
  return Math.max(MIN_BUDGET, Math.floor(b));
}
