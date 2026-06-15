/**
 * Strict JSON parse for signed payloads (ADR-0020 §2). `JSON.parse` silently keeps the last value on
 * duplicate object keys, which is a signature-strip-adjacent malleability vector (the bytes the signer hashed
 * can carry a key the verifier-then-consumer resolves differently). We scan the exact verified bytes and
 * REJECT duplicate keys before handing off to `JSON.parse`.
 */

export class DuplicateKeyError extends Error {
  constructor(public readonly key: string) {
    super(`Duplicate JSON key: ${JSON.stringify(key)}`);
    this.name = 'DuplicateKeyError';
  }
}

type Frame = { isObject: boolean; keys: Set<string> | null; expectKey: boolean };

/** Throw DuplicateKeyError if any object in `text` declares the same key twice (at its own level). */
export function assertNoDuplicateKeys(text: string): void {
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;

  const readString = (): string => {
    // text[i] === '"'
    i++;
    let s = '';
    while (i < n) {
      const c = text[i++];
      if (c === '\\') {
        const e = text[i++];
        if (e === 'u') {
          s += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else {
          s += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e] ?? e;
        }
      } else if (c === '"') {
        return s;
      } else {
        s += c;
      }
    }
    throw new SyntaxError('Unterminated string in JSON');
  };

  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const top = stack[stack.length - 1];
    if (c === '{') {
      stack.push({ isObject: true, keys: new Set(), expectKey: true });
      i++;
      continue;
    }
    if (c === '[') {
      stack.push({ isObject: false, keys: null, expectKey: false });
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      i++;
      continue;
    }
    if (c === ',') {
      if (top) top.expectKey = top.isObject;
      i++;
      continue;
    }
    if (c === ':') {
      if (top) top.expectKey = false;
      i++;
      continue;
    }
    if (c === '"') {
      if (top && top.isObject && top.expectKey) {
        const key = readString();
        if (top.keys!.has(key)) throw new DuplicateKeyError(key);
        top.keys!.add(key);
      } else {
        readString();
      }
      continue;
    }
    // number / true / false / null token — advance one char; structure chars above handle nesting.
    i++;
  }
}

/** Parse JSON, rejecting duplicate object keys first. */
export function parseStrict(text: string): unknown {
  assertNoDuplicateKeys(text);
  return JSON.parse(text);
}
