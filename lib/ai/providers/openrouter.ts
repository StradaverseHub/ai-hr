/**
 * OpenRouter adapter (ADR-0023 / ADR-0082). OpenRouter is an AGGREGATOR: it forwards the prompt to a
 * model provider of its choosing. It speaks the Chat Completions wire format, so this adapter uses the
 * `openai` SDK against a FIXED base URL and reuses the OpenAI adapter's pure translation helpers
 * (openai-shared.ts). It is tenant-key only (no env fallback, lib/ai/registry.ts) and off per tenant until
 * a group admin allows it (`ai.openrouter_enabled`, core/ai-config.ts).
 *
 * WHAT IS DELIBERATELY DIFFERENT FROM openai.ts:
 *  - The base URL is the constant below and nothing else: no config, env or argument can move it. An
 *    explicit `baseURL` beats `OPENAI_BASE_URL` (the SDK reads the env var only as a destructuring
 *    default, node_modules/openai/client.js constructor), so a stray env var cannot redirect a tenant key.
 *  - `organization`, `project` and `adminAPIKey` are passed as `null`. The SDK defaults them from
 *    OPENAI_ORG_ID / OPENAI_PROJECT_ID / OPENAI_ADMIN_KEY only when they are `undefined`; an explicit null
 *    survives, and `buildHeaders` drops a null header, so no OpenAI account identifier is sent to OpenRouter.
 *  - No HTTP-Referer / X-Title attribution headers: they would tell OpenRouter which product and tenant
 *    are calling, which it does not need.
 *  - `maxRetries: 0` ALWAYS. A retry is a second billable call outside the governance reservation.
 *  - Role `system` (not `developer`) and `max_tokens` (not `max_completion_tokens`), the forms every
 *    routed upstream accepts. No `prompt_cache_key` (an OpenAI routing hint) and no `parallel_tool_calls`.
 *  - Every request carries the routing policy below: no provider that may train on or retain prompts, and
 *    no provider that would silently ignore a parameter we sent.
 *  - NO readImage. Performance image evidence is not sent through an aggregator; it stays for manual
 *    reading. `supportsImageReading('openrouter')` is therefore false and the gateway refuses before any
 *    transport (lib/ai/index.ts).
 *
 * Errors: OpenRouter documents its statuses at https://openrouter.ai/docs/api/reference/errors-and-debugging
 * (fetched 2026-10-19; the /errors URL now 404s). Verified there: 400 bad request, 401 invalid/disabled
 * key, 402 insufficient credits, 403 forbidden (permission, guardrail, moderation, key/workspace budget,
 * provider refusal), 404 not found (also a provider allow-list nobody satisfies, per the
 * provider-selection guide), 408 timeout, 429 rate limited, 502 model down/invalid upstream response,
 * 503 no available provider meeting the routing requirements (or provider overloaded). Also verified: a
 * NON-streaming 200 can carry an `error` object (top level with no `choices`, or on the choice with
 * `finish_reason: "error"` beside partial content), so a 200 is checked for it before its text is used.
 * Every mapping below is generic text: never the provider body, never the key.
 */
import OpenAI from 'openai';
import { hasTokenCounts } from '../usage';
import {
  AiGatewayError,
  type AiAdapter,
  type ConverseArgs,
  type ConverseResult,
  type GenerateArgs,
  type ResolvedAiConfig,
  type ValidateResult,
} from '../types';
import { readCompletion, requestMessages, requestTools, usageFor } from './openai-shared';

/** The ONLY host this adapter talks to. Not configurable, by design. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const GENERATE_TIMEOUT_MS = 60_000;
const CONVERSE_TIMEOUT_MS = 120_000;
const VALIDATE_TIMEOUT_MS = 10_000;

/**
 * Sent on every completion request. Field names and values verified in
 * https://openrouter.ai/docs/guides/routing/provider-selection (2026-10-19):
 *  - `data_collection: 'deny'` — exclude providers that may store or train on the data;
 *  - `zdr: true` — route only to Zero Data Retention endpoints (it can only tighten account settings);
 *  - `require_parameters: true` — never route to a provider that would ignore a parameter we sent
 *    (e.g. `tools`), which would otherwise fail silently.
 * When no endpoint satisfies all three the request fails (404/503) rather than relaxing the policy.
 */
