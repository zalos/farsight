/**
 * Doc-comment parsing shared by every language adapter. `/** … *​/` blocks are
 * the same shape in JSDoc/TSDoc/Javadoc; the six Farsight tags plus the
 * vanilla-tag harvest are language-agnostic (see docs/ANNOTATIONS.md).
 */
import type { NodeLink, DesignRef } from '@farsight/core';

export interface ParsedDoc {
  docs?: string;
  /** @business — plain-language description for the business lens. */
  business?: string;
  /** @group — logical grouping the GUI can collapse ("Validate invoice"). */
  group?: string;
  /** @tag / @tags — custom tags, comma or space separated. */
  tags: string[];
  /** @guard [label] — this function is an auth/permission wrapper; callers get 🔒 edges. */
  guard?: string;
  /** @entrypoint [kind:name] — declared entry point (cron/queue job…); parts become searchable tags. */
  entrypoint?: string[];
  /** @covers <target…> — what a test claims to verify: a flow id, a design screen id, `METHOD /path`, a node id, or a symbol name. One per line or comma separated; repeated tags accumulate. */
  covers?: string[];
  /** @see <url> and @design targets — links, not prose (non-URL @see refs stay in the docs text). */
  links?: NodeLink[];
  /** @design <url|id> — the declared join from this code node to its design reference. */
  design?: DesignRef;
  /** @work <KEY…> — the work items this code is for (a Jira key, an Azure DevOps id); also carried as `work:<KEY>` tags. */
  work?: string[];
}

const URL_RE = /^https?:\/\/\S+$/i;

/**
 * `@design <url|id> [name…]` → a DesignRef for a node that exists in code
 * (status `both`; a manifest source may later refine it). A Figma URL keeps
 * its node id (`node-id=26-9` → "26-9"); a bare id ("SCR-07") is the docs' name
 * for the screen.
 */
export function parseDesignTag(value: string): DesignRef | undefined {
  const [target, ...rest] = value.split(/\s+/).filter(Boolean);
  if (!target) return undefined;
  const name = rest.join(' ').trim();
  if (URL_RE.test(target)) {
    let nodeId: string | undefined;
    try { nodeId = new URL(target).searchParams.get('node-id')?.replace(':', '-') ?? undefined; } catch { /* keep url only */ }
    return { status: 'both', origin: 'annotation', url: target, ...(nodeId ? { nodeId } : {}), ...(name ? { name } : {}) };
  }
  return { status: 'both', origin: 'annotation', id: target, ...(name ? { name } : {}) };
}

/** The optional node fields a ParsedDoc contributes beyond docs/tags — spread into addNode by every adapter. */
export function docLinkFields(doc: ParsedDoc): { links?: NodeLink[]; design?: DesignRef } {
  return { ...(doc.links?.length ? { links: doc.links } : {}), ...(doc.design ? { design: doc.design } : {}) };
}

/**
 * Strip TSDoc/JSDoc inline tags to readable text — `{@link t|label}` → label,
 * `{@link t label}` → label (Javadoc `{@link pkg.Cls#m(int) label}` too: label =
 * text after first whitespace), `{@link t}`/`{@code x}`/`{@literal x}` → target,
 * `{@inheritDoc}` → removed.
 */
export function stripInlineTags(text: string): string {
  return text.replace(/\{@(\w+)\s*([^}]*)\}/g, (_m, tag: string, body: string) => {
    if (/^inherit[Dd]oc$/.test(tag)) return '';
    const inner = body.trim();
    if (!inner) return '';
    if (tag === 'code' || tag === 'literal') return inner; // no target/label semantics — keep the whole body
    const pipe = inner.indexOf('|');
    if (pipe >= 0) return inner.slice(pipe + 1).trim();     // {@link target|label}
    // target = up to the first whitespace OUTSIDE parens — `#m(String, long)` is one target
    const m = inner.match(/^([^\s(]+(?:\([^)]*\))?)\s*([\s\S]*)$/);
    if (m && m[2]) return m[2].trim();                       // {@link target label}
    return (m?.[1] ?? inner).replace(/^#/, '');              // bare target, no label
  });
}

/** Prose cleanup: inline tags → text, strip simple HTML tags (Javadoc habit), collapse whitespace. */
export function cleanProse(text: string): string {
  return stripInlineTags(text).replace(/<\/?[a-z][^>]*>/gi, '').replace(/\s+/g, ' ').trim();
}

/**
 * Doc block (`/** … *​/`) immediately above the declaration starting at `start`,
 * with `*`-gutter stripped — or null. `between` is the language's idea of what
 * may sit between the comment and `start` (TS: export/async/const keywords;
 * Java: whitespace only, because tree-sitter declaration nodes include their
 * annotations and modifiers).
 */
export function docCommentAbove(source: string, start: number, between: RegExp): string | null {
  const before = source.slice(0, start);
  const open = before.lastIndexOf('/**');
  if (open < 0) return null;
  const tail = before.slice(open);
  const m = tail.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!m) return null;
  if (!between.test(tail.slice(m[0].length))) return null;
  return m[1]!.replace(/^\s*\*\s?/gm, '').trim();
}

