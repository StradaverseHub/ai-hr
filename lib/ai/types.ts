/**
 * Provider abstraction for the AI gateway (ADR-0023). One narrow interface every provider adapter
 * implements, so the rest of the app is provider-agnostic. Draft-only: adapters generate text and
 * validate credentials; they never persist anything.
 */
export type AiProvider = 'anthropic' | 'openai' | 'google';

/** Resolved, ready-to-use config for one generation — the decrypted key lives only in request memory. */
export type ResolvedAiConfig = {
  provider: AiProvider;
  model: string;
  apiKey: string;
};

export type GenerateArgs = {
  system: string;
  prompt: string;
  maxTokens?: number;
};

/** Result of a credential/model probe. `error` is a GENERIC reason — never raw SDK/provider text. */
export type ValidateResult = { ok: boolean; error?: string };

export interface AiAdapter {
  readonly provider: AiProvider;
  /** Single non-streaming generation. Throws `AiGatewayError` (generic) on any provider failure. */
  generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string>;
  /** Cheapest check that the key+model are usable. Returns ok/false + a generic reason; never throws. */
  validate(cfg: ResolvedAiConfig): Promise<ValidateResult>;
  /**
   * Multi-turn, tool-aware, non-streaming exchange (ADR-0082). OPTIONAL on purpose: a REQUIRED method
   * would break all three adapters at tsc simultaneously, and "this provider cannot run the assistant"
   * is a first-class, user-visible state (a generic AiGatewayError from the gateway's capability gate)
   * rather than a TypeError inside a server action. Callers check `supportsConverse(provider)`.
   */
  converse?(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult>;
}

/** Generic, client-safe gateway error — provider SDK errors are mapped to this so no key fragment or
 *  raw provider body ever reaches a log, a server-action return, or the browser. */
export class AiGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

/* ------------------------------------------------------------------------------------------------
 * ADR-0082 slice 1 — the provider-neutral CONVERSATION contract.
 *
 * Everything above this line is the draft-only contract (ADR-0023) and is unchanged. Everything below
 * is additive: a multi-turn, tool-aware, NON-STREAMING exchange that three very different SDKs can all
 * express. Where they disagree, the neutral shape wins and the adapter pays the cost — the disagreements
 * are recorded at each type, because every one of them fails SILENTLY when it is got wrong.
 * ---------------------------------------------------------------------------------------------- */

/**
 * JSON Schema for one tool's input. Deliberately a `type`, NOT an `interface`: OpenAI's
 * `Shared.FunctionDefinition.parameters` is `FunctionParameters = { [k: string]: unknown }`
 * (node_modules/openai/resources/shared.d.ts:123) and TypeScript gives implicit index signatures to
 * type aliases but not to interfaces — the interface form does not compile without a cast.
 *
 * `required` and `additionalProperties` are REQUIRED PROPERTIES, not optional, so ADR-0082 §2.2
 * mechanic 4 ("strict schemas") is enforced by tsc rather than by reviewer discipline: a tool whose
 * input is unconstrained cannot be expressed in this type at all.
 */
export type AiJsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

export type AiToolSpec = {
  name: string;
  description: string;
  inputSchema: AiJsonSchema;
};

/** One tool invocation asked for by the model. `input` is ALREADY PARSED — never a JSON string.
 *  `input === undefined` means the provider produced arguments we could not parse; the caller MUST
 *  treat that as a validation failure and return an `isError` result, never a dropped result. */
export type AiToolCall = {
  id: string;
  name: string;
  input: unknown;
};

/**
 * One tool outcome going back to the model. `name` is required, not decorative: Google's
 * `FunctionResponse.name` is the correlation key (documented Required) and its `id` is Optional, while
 * `FunctionCall.id` is likewise optional and commonly absent on the Gemini Developer API
 * (@google/genai genai.d.ts:4368). Without `name` the Google adapter cannot build a legal
 * `functionResponse` part — and the request still sends, so the failure is silent.
 *
 * A failed tool returns `isError: true`. NEVER omit a result (ADR-0082 §2.2 mechanic 2).
 */
export type AiToolResult = {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
};

/**
 * Opaque, adapter-owned continuation state (reasoning/thinking blocks and their signatures). The loop
 * MUST carry it back verbatim on the next call and MUST NOT inspect, log, persist or serialise it to
 * the browser. It is tagged with the provider that minted it so a mid-conversation provider switch
 * DISCARDS it instead of feeding Anthropic thinking blocks to Google.
 */
export type AiProviderState = {
  provider: AiProvider;
  blocks: unknown;
};

export type AiTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[]; providerState?: AiProviderState }
  | { role: 'tool'; results: AiToolResult[] };

