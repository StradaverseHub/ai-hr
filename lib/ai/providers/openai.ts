/**
 * OpenAI adapter (ADR-0023). Per-call client; generic error mapping. Uses chat.completions with the
 * `developer` role for the system message and `max_completion_tokens` (current models reject the
 * legacy `max_tokens`).
 */
import OpenAI from 'openai';
import {
  AiGatewayError,
  finiteOrZero,
  normaliseStop,
  type AiAdapter,
  type AiStop,
  type AiToolCall,
  type AiToolSpec,
  type AiTurn,
  type AiUsage,
  type ConverseArgs,
  type ConverseResult,
  type GenerateArgs,
  type ResolvedAiConfig,
  type ValidateResult,
} from '../types';

function client(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

/** Conversation client — separate from `client()` so the drafting path keeps the SDK defaults it has
 *  always run with. Defaults are `timeout` = 10 minutes and `maxRetries` = 2 (client.d.ts:171,174),
 *  which an 8-turn loop turns into hours. */
function converseClient(apiKey: string, timeoutMs: number | undefined): OpenAI {
  return new OpenAI({ apiKey, timeout: timeoutMs ?? 120_000, maxRetries: 1 });
}

export const openaiAdapter: AiAdapter = {
  provider: 'openai',

  async generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
    try {
      const completion = await client(cfg.apiKey).chat.completions.create({
        model: cfg.model,
        max_completion_tokens: args.maxTokens ?? 2048,
        messages: [
          { role: 'developer', content: args.system },
          { role: 'user', content: args.prompt },
        ],
      });
      return (completion.choices[0]?.message?.content ?? '').trim();
    } catch (e) {
      throw mapError(e);
    }
  },

  async validate(cfg: ResolvedAiConfig): Promise<ValidateResult> {
    try {
      // Metadata-only probe: validates the key (401) and the model id (404) with no generation cost.
      await client(cfg.apiKey).models.retrieve(cfg.model);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: reason(e) };
    }
  },

  /**
   * Multi-turn, tool-aware, non-streaming (ADR-0082).
   *
   * `.create()` deliberately — NOT `.parse()`, `.stream()` or `.runTools()`. Those helpers throw
   * `LengthFinishReasonError` / `ContentFilterFinishReasonError`, which extend `OpenAIError` and NOT
   * `APIError` (core/error.d.ts:51,54), so `e instanceof OpenAI.APIError` misses them and a length
   * truncation would be mislabelled as a network fault. `.runTools()` is additionally disqualified: it
   * hides the loop, which is exactly where the turn cap, the budget re-check and the audit live.
   *
   * chat.completions, not `responses`, for v1 — one SDK surface per adapter and an explicit
   * `finish_reason === 'tool_calls'` discriminator. THE COST IS REAL AND IS NOT HIDDEN: chat.completions
   * has no reasoning item, so on gpt-5.x models reasoning state is LOST between tool turns. The
   * `providerState` carrier exists so a later swap to `responses` is an adapter-internal change with no
   * contract edit and no caller edit.
   */
  async converse(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult> {
    try {
      const tools = requestTools(args.tools);
      const completion = await converseClient(cfg.apiKey, args.timeoutMs).chat.completions.create({
        model: cfg.model,
        max_completion_tokens: args.maxTokens ?? 2048,
        messages: [
          { role: 'developer', content: args.system.join('\n\n') },
          ...requestMessages(args.turns),
        ],
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const, parallel_tool_calls: true } : {}),
        // A cache-ROUTING hint only. Must never be a tenant id, user id or email — the gateway's caller
        // passes a non-reversible digest of (tenant, role).
        ...(args.cacheKey ? { prompt_cache_key: args.cacheKey } : {}),
      });
      return readCompletion(completion);
    } catch (e) {
      throw mapError(e);
    }
  },
};

/* ------------------------------------------------------------------------------------------------
 * Request translation. OpenAI has no cache breakpoints: caching is automatic and prefix-based, and
 * `prompt_cache_key` is the only lever. The system blocks are joined into ONE developer message, so the
 * prefix is still tools -> system -> messages and the same "nothing volatile above the question" rule
 * applies.
 * ---------------------------------------------------------------------------------------------- */

