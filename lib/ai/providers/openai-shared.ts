/**
 * Chat Completions request/response translation shared by the OpenAI adapter (openai.ts) and the
 * OpenRouter adapter (openrouter.ts), which speaks the same wire format through the same SDK.
 *
 * PURE: no client, no transport, no retry or timeout policy, no provider-specific error text and no
 * system-message role — those stay in each adapter, because that is exactly where the two providers
 * differ (OpenAI: `developer` role, `max_completion_tokens`, `prompt_cache_key`; OpenRouter: `system`,
 * `max_tokens`, routing policy). Moved here verbatim from openai.ts; behaviour is unchanged.
 */
import OpenAI from 'openai';
import { hasTokenCounts } from '../usage';
import {
  finiteOrZero,
  normaliseStop,
  type AiStop,
  type AiToolCall,
  type AiToolSpec,
  type AiTurn,
  type AiUsage,
  type ConverseResult,
} from '../types';

/* ------------------------------------------------------------------------------------------------
 * Request translation. OpenAI has no cache breakpoints: caching is automatic and prefix-based, and
 * `prompt_cache_key` is the only lever. The system blocks are joined into ONE developer message, so the
 * prefix is still tools -> system -> messages and the same "nothing volatile above the question" rule
 * applies.
 * ---------------------------------------------------------------------------------------------- */

export function requestTools(tools: AiToolSpec[]): OpenAI.ChatCompletionTool[] {
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

export function requestMessages(turns: AiTurn[]): OpenAI.ChatCompletionMessageParam[] {
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

export function readCompletion(completion: OpenAI.ChatCompletion): ConverseResult {
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
  return { text, toolCalls, stop, usage: usageFor(completion.usage), usageReported: hasTokenCounts(completion.usage,['prompt_tokens','completion_tokens']) };
}

/** The SDK's own comment warns the model "does not always generate valid JSON, and may hallucinate
 *  parameters not defined by your function schema". `undefined` means unparseable — the caller treats
 *  that as a validation failure and returns an isError result, never a dropped one. */
export function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function stopFor(raw: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | undefined): AiStop {
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
export function usageFor(u: OpenAI.CompletionUsage | undefined): AiUsage {
  const cached = finiteOrZero(u?.prompt_tokens_details?.cached_tokens);
  return {
    inputTokens: Math.max(0, finiteOrZero(u?.prompt_tokens) - cached),
    outputTokens: finiteOrZero(u?.completion_tokens),
    cachedInputTokens: cached,
  };
}

