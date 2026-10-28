// The Spring version scope, read from the captured pom.xml as XML structure: elements by name and nesting, never by
// the order their children happen to appear in. A small, strict reader for what a Maven POM needs: elements, text,
// comments, CDATA and the XML declaration. Anything it cannot read, or any construct that could change the versions
// it reports (profiles, modules, imported BOMs, explicit Spring Security versions, version properties), makes the
// scope unresolved or unsupported, never assumed.

/** One element of a POM read as XML structure, with its children, text and source offsets. */
export interface XmlElement {
  readonly name: string;
  readonly children: XmlElement[];
  text: string;
  /** UTF-16 offsets of the whole element in the source text. */
  readonly start: number;
  end: number;
}

/** Parses the document's root element, or undefined when it is not well-formed enough to trust. */
export function parseXml(text: string): XmlElement | undefined {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? text.length : lt);
    if (chunk.trim()) {
      const t = top();
      if (!t) return undefined;
      t.text += decode(chunk);
    }
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) return undefined;
      i = e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) return undefined;
      const t = top();
      if (!t) return undefined;
      t.text += text.slice(lt + 9, e);
      i = e + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) return undefined;
      i = e + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) return undefined; // a DOCTYPE or entity declaration: not part of a POM we trust
    const gt = findTagEnd(text, lt + 1);
    if (gt < 0) return undefined;
    const body = text.slice(lt + 1, gt);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (!open || localName(name) !== open.name) return undefined;
      open.end = gt + 1;
      i = gt + 1;
      continue;
    }
    const selfClosing = body.endsWith('/');
    const m = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!m) return undefined;
    const el: XmlElement = { name: localName(m[1]!), children: [], text: '', start: lt, end: gt + 1 };
    const parent = top();
    if (parent) parent.children.push(el);
    else if (root)
      return undefined; // two roots
    else root = el;
    if (!selfClosing) stack.push(el);
    i = gt + 1;
  }
  return stack.length === 0 ? root : undefined;
}

function findTagEnd(text: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < text.length; j++) {
    const c = text[j]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}
const localName = (n: string) => (n.includes(':') ? n.slice(n.indexOf(':') + 1) : n);
const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The first child element of `el` with this name; undefined when there is none. */
export const child = (el: XmlElement | undefined, name: string): XmlElement | undefined =>
  el?.children.find((c) => c.name === name);
/** Every child element of `el` with this name, in document order. */
export const childrenNamed = (el: XmlElement | undefined, name: string): XmlElement[] =>
  el?.children.filter((c) => c.name === name) ?? [];
/** An element's text, trimmed; undefined when there is no element. */
export const textOf = (el: XmlElement | undefined): string | undefined => (el ? el.text.trim() : undefined);

/** Whether the POM selects the modeled Spring versions on the servlet stack, with the elements it rests on. */
export type PomVerdict =
  | { readonly ok: true; readonly evidence: readonly XmlElement[] }
  | {
      readonly ok: false;
      readonly reason:
        | 'sentinel.spring.versionUnresolved'
        | 'sentinel.spring.versionUnsupported'
        | 'sentinel.spring.reactiveUnsupported';
      readonly evidence: readonly XmlElement[];
    };

/** Reads the Boot parent and starters from a POM's structure and decides whether this pack's version scope holds. */
export function pomScope(text: string, boot: string): PomVerdict {
  const project = parseXml(text);
  if (!project || project.name !== 'project')
    return { ok: false, reason: 'sentinel.spring.versionUnresolved', evidence: [] };
  const parent = child(project, 'parent');
  const isBootParent =
    textOf(child(parent, 'groupId')) === 'org.springframework.boot' &&
    textOf(child(parent, 'artifactId')) === 'spring-boot-starter-parent';
  if (!parent || !isBootParent)
    return { ok: false, reason: 'sentinel.spring.versionUnresolved', evidence: parent ? [parent] : [] };
  // Maven resolves a parent from its relativePath first (default ../pom.xml): a local parent with the same coordinates
  // could manage other versions. Only an explicit empty relativePath (repository lookup) is followed.
  const relativePath = child(parent, 'relativePath');
  if (!relativePath || textOf(relativePath) !== '' || relativePath.children.length) {
    return { ok: false, reason: 'sentinel.spring.versionUnresolved', evidence: [parent] };
  }
  const version = child(parent, 'version');
  if (!textOf(version)) return { ok: false, reason: 'sentinel.spring.versionUnresolved', evidence: [parent] };
  if (textOf(version) !== boot) return { ok: false, reason: 'sentinel.spring.versionUnsupported', evidence: [parent] };
  const evidence: XmlElement[] = [parent];
  const unsupported = (el: XmlElement): PomVerdict => ({
    ok: false,
    reason: 'sentinel.spring.versionUnsupported',
    evidence: [...evidence, el],
  });
  // Constructs that can change the dependency set or its versions in ways this pack does not follow.
  for (const name of ['profiles', 'modules']) {
    const el = child(project, name);
    if (el && el.children.length) return unsupported(el);
  }
  for (const p of child(project, 'properties')?.children ?? []) {
    if (/(^|[.-])(spring|security|boot)([.-]|$)/i.test(p.name) && /version/i.test(p.name)) return unsupported(p);
  }
  const managed = childrenNamed(child(child(project, 'dependencyManagement'), 'dependencies'), 'dependency');
  if (managed.length) return unsupported(managed[0]!);
  const deps = childrenNamed(child(project, 'dependencies'), 'dependency');
  let web: XmlElement | undefined;
  let security: XmlElement | undefined;
  for (const d of deps) {
    const g = textOf(child(d, 'groupId'));
    const a = textOf(child(d, 'artifactId'));
    const v = child(d, 'version');
    if (g === 'org.springframework.security' && v) return unsupported(d);
    if (g === 'org.springframework.boot' && v && textOf(v) !== boot) return unsupported(d);
    if (g === 'org.springframework.boot' && a === 'spring-boot-starter-webflux')
      return { ok: false, reason: 'sentinel.spring.reactiveUnsupported', evidence: [...evidence, d] };
    if (g === 'org.springframework.boot' && a === 'spring-boot-starter-web') web = d;
    if (g === 'org.springframework.boot' && a === 'spring-boot-starter-security') security = d;
  }
  if (!web || !security) return { ok: false, reason: 'sentinel.spring.versionUnresolved', evidence };
  return { ok: true, evidence: [...evidence, web, security] };
}