function requestTools(tools: AiToolSpec[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      // No cast needed: FunctionParameters is `{ [k: string]: unknown }` and AiJsonSchema is a type
      // alias, so it carries an implicit index signature.
      parameters: t.inputSchema,
      strict: true,
    },
  }));
}

function requestMessages(turns: AiTurn[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      out.push({ role: 'user', content: turn.content });
      continue;
    }
    if (turn.role === 'assistant') {
      const calls = turn.toolCalls ?? [];
      // An assistant message with neither content nor tool_calls is a REQUEST ERROR, not an empty turn:
      // the SDK documents content as "required unless tool_calls or function_call is specified". Such a
      // turn is reachable — readCompletion yields text '' whenever message.content is null (a refusal
      // puts its prose on `message.refusal`, which is deliberately not surfaced), and normaliseStop
      // empties toolCalls on refusal and max_tokens. It carries no information either way, so it is
      // dropped rather than sent. anthropic.ts and google.ts both guard the identical case; without
      // this, one ConverseArgs built a legal request on two providers and a 400 on the third, surfaced
      // as "Could not reach OpenAI" — a network message for a request-shape bug.
      if (!turn.content && calls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: turn.content ? turn.content : null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                // The outbound leg of the encoding disagreement: neutral `input` is a parsed value,
                // OpenAI's `arguments` is a JSON STRING.
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    // THE FAN-OUT. One neutral tool turn becomes N `role: 'tool'` messages, one per tool_call_id, in the
    // order the assistant asked for them. It lives here, in the adapter, precisely so the caller cannot
    // get the one-turn rule wrong: ChatCompletionToolMessageParam is one message per call by
    // construction (completions.d.ts:1484), while Anthropic and Google want a single turn.
    for (const r of turn.results) {
      // OpenAI has no `is_error` on a tool message, so failure is encoded in the content. NEVER drop a
      // result: a missing tool_call_id is a protocol violation, not a smaller payload.
      out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Response translation.
 * ---------------------------------------------------------------------------------------------- */

function readCompletion(completion: OpenAI.ChatCompletion): ConverseResult {
  const choice = completion.choices[0];
  const message = choice?.message;
  const text = (message?.content ?? '').trim();

  const calls: AiToolCall[] = (message?.tool_calls ?? [])
    // ChatCompletionMessageToolCall is a UNION of function and custom tool calls (completions.d.ts:1304);
    // narrowing is what stops this breaking the day a custom tool appears.
    .filter((tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
    .map((tc) => ({ id: tc.id, name: tc.function.name, input: parseArguments(tc.function.arguments) }));

  // `refusal` is ORTHOGONAL to finish_reason and can be set while finish_reason still reads 'stop', so
  // it is checked first.
  const raw: AiStop = message?.refusal ? 'refusal' : stopFor(choice?.finish_reason);
  const { stop, toolCalls } = normaliseStop(raw, calls);
  return { text, toolCalls, stop, usage: usageFor(completion.usage) };
}

/** The SDK's own comment warns the model "does not always generate valid JSON, and may hallucinate
 *  parameters not defined by your function schema". `undefined` means unparseable — the caller treats
 *  that as a validation failure and returns an isError result, never a dropped one. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stopFor(raw: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | undefined): AiStop {
  switch (raw) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

/** `prompt_tokens` INCLUDES `prompt_tokens_details.cached_tokens` as a subset, so the cached count is
 *  subtracted out to keep inputTokens and cachedInputTokens disjoint. `completion_tokens` already
 *  contains `completion_tokens_details.reasoning_tokens`; adding those would double-count. */
function usageFor(u: OpenAI.CompletionUsage | undefined): AiUsage {
  const cached = finiteOrZero(u?.prompt_tokens_details?.cached_tokens);
  return {
    inputTokens: Math.max(0, finiteOrZero(u?.prompt_tokens) - cached),
    outputTokens: finiteOrZero(u?.completion_tokens),
    cachedInputTokens: cached,
  };
}

function status(e: unknown): number | undefined {
  return e instanceof OpenAI.APIError ? e.status ?? undefined : undefined;
}

function reason(e: unknown): string {
  const s = status(e);
  if (s === 401 || s === 403) return 'Invalid API key';
  if (s === 404) return 'Model not available for this key';
  if (s === 429) return 'Rate limited — try again shortly';
  return 'Could not reach OpenAI';
}

function mapError(e: unknown): AiGatewayError {
  return new AiGatewayError(reason(e));
}