const ROUTING_POLICY = { data_collection: 'deny', zdr: true, require_parameters: true } as const;

function client(apiKey: string, timeoutMs: number): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    organization: null,
    project: null,
    adminAPIKey: null,
    maxRetries: 0,
    timeout: timeoutMs,
  });
}

/**
 * THE ONE PLACE the OpenRouter-only `provider` field is added. The openai SDK's param types do not know
 * it; the SDK posts the body object verbatim (`chat.completions.create` → `post('/chat/completions',
 * { body })`), so the extra key reaches the wire. The cast only re-asserts the caller's own param type.
 */
function withRoutingPolicy(body: OpenAI.ChatCompletionCreateParamsNonStreaming): OpenAI.ChatCompletionCreateParamsNonStreaming {
  return { ...body, provider: ROUTING_POLICY } as OpenAI.ChatCompletionCreateParamsNonStreaming;
}

/** A 200 that OpenRouter used to report a failure. Carries only the numeric code, never the message. */
class EmbeddedError extends Error {
  constructor(readonly status: number) {
    super('embedded provider error');
  }
}

function embeddedError(completion: OpenAI.ChatCompletion): EmbeddedError | null {
  const c = completion as unknown as {
    error?: { code?: unknown };
    choices?: Array<{ finish_reason?: unknown; error?: { code?: unknown } }>;
  };
  const code = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : 0);
  if (c.error) return new EmbeddedError(code(c.error.code));
  const choice = Array.isArray(c.choices) ? c.choices[0] : undefined;
  if (choice && (choice.finish_reason === 'error' || choice.error)) return new EmbeddedError(code(choice.error?.code));
  return null;
}

/**
 * Usage — same mapping as OpenAI (openai-shared.ts usageFor): inputTokens = prompt_tokens − cached,
 * cachedInputTokens = prompt_tokens_details.cached_tokens, outputTokens = completion_tokens.
 * ASSUMPTION (not stated in OpenRouter's schema, which says only "Number of tokens in the prompt" and
 * "Cached prompt tokens"): prompt_tokens INCLUDES cached tokens, as on OpenAI. The settled total is
 * identical either way — governance settles the SUM, and (prompt − cached) + cached + completion is
 * prompt + completion whatever the split. Only the input/cached split would be wrong if the assumption is,
 * and in that case the true total would exceed prompt + completion by the cached count.
 * Reported ONLY when both counters are present and well-formed; otherwise no onUsage call, so
 * app.ai_settle keeps the reservation held (core/ai-governance.ts) rather than settling a fake zero.
 */
function reportUsage(completion: OpenAI.ChatCompletion, onUsage: GenerateArgs['onUsage']) {
  if (hasTokenCounts(completion.usage, ['prompt_tokens', 'completion_tokens'])) onUsage?.(usageFor(completion.usage));
}

