/**
 * Java language adapter — Spring Boot aware. tree-sitter (WASM) for syntax,
 * heuristic extraction for meaning, same GraphFragment contract as ts-js:
 * classes/methods, routes from mapping annotations, guards from method
 * security, tables from JPA entities, reads/writes through Spring Data
 * repositories, queues from Kafka/Rabbit templates+listeners, rules from Bean
 * Validation DTOs, Javadoc via the shared doc harvest, Journey branches with
 * `// @business` labels.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve as resolvePath } from 'node:path';
import type { GraphFragment, GraphNode, GraphEdge, NodeKind } from '@farsight/core';
import type { LanguageAdapter, IngestOptions } from '../types.js';
import { collectFiles, freshnessMeta } from '../shared/files.js';
import { parseDoc, docCommentAbove, docLinkFields, type ParsedDoc } from '../shared/docs.js';
import { capLabel } from '../shared/labels.js';
import { autoTags, normalizePath, snippetRange } from '../shared/tags.js';
import { grammarParser, walkTS, childrenOfType, findFirst, type TSNode } from '../treesitter/harness.js';
import { extractJavaBranches } from './branches.js';
import {
  annotationsOf, hasAnn, getAnn, annString, routeMapping, listenerTopics, repositoryEntity, declaredRepoOp,
  SECURITY_ANNS, STEREOTYPE_TAGS, VALIDATION_ANNS, INHERITED_REPO_OPS, TEMPLATE_PUBLISH, type Ann,
} from './spring.js';

const EXTS = ['.java'];
const TYPE_DECLS = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration']);
/** Javadoc binds directly above the declaration — tree-sitter decl spans include annotations/modifiers. */
const JAVADOC_BETWEEN = /^\s*$/;

/** What pass 1 learns about one Java type; pass 2 resolves calls through it. */
interface JavaType {
  file: string;
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'record';
  /** graph node this type became (class / table / rule node id). */
  nodeId: string;
  fields: Map<string, string>; // field name -> declared type's simple name (DI resolution)
  methodIds: Map<string, string>; // method name -> function node id
  /** set when @Entity: the table node this type IS. */
  tableId?: string;
  /** set when a validation DTO: the rule node this type IS. */
  ruleId?: string;
  /** set when a Spring Data repository: simple name of the managed entity. */
  entityName?: string;
  /** repository methods declared on the interface (they carry their own reads/writes edges). */
  declaredRepoMethods?: Set<string>;
}

interface PendingCall {
  fromId: string;
  ownType: JavaType;
  /** null → same-class call / `this.x()`; otherwise the receiver identifier or a class name (static call). */
  receiver: string | null;
  method: string;
  line: number;
  code: string;
}

