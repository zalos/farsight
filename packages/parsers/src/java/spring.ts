/**
 * Spring / JPA / Jakarta annotation semantics — the mapping tables and
 * annotation-reading helpers that turn Java syntax into graph meaning.
 * Framework knowledge lives here; `index.ts` owns graph assembly.
 */
import { childrenOfType, walkTS, type TSNode } from '../treesitter/harness.js';

/** A read annotation: `@Name`, `@Name("v")`, `@Name(key = v, …)`. */
export interface Ann {
  name: string; // simple name — `@jakarta.validation.Valid` reads as 'Valid'
  node: TSNode;
  /** POSITIONAL string-literal arguments, unquoted (named `key = "v"` args live in pairs). */
  strings: string[];
  /** `key = value` arguments, value as raw source text. */
  pairs: Map<string, string>;
}

/** String literals inside the given named args, e.g. `topics = {"a", "b"}` → a, b. */
export function pairStrings(a: Ann, ...keys: string[]): string[] {
  return keys.flatMap((k) => [...(a.pairs.get(k) ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]!));
}

/** First string argument, positional or under one of the given names — `@Table(name = "x")` and `@GetMapping("/x")` alike. */
export function annString(a: Ann | undefined, ...keys: string[]): string | undefined {
  if (!a) return undefined;
  return a.strings[0] ?? pairStrings(a, ...keys)[0];
}

/** Annotations attached to a declaration (they live inside its `modifiers` child). */
export function annotationsOf(decl: TSNode): Ann[] {
  const mods = childrenOfType(decl, 'modifiers')[0];
  if (!mods) return [];
  const out: Ann[] = [];
  for (const child of mods.namedChildren) {
    if (!child || (child.type !== 'annotation' && child.type !== 'marker_annotation')) continue;
    const rawName = child.childForFieldName('name')?.text ?? '';
    const name = rawName.split('.').pop()!;
    const args = child.childForFieldName('arguments');
    const strings: string[] = [];
    const pairs = new Map<string, string>();
    if (args) {
      for (const pair of childrenOfType(args, 'element_value_pair')) {
        const key = pair.childForFieldName('key')?.text;
        const value = pair.childForFieldName('value')?.text;
        if (key && value) pairs.set(key, value);
      }
      walkTS(args, (n) => {
        if (n.type === 'element_value_pair') return false; // named args are pairs, not positional strings
        if (n.type === 'string_literal') { strings.push(n.text.slice(1, -1)); return false; }
      });
    }
    out.push({ name, node: child, strings, pairs });
  }
  return out;
}

export const hasAnn = (anns: Ann[], name: string) => anns.some((a) => a.name === name);
export const getAnn = (anns: Ann[], name: string) => anns.find((a) => a.name === name);

/** `@GetMapping` etc. → HTTP method. `@RequestMapping` resolves via its `method =` pair. */
export const MAPPING_ANNS: Record<string, string> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

/** Route mapping carried by a method's annotations, or null. Path excludes the class-level base. */
export function routeMapping(anns: Ann[]): { method: string; path: string } | null {
  for (const a of anns) {
    const verb = MAPPING_ANNS[a.name];
    if (verb) return { method: verb, path: annString(a, 'value', 'path') ?? '' };
    if (a.name === 'RequestMapping') {
      const m = a.pairs.get('method')?.match(/RequestMethod\.(\w+)/)?.[1] ?? 'GET';
      return { method: m, path: annString(a, 'value', 'path') ?? '' };
    }
  }
  return null;
}

/** Method-security annotations → guard nodes. */
export const SECURITY_ANNS = new Set(['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed']);

/** Class stereotype annotation → tag. */
export const STEREOTYPE_TAGS: Record<string, string> = {
  RestController: 'controller', Controller: 'controller', Service: 'service',
  Component: 'component', Repository: 'repository', Configuration: 'configuration',
};

/** Jakarta Bean Validation constraint annotations — fields carrying these make a DTO a rule node. */
export const VALIDATION_ANNS = new Set([
  'NotNull', 'NotBlank', 'NotEmpty', 'Size', 'Min', 'Max', 'Positive', 'PositiveOrZero',
  'Negative', 'NegativeOrZero', 'Email', 'Pattern', 'Digits', 'DecimalMin', 'DecimalMax',
  'Future', 'FutureOrPresent', 'Past', 'PastOrPresent', 'AssertTrue', 'AssertFalse',
]);

/** Spring Data repository: `interface X extends JpaRepository<Entity, ID>` → entity simple name. */
export function repositoryEntity(extendsText: string): string | null {
  return extendsText.match(/\w*(?:Jpa|Crud|PagingAndSorting|ListCrud|ListPagingAndSorting|Mongo|Reactive\w*)Repository\s*<\s*(\w+)/)?.[1] ?? null;
}

/** Classify a repository method declared on the interface: does it read or write the entity table? */
export function declaredRepoOp(name: string, anns: Ann[]): { op: string; write: boolean } {
  if (hasAnn(anns, 'Modifying')) return { op: name, write: true };
  if (/^(save|delete|remove|update|mark|insert|upsert|set|increment|decrement)/.test(name)) return { op: name, write: true };
  return { op: name, write: false };
}

/** CRUD methods inherited from JpaRepository — call sites resolve straight to reads/writes edges. */
export const INHERITED_REPO_OPS: Record<string, { write: boolean }> = {
  save: { write: true }, saveAll: { write: true }, saveAndFlush: { write: true },
  delete: { write: true }, deleteById: { write: true }, deleteAll: { write: true }, deleteAllById: { write: true },
  findById: { write: false }, findAll: { write: false }, findAllById: { write: false },
  count: { write: false }, existsById: { write: false }, getReferenceById: { write: false },
};

/** Messaging template field types whose `send`-style calls publish to a queue/topic. */
export const TEMPLATE_PUBLISH: Record<string, Set<string>> = {
  KafkaTemplate: new Set(['send', 'sendDefault']),
  RabbitTemplate: new Set(['convertAndSend', 'send']),
  JmsTemplate: new Set(['convertAndSend', 'send']),
};

/** Listener annotations → the topics/queues a method consumes (positional or `topics = …`/`queues = …`). */
export function listenerTopics(anns: Ann[]): string[] {
  const listener = anns.find((a) => a.name === 'KafkaListener' || a.name === 'RabbitListener' || a.name === 'JmsListener');
  if (!listener) return [];
  return [...listener.strings, ...pairStrings(listener, 'topics', 'queues', 'destination')];
}