export const openrouterAdapter: AiAdapter = {
  provider: 'openrouter',

  async generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
    try {
      const completion = await client(cfg.apiKey, args.timeoutMs ?? GENERATE_TIMEOUT_MS).chat.completions.create(
        withRoutingPolicy({
          model: cfg.model,
          max_tokens: args.maxTokens ?? 2048,
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.prompt },
          ],
        }),
        args.signal ? { signal: args.signal } : undefined,
      );
      // Usage first: tokens spent on a failed generation are still spent.
      reportUsage(completion, args.onUsage);
      const failed = embeddedError(completion);
      if (failed) throw failed;
      const choice = completion.choices?.[0];
      if (args.signal && (choice?.finish_reason === 'length' || choice?.message?.refusal)) {
        throw new AiGatewayError('No complete assessment was produced.');
      }
      return (choice?.message?.content ?? '').trim();
    } catch (e) {
      throw mapError(e);
    }
  },

  /**
   * Two metadata probes, no generation cost, fixed URLs only, ~10 s budget for both. Never throws.
   *  (a) GET /key — authenticates the key (401/403 → invalid);
   *  (b) GET /models — the model id must be an `id` in `data[]`.
   * A passing probe does NOT prove a ZDR, no-training endpoint exists for the model; the first real call
   * reports that (404/503) with a generic reason.
   */
  async validate(cfg: ResolvedAiConfig): Promise<ValidateResult> {
    const signal = AbortSignal.timeout(VALIDATE_TIMEOUT_MS);
    const c = client(cfg.apiKey, VALIDATE_TIMEOUT_MS);
    try {
      await c.get<unknown>('/key', { signal });
    } catch (e) {
      const s = status(e);
      if (s === 401 || s === 403) return { ok: false, error: 'Invalid API key' };
      if (s === 429) return { ok: false, error: 'Rate limited — try again shortly' };
      return { ok: false, error: 'Could not reach OpenRouter' };
    }
    try {
      const listing = await c.get<unknown>('/models', { signal });
      const data = listing && typeof listing === 'object' ? (listing as { data?: unknown }).data : undefined;
      const listed =
        Array.isArray(data) && data.some((m) => Boolean(m) && typeof m === 'object' && (m as { id?: unknown }).id === cfg.model);
      return listed ? { ok: true } : { ok: false, error: 'Model not available on OpenRouter' };
    } catch (e) {
      return { ok: false, error: reason(e) };
    }
  },

  /**
   * Multi-turn, tool-aware, non-streaming (ADR-0082). Same translation as openai.ts (tool fan-out,
   * parseArguments, stopFor, refusal precedence via readCompletion/normaliseStop). `args.cacheKey` is
   * deliberately NOT sent: `prompt_cache_key` is an OpenAI routing hint and is no business of an
   * aggregator. No providerState is produced (chat.completions carries none), so nothing needs tagging.
   */
  async converse(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult> {
    try {
      const tools = requestTools(args.tools);
      const completion = await client(cfg.apiKey, args.timeoutMs ?? CONVERSE_TIMEOUT_MS).chat.completions.create(
        withRoutingPolicy({
          model: cfg.model,
          max_tokens: args.maxTokens ?? 2048,
          messages: [{ role: 'system', content: args.system.join('\n\n') }, ...requestMessages(args.turns)],
          ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
        }),
      );
      // An embedded failure throws, so its usage (if any) is not recorded and the reservation stays held
      // — the conservative direction.
      const failed = embeddedError(completion);
      if (failed) throw failed;
      // readCompletion sets usageReported from hasTokenCounts(prompt_tokens, completion_tokens), and the
      // gateway records usage only when usageReported is true.
      return readCompletion(completion);
    } catch (e) {
      throw mapError(e);
    }
  },
};

function status(e: unknown): number | undefined {
  if (e instanceof EmbeddedError) return e.status;
  return e instanceof OpenAI.APIError ? e.status ?? undefined : undefined;
}

function reason(e: unknown): string {
  const s = status(e);
  if (s === 401) return 'Invalid API key';
  // 403 is NOT only a bad key on OpenRouter: a spent key/workspace budget, a guardrail, a moderation flag
  // and a provider refusal all answer 403. "Invalid API key" would send an admin to rotate a working key.
  if (s === 403) return 'OpenRouter declined this request (a key spending limit, guardrail or content policy)';
  if (s === 402) return 'OpenRouter credits are exhausted';
  if (s === 404) return 'Model not available, or no OpenRouter provider meets the no-training, no-retention policy';
  if (s === 429) return 'Rate limited — try again shortly';
  // 503 is documented as "no available model provider that meets your routing requirements" — with our
  // fixed policy that is the likely meaning, so the reason names the policy rather than implying a blip.
  if (s === 503) return 'No OpenRouter provider that meets the no-training, no-retention policy is available right now';
  if (s === 408 || s === 502) return 'No OpenRouter provider is available right now';
  return 'Could not reach OpenRouter';
}

/** Already-generic gateway errors pass through; everything else becomes a fresh generic error with no
 *  cause, so no SDK message, provider body or key fragment can travel with it. */
function mapError(e: unknown): AiGatewayError {
  if (e instanceof AiGatewayError) return e;
  return new AiGatewayError(reason(e));
}
