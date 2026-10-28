/** Provider-neutral, immutable conversation bytes captured before asynchronous admission.
 * Opaque continuation state is copied as protocol data, never interpreted, logged or persisted.
 */
import { createHash } from 'node:crypto';
import { AiGatewayError, type ConverseArgs } from './types';
export const CONVERSATION_INPUT_LIMITS = Object.freeze({ bytes: 4_194_304, nodes: 65_536, depth: 32, entries: 4096 });
const refused = (): never => { throw new AiGatewayError('The prepared AI conversation could not be confirmed.'); };
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function capture(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const seen = new WeakSet<object>();
  const charge = (value: string) => {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > CONVERSATION_INPUT_LIMITS.bytes) refused();
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > CONVERSATION_INPUT_LIMITS.nodes || depth > CONVERSATION_INPUT_LIMITS.depth) return refused();
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : refused();
    if (typeof value === 'string') { charge(value); return value; }
    if (typeof value !== 'object') return refused();
    if (seen.has(value)) return refused();
    seen.add(value);
    try {
      const proto = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (Array.isArray(value)) {
        if (proto !== Array.prototype || value.length > CONVERSATION_INPUT_LIMITS.entries || keys.length !== value.length + 1) return refused();
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const item = descriptors[String(index)];
          if (!item || !('value' in item)) return refused();
          result.push(copy(item.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (proto !== Object.prototype && proto !== null || keys.length > CONVERSATION_INPUT_LIMITS.entries) return refused();
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        const item = descriptors[key as string];
        if (typeof key !== 'string' || !item?.enumerable || !('value' in item)) return refused();
        charge(key); result[key] = copy(item.value, depth + 1);
      }
      return Object.freeze(result);
    } finally { seen.delete(value); }
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > CONVERSATION_INPUT_LIMITS.bytes) return refused();
  return result;
}

/** No caller-owned nested object survives this function. Undefined malformed tool arguments retain
 * their protocol meaning; no coercion to an executable empty object or JSON-string repair occurs.
 */
export function captureConversationInput(args: ConverseArgs): ConverseArgs {
  try {
    const value = capture(args) as Record<string, unknown>;
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key =>
      !['system', 'turns', 'tools', 'maxTokens', 'timeoutMs', 'cacheKey'].includes(key))) return refused();
    if (!Array.isArray(value.system) || !value.system.every(block => typeof block === 'string') ||
        !Array.isArray(value.turns) || !Array.isArray(value.tools)) return refused();
    if (value.cacheKey !== undefined && typeof value.cacheKey !== 'string') return refused();
    const maxTokens = value.maxTokens === undefined ? 2048 : value.maxTokens;
    const timeoutMs = value.timeoutMs === undefined ? 120_000 : value.timeoutMs;
    if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000 ||
        typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_200_000) return refused();
    for (const turn of value.turns) {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return refused();
      const t = turn as Record<string, unknown>;
      if (t.role === 'tool') {
        if (Object.keys(t).some(key => !['role', 'results'].includes(key)) || !Array.isArray(t.results)) return refused();
        for (const result of t.results) {
          if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !['id', 'name', 'content', 'isError'].includes(key)) ||
              typeof result.id !== 'string' || typeof result.name !== 'string' || typeof result.content !== 'string' ||
              (result.isError !== undefined && typeof result.isError !== 'boolean')) return refused();
        }
      } else if (t.role === 'user' || t.role === 'assistant') {
        if (typeof t.content !== 'string' || Object.keys(t).some(key => !(t.role === 'user' ? ['role', 'content'] : ['role', 'content', 'toolCalls', 'providerState']).includes(key))) return refused();
        if (own(t, 'toolCalls') && t.toolCalls !== undefined && !Array.isArray(t.toolCalls)) return refused();
        if (Array.isArray(t.toolCalls)) for (const call of t.toolCalls) {
          if (!call || typeof call !== 'object' || Array.isArray(call) || Object.keys(call).some(key => !['id', 'name', 'input'].includes(key)) ||
              typeof call.id !== 'string' || typeof call.name !== 'string') return refused();
        }
      } else return refused();
    }
    return Object.freeze({ ...value, maxTokens, timeoutMs }) as ConverseArgs;
  } catch { return refused(); }
}

/** Ephemeral hash only: no prompt, source rows or continuation state enters admission audit storage. */
export function conversationInputDigest(args: ConverseArgs): string {
  return createHash('sha256').update(JSON.stringify(captureConversationInput(args)), 'utf8').digest('hex');
}
