// Strict, bounded JSON for imported reports. Unlike JSON.parse, a repeated member name is refused (JSON.parse keeps
// the last one silently, so two readers could disagree about one document), as are an unpaired surrogate escape,
// trailing data, nesting past the depth limit and anything past the shared budget. Objects have no prototype, so
// `__proto__` is an ordinary member. Strict UTF-8; a single leading byte-order mark is removed and recorded.
import { ImportBudget, ImportRefusal, type Json } from './types.js';

export interface ParsedJson {
  readonly value: Json;
  /** True when the bytes began with one UTF-8 byte-order mark, which was removed before parsing. */
  readonly byteOrderMark: boolean;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Scanned in bounded runs so the budget and the clock are read inside one long string.
// eslint-disable-next-line no-control-regex -- JSON string runs must stop at unescaped control characters so the parser can reject them.
const RUN = /[^"\\\u0000-\u001f]{1,65536}/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const WS = /[ \t\n\r]*/y;
const HEX4 = /^[0-9A-Fa-f]{4}$/;

/** Decodes strict UTF-8, removing one leading byte-order mark. */
export function decodeUtf8(bytes: Uint8Array, budget: ImportBudget): { text: string; byteOrderMark: boolean } {
  budget.check();
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = decoder.decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    throw new ImportRefusal('sentinel.import.invalidUtf8');
  }
  budget.work(Math.ceil(bytes.length / 64) + 1);
  budget.check();
  return { text, byteOrderMark: bom };
}

export function parseStrictJson(bytes: Uint8Array, budget: ImportBudget): ParsedJson {
  const { text, byteOrderMark } = decodeUtf8(bytes, budget);
  const p = new Parser(text, budget);
  p.ws();
  const value = p.value(0, '');
  p.ws();
  if (p.i !== text.length) p.fail('sentinel.import.jsonMalformed', '');
  budget.check();
  return { value, byteOrderMark };
}

class Parser {
  i = 0;
  constructor(
    readonly s: string,
    readonly b: ImportBudget,
  ) {}

  fail(
    code: 'sentinel.import.jsonMalformed' | 'sentinel.import.jsonDuplicateKey' | 'sentinel.import.jsonTooDeep',
    pointer: string,
  ): never {
    throw new ImportRefusal(code, pointer.slice(0, 256));
  }

  ws(): void {
    WS.lastIndex = this.i;
    WS.exec(this.s);
    this.i = WS.lastIndex;
  }

  value(depth: number, ptr: string): Json {
    if (depth > this.b.limits.jsonDepth) this.fail('sentinel.import.jsonTooDeep', ptr);
    this.b.count('jsonValues');
    const c = this.s.charCodeAt(this.i);
    if (c === 0x7b) return this.object(depth, ptr);
    if (c === 0x5b) return this.array(depth, ptr);
    if (c === 0x22) return this.string(ptr);
    if (this.s.startsWith('true', this.i)) {
      this.i += 4;
      return true;
    }
    if (this.s.startsWith('false', this.i)) {
      this.i += 5;
      return false;
    }
    if (this.s.startsWith('null', this.i)) {
      this.i += 4;
      return null;
    }
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.s);
    if (!m || m[0].length === 0 || m[0].length > 64) this.fail('sentinel.import.jsonMalformed', ptr);
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail('sentinel.import.jsonMalformed', ptr);
    this.i += m[0].length;
    return n;
  }

  object(depth: number, ptr: string): Json {
    this.i++;
    const out: Record<string, Json> = Object.create(null);
    let members = 0;
    this.ws();
    if (this.s.charCodeAt(this.i) === 0x7d) {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s.charCodeAt(this.i) !== 0x22) this.fail('sentinel.import.jsonMalformed', ptr);
      const key = this.string(ptr);
      // Diagnostic paths carry member ordinals, never the report's private member names. The actual key is still
      // used verbatim for duplicate detection and output, including __proto__ and U+FEFF string data.
      const child = `${ptr}/${members}`;
      if (Object.hasOwn(out, key)) this.fail('sentinel.import.jsonDuplicateKey', child);
      if (++members > this.b.limits.objectMembers)
        throw new ImportRefusal('sentinel.import.budgetExhausted', ptr.slice(0, 256));
      this.ws();
      if (this.s.charCodeAt(this.i) !== 0x3a) this.fail('sentinel.import.jsonMalformed', child);
      this.i++;
      this.ws();
      out[key] = this.value(depth + 1, child);
      this.ws();
      const c = this.s.charCodeAt(this.i++);
      if (c === 0x7d) return out;
      if (c !== 0x2c) this.fail('sentinel.import.jsonMalformed', child);
    }
  }

  array(depth: number, ptr: string): Json {
    this.i++;
    const out: Json[] = [];
    this.ws();
    if (this.s.charCodeAt(this.i) === 0x5d) {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth + 1, `${ptr}/${out.length}`));
      this.ws();
      const c = this.s.charCodeAt(this.i++);
      if (c === 0x5d) return out;
      if (c !== 0x2c) this.fail('sentinel.import.jsonMalformed', `${ptr}/${out.length - 1}`);
    }
  }

  string(ptr: string): string {
    this.i++;
    const parts: string[] = [];
    let length = 0;
    const add = (part: string) => {
      const bytes = Buffer.byteLength(part, 'utf8');
      length += bytes;
      if (length > this.b.limits.stringBytes)
        throw new ImportRefusal('sentinel.import.budgetExhausted', ptr.slice(0, 256));
      this.b.count('decodedStringBytes', bytes);
      parts.push(part);
    };
    for (;;) {
      RUN.lastIndex = this.i;
      if (RUN.exec(this.s)) {
        let end = RUN.lastIndex;
        // Do not charge a raw surrogate pair as two replacement characters when a bounded run divides it.
        const last = this.s.charCodeAt(end - 1),
          next = this.s.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++;
        add(this.s.slice(this.i, end));
        this.i = end;
        continue;
      }
      const c = this.s.charCodeAt(this.i);
      if (c === 0x22) {
        this.i++;
        return parts.length === 1 ? parts[0]! : parts.join('');
      }
      if (c !== 0x5c) this.fail('sentinel.import.jsonMalformed', ptr);
      const e = this.s[this.i + 1];
      this.i += 2;
      switch (e) {
        case '"':
          add('"');
          break;
        case '\\':
          add('\\');
          break;
        case '/':
          add('/');
          break;
        case 'b':
          add('\b');
          break;
        case 'f':
          add('\f');
          break;
        case 'n':
          add('\n');
          break;
        case 'r':
          add('\r');
          break;
        case 't':
          add('\t');
          break;
        case 'u': {
          const hi = this.hex(ptr);
          if (hi >= 0xdc00 && hi <= 0xdfff) this.fail('sentinel.import.jsonMalformed', ptr);
          if (hi >= 0xd800 && hi <= 0xdbff) {
            if (this.s[this.i] !== '\\' || this.s[this.i + 1] !== 'u') this.fail('sentinel.import.jsonMalformed', ptr);
            this.i += 2;
            const lo = this.hex(ptr);
            if (lo < 0xdc00 || lo > 0xdfff) this.fail('sentinel.import.jsonMalformed', ptr);
            add(String.fromCharCode(hi, lo));
          } else add(String.fromCharCode(hi));
          break;
        }
        default:
          this.fail('sentinel.import.jsonMalformed', ptr);
      }
    }
  }

  hex(ptr: string): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (!HEX4.test(h)) this.fail('sentinel.import.jsonMalformed', ptr);
    this.i += 4;
    return parseInt(h, 16);
  }
}
