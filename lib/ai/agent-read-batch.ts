import { AiGatewayError, type AiToolCall } from './types';

/** Transport-independent execution bounds, shared by Assistant and future module readers.
 * A model batch is a proposal, not an authority/capability. Dispatch must STILL resolve only from
 * the server-offered read registry and use current canonical authorization for every lookup.
 * Never use this batch runner for effects or human confirmation commands.
 */
export const AGENT_READ_BATCH_LIMITS = Object.freeze({ calls: 16, inputBytes: 32_768, resultBytes: 65_536, depth: 16, nodes: 8_192 });
const invalid = (): never => { throw new AiGatewayError('The proposed lookup batch could not be read.'); };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Capture ALL inputs before dispatching ANY read. No getters, functions, non-JSON numbers,
 * opaque objects or caller-owned mutable references cross this boundary. Undefined arguments
 * retain the provider contract: dispatch returns its ordinary unparseable-input result.
 * A malformed batch is terminal, with no partial dispatch or guessed/repaired correlation IDs.
 */
export function captureAgentReadBatch(value: unknown): readonly AiToolCall[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > AGENT_READ_BATCH_LIMITS.calls) invalid();
  if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const batchDescriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(batchDescriptors).length !== value.length + 1) invalid();
  let nodes = 0;
  let inputBytes = 0;
  const charge = (text: string): string => {
    if (text.length > AGENT_READ_BATCH_LIMITS.inputBytes) return invalid();
    inputBytes += bytes(text);
    if (inputBytes > AGENT_READ_BATCH_LIMITS.inputBytes) return invalid();
    return text;
  };
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > AGENT_READ_BATCH_LIMITS.nodes || depth > AGENT_READ_BATCH_LIMITS.depth) return invalid();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : invalid();
    if (typeof item === 'string') return charge(item);
    if (typeof item !== 'object' || item === null) return invalid();
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item)) {
      if (proto !== Array.prototype || item.length > 1024) return invalid();
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).length !== item.length + 1) return invalid();
      const result: unknown[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor)) return invalid();
        result.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(result);
    }
    if (proto !== Object.prototype && proto !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 1024) return invalid();
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 256) return invalid();
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor)) return invalid();
      charge(key);
      result[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const ids = new Set<string>();
  const captured: AiToolCall[] = [];
  // Capture call envelopes as data too, without invoking property accessors.
  for (let index = 0; index < value.length; index++) {
    const entry = batchDescriptors[String(index)];
    if (!entry || !('value' in entry)) invalid();
    const candidate: unknown = entry.value;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid();
    if (![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !['id', 'name', 'input'].includes(key))) invalid();
    for (const key of ['id', 'name', 'input']) if (!descriptors[key]?.enumerable || !('value' in descriptors[key])) invalid();
    const id = descriptors.id.value;
    const name = descriptors.name.value;
    if (typeof id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(id) || ids.has(id)) invalid();
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) invalid();
    charge(id); charge(name);
    ids.add(id);
    const input = descriptors.input.value === undefined ? undefined : copy(descriptors.input.value, 0);
    captured.push(Object.freeze({ id, name, input }));
  }
  if (bytes(JSON.stringify(captured)) > AGENT_READ_BATCH_LIMITS.inputBytes) invalid();
  return Object.freeze(captured);
}

/** Canonical readers still own field allow-lists. Oversized output refuses instead of silently
 * truncating JSON or presenting an incomplete value as a complete business fact.
 */
export function serializeAgentReadResult(value: unknown): string {
  try {
    const content = JSON.stringify(value);
    if (typeof content !== 'string' || content.length > AGENT_READ_BATCH_LIMITS.resultBytes || bytes(content) > AGENT_READ_BATCH_LIMITS.resultBytes) invalid();
    return content;
  } catch { return invalid(); }
}