/**
 * Split a doc block into composed prose + graph-recognized tags. Seven Farsight
 * tags (@business @group @tag @guard @entrypoint @design @covers) keep their meaning; the rest is
 * a vanilla JSDoc/TSDoc/Javadoc harvest (see docs/doc-comments.md tag matrix).
 * Unrecognized tags (@param, @returns, @example…) are code detail — dropped.
 */
export function parseDoc(raw: string | null): ParsedDoc {
  if (!raw) return { tags: [] };
  const out: ParsedDoc = { tags: [] };
  const summary: string[] = [];   // @summary — prepended (becomes the summary sentence)
  const prose: string[] = [];     // untagged comment text
  const appended: string[] = [];  // @description / @remarks — appended in encounter order
  const sees: string[] = [];      // @see targets — collected into one line
  let deprecatedLine: string | undefined;
  let sinceLine: string | undefined;
  // tag content runs until the next @tag or end of block
  const parts = raw.split(/^(?=@\w+)/m);
  for (const part of parts) {
    const tagMatch = part.match(/^@(\w+)\s*([\s\S]*)$/);
    if (!tagMatch) {
      const text = cleanProse(part);
      if (text) prose.push(text);
      continue;
    }
    const [, tag, body] = tagMatch;
    const value = body!.trim().replace(/\s+/g, ' ');
    switch (tag) {
      // ── the five Farsight custom tags (unchanged meaning) ──
      case 'business': out.business = cleanProse(value); break;
      case 'group': out.group = cleanProse(value); break;
      case 'tag': case 'tags': out.tags.push(...value.split(/[,\s]+/).filter(Boolean)); break;
      case 'guard': out.guard = value; break; // '' means "guard, named after the function"
      case 'entrypoint': out.entrypoint = value.split(/[:\s]+/).filter(Boolean); break;
      // @covers is a CLAIM by the test author — resolved against the graph by the tests adapter,
      // kept verbatim on the node when nothing matches (docs/proposals/tests-surface.md §3.2)
      case 'covers': {
        // one target per line or comma — never split on spaces: `@covers POST /orders`
        // is a single route, not two targets
        const targets = body!.split(/[\n,]/)
          .map((v) => cleanProse(v).trim())
          .filter((v) => v && v.length <= 120 && !/[(){};=]|^\*|^\/\*/.test(v));
        if (targets.length) (out.covers ??= []).push(...targets);
        break;
      }
      // @work is the sixth Farsight tag (work-items-sync.md §9): a declared link from this
      // code to a tracker's work item. Kept verbatim as a `work:<KEY>` tag; the server joins
      // it to an item only when a configured work source holds that key
      case 'work': {
        const keys = value.split(/[,\s]+/).map((k) => k.replace(/^#/, '').trim()).filter((k) => /^(?:[A-Za-z][A-Za-z0-9_]+-\d+|\d+)$/.test(k));
        for (const k of keys) {
          (out.work ??= []).push(k);
          if (!out.tags.includes(`work:${k}`)) out.tags.push(`work:${k}`);
        }
        break;
      }
      // ── vanilla prose-composing tags ──
      case 'summary': { const t = cleanProse(value); if (t) summary.push(t); break; }
      case 'description': case 'remarks': { const t = cleanProse(value); if (t) appended.push(t); break; }
      // ── vanilla graph-relevant tags ──
      case 'deprecated': {
        out.tags.push('deprecated');
        const reason = cleanProse(value);
        deprecatedLine = reason ? `Deprecated: ${reason.replace(/[.!?]\s*$/, '')}.` : 'Deprecated.';
        break;
      }
      // TSDoc release-stage modifiers — value text (if any) is ignored
      case 'internal': case 'alpha': case 'beta': case 'experimental': out.tags.push(tag); break;
      case 'see': {
        // a URL is a link (rendered as an anchor, never repeated as prose); anything else stays a "See:" ref
        const t = cleanProse(value);
        if (!t) break;
        if (URL_RE.test(t)) (out.links ??= []).push({ kind: 'see', url: t });
        else sees.push(t);
        break;
      }
      case 'design': {
        const d = parseDesignTag(value.trim());
        if (!d) break;
        out.design = d;
        (out.links ??= []).push({ kind: 'design', ...(d.url ? { url: d.url } : {}), ...(d.id ? { ref: d.id } : {}) });
        if (d.id) out.tags.push(`design:${d.id.toLowerCase()}`);
        break;
      }
      case 'since': { const t = cleanProse(value); if (t) sinceLine = `Since ${t.replace(/[.!?]\s*$/, '')}.`; break; }
      // everything else (@param @returns @throws @example @author…) is code detail — dropped
    }
  }
  const tail: string[] = [];
  if (deprecatedLine) tail.push(deprecatedLine);
  if (sees.length) tail.push(`See: ${sees.join(', ')}.`);
  if (sinceLine) tail.push(sinceLine);
  const docParts = [...summary, ...prose, ...appended, ...tail];
  if (docParts.length) out.docs = docParts.join(' ');
  return out;
}