/**
 * Five members, not four. `'other'` is the home for Anthropic's `pause_turn`, Google's
 * RECITATION/LANGUAGE/OTHER/BLOCKLIST/MALFORMED_FUNCTION_CALL/UNEXPECTED_TOOL_CALL, and the
 * "provider claimed tool_use but zero calls parsed" case. Forcing any of those into `'end'` is exactly
 * the ADR §2.5 failure — an assistant that quietly stops looking is indistinguishable from one that
 * finished. `'other'` and `'max_tokens'` are terminal AND visible.
 */
export type AiStop = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

/**
 * `inputTokens` and `cachedInputTokens` are DISJOINT on every provider: uncached billable input, and
 * input served from cache. inputTokens + cachedInputTokens === total input, always. The three SDKs
 * disagree about this (Anthropic EXCLUDES cache reads from input_tokens; OpenAI and Google INCLUDE
 * them), so the naive three-field copy under-counts Anthropic and double-counts the other two.
 * `outputTokens` always means total billable output INCLUDING reasoning.
 */
export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

export type ConverseArgs = {
  /**
   * Ordered system blocks. An ARRAY, not a string, because Anthropic can only carry a prompt-cache
   * breakpoint on a block (`system?: string | Array<TextBlockParam>`). Every element must be STABLE per
   * (tenant, role): nothing volatile — no clock value, no request/session/user id, no locale string, no
   * tenant data — may ever be interpolated here, because the cacheable prefix is `tools` + `system` and
   * one changed byte invalidates everything after it.
   */
  system: string[];
  turns: AiTurn[];
  tools: AiToolSpec[];
  maxTokens?: number;
  /** Wall-clock ceiling for ONE provider round-trip. Defaulted at the gateway; a per-call timeout does
   *  NOT bound a loop, so the caller must additionally enforce a whole-exchange deadline. */
  timeoutMs?: number;
  /** Opaque, non-reversible cache-routing hint (OpenAI `prompt_cache_key`). Must be stable per
   *  (tenant, role) and must NEVER be a tenant id, user id, email or any other identifier. */
  cacheKey?: string;
};

export type ConverseResult = {
  text: string;
  toolCalls: AiToolCall[];
  stop: AiStop;
  usage: AiUsage;
  providerState?: AiProviderState;
};

/**
 * Stop-reason precedence, applied identically by all three adapters so no adapter can get it wrong on
 * its own. Order is load-bearing:
 *   1. refusal beats everything — a refusal with a stray tool call must never execute the call;
 *   2. max_tokens beats tool_use — a response truncated mid-tool_use has PARTIAL input; executing a
 *      half-parsed query against an RLS-bound table is the one outcome worth refusing outright;
 *   3. the EVIDENCE (a parsed call) beats the provider's own LABEL — Google has no tool-use stop
 *      reason at all and returns STOP when it wants a tool;
 *   4. a claimed tool_use that produced no parsed call is `'other'`, never `'end'`.
 */
export function normaliseStop(raw: AiStop, calls: AiToolCall[]): { stop: AiStop; toolCalls: AiToolCall[] } {
  if (raw === 'refusal') return { stop: 'refusal', toolCalls: [] };
  if (raw === 'max_tokens') return { stop: 'max_tokens', toolCalls: [] };
  if (calls.length > 0) return { stop: 'tool_use', toolCalls: calls };
  if (raw === 'tool_use') return { stop: 'other', toolCalls: [] };
  return { stop: raw, toolCalls: [] };
}

/** Usage fields are optional and nullable across the three SDKs. Missing usage normalises to ZERO —
 *  and zero must never be read as "free": the caller's budget also counts exchanges, which advance
 *  independently of tokens. */
export function finiteOrZero(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}