/** Parse a Java repo into a GraphFragment. Heuristic, syntax-level extraction. */
export async function ingestJava(repoPath: string, options: IngestOptions = {}): Promise<GraphFragment> {
  const repoRoot = resolvePath(repoPath);
  const repo = options.repoName ?? repoRoot.split('/').filter(Boolean).pop()!;
  const files = collectFiles(repoRoot, EXTS, options).sort();
  const meta = freshnessMeta(repoRoot, files);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  if (!files.length) return { repo, nodes: [], edges, meta };

  const parse = await grammarParser('java');
  let edgeSeq = 0;
  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return nodes.get(n.id)!;
  };
  const addEdge = (kind: GraphEdge['kind'], from: string, to: string, edgeMeta?: GraphEdge['meta'], resolution?: GraphEdge['resolution']) => {
    edges.push({ id: `e${edgeSeq++}`, kind, from, to, ...(edgeMeta ? { meta: edgeMeta } : {}), ...(resolution ? { resolution } : {}) });
  };
  /** A Spring annotation is the whole reason the edge exists (B5.1). */
  const byAnnotation = (note: string): GraphEdge['resolution'] =>
    ({ status: 'resolved', technique: 'annotation-scan', confidence: 'HIGH', note });
  /** A Spring Data repository method names its table through the entity it is typed on. */
  const byRepo = (note: string): GraphEdge['resolution'] =>
    ({ status: 'resolved', technique: 'db-builder', confidence: 'HIGH', note });

  const types: JavaType[] = [];
  const typesByName = new Map<string, JavaType>(); // simple name -> first declaration wins
  const pendingCalls: PendingCall[] = [];
  const pendingValidates: { targetId: string; typeName: string }[] = [];
  const pendingRepoEdges: { fnId: string; entityName: string; op: string; write: boolean; code: string; line: number }[] = [];

  // ── pass 1: per-file extraction ────────────────────────────────
  for (const abs of files) {
    const file = relative(repoRoot, abs);
    const source = readFileSync(abs, 'utf8');
    const root = parse(source);
    if (!root) continue; // unparsable file: skip, never fail the ingest

    walkTS(root, (decl) => {
      if (!TYPE_DECLS.has(decl.type)) return;
      extractType(decl, file, source);
      // keep walking inside for nested types (extractType skips method bodies itself)
    });
  }

  // ── pass 2: resolve calls / validates / repo edges across files ─
  const seenEdge = new Set<string>();
  const dedup = (key: string) => !seenEdge.has(key) && seenEdge.add(key);

  for (const call of pendingCalls) {
    const fieldType = call.receiver === null ? undefined : call.ownType.fields.get(call.receiver);
    const targetType = call.receiver === null
      ? call.ownType
      : typesByName.get(fieldType ?? call.receiver); // field type, else static class name
    if (!targetType) continue;
    // how the receiver was resolved, which is what the calls edge records (B5.1):
    // no receiver at all is this type's own method; a declared field type is the
    // bean the container injects; anything else is a bare simple name matched
    // against the types this ingest saw, with no import list consulted.
    const byReceiver: GraphEdge['resolution'] = call.receiver === null
      ? { status: 'resolved', technique: 'same-file', confidence: 'HIGH', note: `${call.method} is declared by ${call.ownType.name} itself` }
      : fieldType
        ? { status: 'heuristic', technique: 'DI-binding', confidence: 'MEDIUM', note: `the field ${call.receiver} is declared ${fieldType}` }
        : { status: 'heuristic', technique: 'name-match', confidence: 'LOW', note: `${call.receiver} matched a type of that simple name; imports are not read` };

    // repository call: declared finder → its function node; inherited CRUD → direct reads/writes on the table
    if (targetType.entityName && !targetType.declaredRepoMethods?.has(call.method)) {
      const inherited = INHERITED_REPO_OPS[call.method];
      if (!inherited) continue;
      const tableId = entityTableId(targetType.entityName);
      if (!tableId) continue;
      const kind = inherited.write ? 'writes' : 'reads';
      if (dedup(`${kind}|${call.fromId}|${tableId}|${call.method}`)) {
        addEdge(kind, call.fromId, tableId, { op: call.method, code: call.code, line: call.line },
          byRepo(`${call.method} on a Spring Data repository of ${targetType.entityName}`));
      }
      continue;
    }

    const targetId = targetType.methodIds.get(call.method);
    if (!targetId || targetId === call.fromId) continue;
    const targetKind = nodes.get(targetId)?.kind;
    // guards guard their caller — the edge points back at it (same convention as ts-js)
    if (targetKind === 'guard') {
      if (dedup(`guards|${targetId}|${call.fromId}`)) {
        addEdge('guards', targetId, call.fromId, undefined, byAnnotation(`${nodes.get(targetId)?.name ?? call.method} is a declared guard`));
      }
    } else if (dedup(`calls|${call.fromId}|${targetId}`)) {
      addEdge('calls', call.fromId, targetId, { line: call.line }, byReceiver);
    }
  }

  for (const v of pendingValidates) {
    const ruleId = typesByName.get(v.typeName)?.ruleId;
    if (ruleId && dedup(`validates|${ruleId}|${v.targetId}`)) {
      addEdge('validates', ruleId, v.targetId, undefined, byAnnotation(`@Valid ${v.typeName} on the handler's parameters`));
    }
  }

  for (const r of pendingRepoEdges) {
    const tableId = entityTableId(r.entityName);
    if (!tableId) continue;
    const kind = r.write ? 'writes' : 'reads';
    if (dedup(`${kind}|${r.fnId}|${tableId}|${r.op}`)) {
      addEdge(kind, r.fnId, tableId, { op: r.op, code: r.code, line: r.line },
        byRepo(`a repository method on ${r.entityName}`));
    }
  }

  return { repo, nodes: [...nodes.values()], edges, meta };

  // ── extraction ───────────────────────────────────────────────────

  function entityTableId(entityName: string): string | undefined {
    const entity = typesByName.get(entityName);
    if (entity?.tableId) return entity.tableId;
    // entity not parsed (other module / library): fall back to a bare table named after it
    const id = `${repo}::table::${entityName.toLowerCase()}`;
    addNode({ id, kind: 'table', name: entityName.toLowerCase(), lang: 'java', tags: autoTags('', entityName, 'table') });
    return id;
  }

  function extractType(decl: TSNode, file: string, source: string) {
    const name = decl.childForFieldName('name')?.text;
    const body = decl.childForFieldName('body');
    if (!name) return;
    const kind = decl.type.replace('_declaration', '') as JavaType['kind'];
    const anns = annotationsOf(decl);
    const doc = parseDoc(docCommentAbove(source, decl.startIndex, JAVADOC_BETWEEN));
    const loc = { repo, path: file, line: decl.startPosition.row + 1, endLine: decl.endPosition.row + 1 };
    const jt: JavaType = { file, name, kind, nodeId: `${repo}::${file}::${name}`, fields: new Map(), methodIds: new Map() };
    types.push(jt);
    if (!typesByName.has(name)) typesByName.set(name, jt);

    // fields: DI receiver resolution + entity columns. Records declare state in the header.
    const fieldDecls: { name: string; typeName: string; anns: Ann[] }[] = [];
    if (body) {
      for (const f of childrenOfType(body, 'field_declaration')) {
        const typeName = simpleTypeName(f.childForFieldName('type'));
        for (const d of childrenOfType(f, 'variable_declarator')) {
          const fieldName = d.childForFieldName('name')?.text;
          if (fieldName && typeName) fieldDecls.push({ name: fieldName, typeName, anns: annotationsOf(f) });
        }
      }
    }
    if (kind === 'record') {
      for (const p of childrenOfType(decl.childForFieldName('parameters') ?? decl, 'formal_parameter')) {
        const pName = p.childForFieldName('name')?.text;
        const typeName = simpleTypeName(p.childForFieldName('type'));
        if (pName && typeName) fieldDecls.push({ name: pName, typeName, anns: annotationsOf(p) });
      }
    }
    for (const f of fieldDecls) jt.fields.set(f.name, f.typeName);

    // ── role: JPA entity → table node ──
    if (hasAnn(anns, 'Entity')) {
      const tableName = annString(getAnn(anns, 'Table'), 'name') ?? name.toLowerCase();
      jt.tableId = `${repo}::table::${tableName}`;
      const cols = fieldDecls.map((f) => annString(getAnn(f.anns, 'Column'), 'name') ?? f.name);
      addNode({
        id: jt.tableId, kind: 'table', name: tableName, lang: 'java', loc,
        docs: doc.docs, tags: [...autoTags(file, tableName, 'table'), ...doc.tags],
        ...(cols.length ? { signature: `columns: ${cols.join(', ')}` } : {}),
        ...(doc.business ? { facets: { business: { description: doc.business } } } : {}),
      });
      jt.nodeId = jt.tableId;
      extractMethods(decl, body, jt, source, doc, anns);
      return;
    }

    // ── role: Bean Validation DTO → rule node ──
    if (fieldDecls.some((f) => f.anns.some((a) => VALIDATION_ANNS.has(a.name)))) {
      jt.ruleId = jt.nodeId;
      const constraints = fieldDecls
        .filter((f) => f.anns.some((a) => VALIDATION_ANNS.has(a.name)))
        .map((f) => `${f.name}: ${f.anns.filter((a) => VALIDATION_ANNS.has(a.name)).map(annLabel).join(', ')}`);
      addNode({
        id: jt.ruleId, kind: 'rule', name, lang: 'java', loc,
        docs: doc.docs, signature: capLabel(constraints.join('; ')).slice(0, 200),
        tags: [...autoTags(file, name, 'rule'), ...doc.tags],
        ...(doc.business ? { facets: { business: { description: doc.business } } } : {}),
      });
      return;
    }

    // ── role: Spring Data repository interface ──
    const extendsText = (findFirst(decl, 'extends_interfaces') ?? findFirst(decl, 'superclass'))?.text
      ?? childrenOfType(decl, 'super_interfaces')[0]?.text ?? '';
    const entityName = kind === 'interface' ? repositoryEntity(extendsText) : null;

    const stereotypes = anns.map((a) => STEREOTYPE_TAGS[a.name]).filter((t): t is string => !!t);
    addNode({
      id: jt.nodeId, kind: 'class', name, lang: 'java', loc,
      docs: doc.docs, group: doc.group,
      tags: [
        ...autoTags(file, name, 'class'), ...doc.tags, ...stereotypes,
        ...(kind !== 'class' ? [kind] : []),
        ...(entityName ? ['repository'] : []),
      ],
      ...(doc.business ? { facets: { business: { description: doc.business } } } : {}),
      ...docLinkFields(doc),
    });

    if (entityName) {
      jt.entityName = entityName;
      jt.declaredRepoMethods = new Set();
      extractRepositoryMethods(body, jt, source, doc);
      return;
    }

    extractMethods(decl, body, jt, source, doc, anns);
  }

  /** Declared repository finders/mutators: function nodes + reads/writes to the entity table. */
  function extractRepositoryMethods(body: TSNode | null, jt: JavaType, source: string, classDoc: ParsedDoc) {
    if (!body) return;
    for (const m of childrenOfType(body, 'method_declaration')) {
      const mName = m.childForFieldName('name')?.text;
      if (!mName) continue;
      const anns = annotationsOf(m);
      const doc = parseDoc(docCommentAbove(source, m.startIndex, JAVADOC_BETWEEN));
      const fnId = `${repo}::${jt.file}::${jt.name}.${mName}`;
      const { op, write } = declaredRepoOp(mName, anns);
      jt.declaredRepoMethods!.add(mName);
      jt.methodIds.set(mName, fnId);
      addNode({
        id: fnId, kind: 'function', name: `${jt.name}.${mName}`, lang: 'java',
        loc: { repo, path: jt.file, line: m.startPosition.row + 1, endLine: m.endPosition.row + 1 },
        docs: doc.docs, group: doc.group ?? classDoc.group ?? jt.name,
        signature: capLabel(m.text.split('{')[0]!).slice(0, 200),
        tags: [...autoTags(jt.file, `${jt.name}.${mName}`, 'function'), ...doc.tags],
        ...(doc.business ? { facets: { business: { description: doc.business } } } : {}),
      });
      // the edge carries the query: @Query JPQL when present, otherwise the derived-name signature
      const query = annString(getAnn(anns, 'Query'), 'value') ?? mName;
      pendingRepoEdges.push({ fnId, entityName: jt.entityName!, op, write, code: capLabel(query).slice(0, 200), line: m.startPosition.row + 1 });
    }
  }

  /** Methods of ordinary classes (and entities): function/route/guard nodes + body extraction. */
  function extractMethods(decl: TSNode, body: TSNode | null, jt: JavaType, source: string, classDoc: ParsedDoc, classAnns: Ann[]) {
    if (!body) return;
    const classBase = annString(getAnn(classAnns, 'RequestMapping'), 'value', 'path') ?? '';
    const classGuards = classAnns.filter((a) => SECURITY_ANNS.has(a.name));

    for (const m of childrenOfType(body, 'method_declaration')) {
      const mName = m.childForFieldName('name')?.text;
      const mBody = m.childForFieldName('body');
      if (!mName || !mBody) continue; // abstract/interface methods without bodies stay off the graph
      const anns = annotationsOf(m);
      const doc = parseDoc(docCommentAbove(source, m.startIndex, JAVADOC_BETWEEN));
      const fullName = `${jt.name}.${mName}`;
      const fnId = `${repo}::${jt.file}::${fullName}`;
      const isGuard = doc.guard !== undefined;
      const isStaticMain = mName === 'main' && childrenOfType(m, 'modifiers')[0]?.text.includes('static') === true;
      const scheduled = getAnn(anns, 'Scheduled');
      const topics = listenerTopics(anns);
      const branches = isGuard ? [] : extractJavaBranches(mBody, source);

      addNode({
        id: fnId, kind: isGuard ? 'guard' : 'function',
        name: isGuard && doc.guard ? `${fullName}: ${doc.guard}` : fullName, lang: 'java',
        loc: { repo, path: jt.file, line: m.startPosition.row + 1, endLine: m.endPosition.row + 1 },
        docs: doc.docs, snippet: snippetRange(source, m.startIndex, m.endIndex),
        ...(branches.length ? { branches } : {}),
        group: doc.group ?? classDoc.group ?? jt.name,
        tags: [
          ...autoTags(jt.file, fullName, isGuard ? 'guard' : 'function'), ...doc.tags,
          ...(isGuard && !doc.tags.includes('auth') ? ['auth'] : []),
          ...(doc.entrypoint ? ['entrypoint', ...doc.entrypoint] : []),
          ...(scheduled && !doc.entrypoint ? ['entrypoint', 'cron'] : []),
          ...(topics.length ? ['entrypoint', 'consumer'] : []),
          ...(isStaticMain ? ['entrypoint'] : []),
        ],
        ...(doc.business ? { facets: { business: { description: doc.business } } } : {}),
        ...docLinkFields(doc),
      });
      jt.methodIds.set(mName, fnId);

      // route: mapping annotation + class-level base path
      const mapping = routeMapping(anns);
      let routeId: string | undefined;
      if (mapping) {
        const path = normalizePath(joinPaths(classBase, mapping.path));
        routeId = `${repo}::route::${mapping.method} ${path}`;
        addNode({
          id: routeId, kind: 'route', name: `${mapping.method} ${path}`, lang: 'java',
          loc: { repo, path: jt.file, line: m.startPosition.row + 1 },
          tags: autoTags(jt.file, path, 'route'),
        });
        addEdge('calls', routeId, fnId, undefined, byAnnotation(`the mapping annotation on ${mName}`));
      }

      // guards: method security (+ class-level, which covers every route in the class)
      for (const g of [...anns.filter((a) => SECURITY_ANNS.has(a.name)), ...classGuards]) {
        const label = g.strings[0] ?? g.pairs.get('value') ?? '';
        const guardId = `${repo}::guard::${g.name}(${label})`;
        addNode({
          id: guardId, kind: 'guard', name: label ? `${g.name}: ${label}` : g.name, lang: 'java',
          tags: ['auth'], loc: { repo, path: jt.file, line: g.node.startPosition.row + 1 },
        });
        addEdge('guards', guardId, routeId ?? fnId, undefined, byAnnotation(`@${g.name} on ${mName}`));
      }

      // @Valid parameters validate the route/handler through their DTO's rule node
      for (const p of childrenOfType(m.childForFieldName('parameters') ?? m, 'formal_parameter')) {
        const pAnns = annotationsOf(p);
        if (!hasAnn(pAnns, 'Valid') && !hasAnn(pAnns, 'Validated')) continue;
        const typeName = simpleTypeName(p.childForFieldName('type'));
        if (typeName) pendingValidates.push({ targetId: routeId ?? fnId, typeName });
      }

      // listeners consume queues: the queue feeds the handler (journey flows queue → method)
      for (const topic of topics) {
        const qId = `${repo}::queue::${topic}`;
        addNode({ id: qId, kind: 'queue', name: topic, lang: 'java', tags: autoTags('', topic, 'queue') });
        addEdge('consumes', qId, fnId, undefined, byAnnotation(`a listener annotation naming ${topic}`));
      }

      extractBody(mBody, fnId, jt, source);
    }
  }

  /** Calls, template publishes and repository ops inside one method body. */
  function extractBody(mBody: TSNode, fnId: string, jt: JavaType, source: string) {
    walkTS(mBody, (b) => {
      if (TYPE_DECLS.has(b.type)) return false; // local/anonymous classes own their bodies
      if (b.type !== 'method_invocation') return;
      const mName = b.childForFieldName('name')?.text;
      if (!mName) return;
      const object = b.childForFieldName('object');
      const line = b.startPosition.row + 1;
      // query code for the edge: the whole enclosing statement, so builder chains show up complete
      const code = () => {
        let stmt: TSNode = b;
        for (let p = b.parent; p && p !== mBody; p = p.parent) {
          if (p.type === 'expression_statement' || p.type === 'local_variable_declaration' || p.type === 'return_statement') { stmt = p; break; }
        }
        return capLabel(stmt.text).slice(0, 200);
      };

      if (!object || object.type === 'this') {
        pendingCalls.push({ fromId: fnId, ownType: jt, receiver: null, method: mName, line, code: code() });
        return;
      }
      if (object.type !== 'identifier') return; // chained receivers: the inner invocation is visited on its own
      const receiver = object.text;

      // kafkaTemplate.send("topic", …) and friends → queue + publishes
      const receiverType = jt.fields.get(receiver);
      if (receiverType && TEMPLATE_PUBLISH[receiverType]?.has(mName)) {
        const topic = findFirst(b.childForFieldName('arguments'), 'string_literal')?.text.slice(1, -1);
        if (topic) {
          const qId = `${repo}::queue::${topic}`;
          addNode({ id: qId, kind: 'queue', name: topic, lang: 'java', tags: autoTags('', topic, 'queue') });
          addEdge('publishes', fnId, qId);
          return;
        }
      }
      pendingCalls.push({ fromId: fnId, ownType: jt, receiver, method: mName, line, code: code() });
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────

/** `KafkaTemplate<String, String>` → KafkaTemplate; `List<Invoice>` → List; `long` → long. */
function simpleTypeName(typeNode: TSNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === 'type_identifier') return typeNode.text;
  // primitives (integral_type, boolean_type…) have no type_identifier — use their text
  return findFirst(typeNode, 'type_identifier')?.text ?? (typeNode.text.length <= 20 ? typeNode.text : null);
}

/** `@Size(min = 1, max = 120)` → `Size(min = 1, max = 120)`; `@NotBlank` → `NotBlank`. */
function annLabel(a: Ann): string {
  const args = [...a.pairs.entries()].map(([k, v]) => `${k} = ${v}`).join(', ');
  return args ? `${a.name}(${args})` : a.strings.length ? `${a.name}(${a.strings.join(', ')})` : a.name;
}

function joinPaths(base: string, path: string): string {
  const joined = `${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export const javaAdapter: LanguageAdapter = {
  id: 'java',
  extensions: EXTS,
  async ingest(repoPath, options) {
    return ingestJava(repoPath, options);
  },
};
