/** Unreleased non-streaming response boundary. Never executes tools or proves caller access.
 * Raw provider errors/debug bodies are deliberately discarded, including errors inside HTTP 200. */
import { z } from 'zod';
import { AiGatewayError, normaliseStop, type AiStop, type ConverseResult } from '../types';
import { readOpenRouterAccounting } from './openrouter-accounting';

const Call = z.object({
  id: z.string().min(1).max(256),
  type: z.literal('function'),
  function: z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/),
    arguments: z.string().max(65_536) }),
});
const Response = z.object({
  error: z.unknown().optional(),
  choices: z.array(z.object({
    error: z.unknown().optional(),
    finish_reason: z.string().max(128).nullable(),
    message: z.object({ role: z.literal('assistant'), content: z.string().max(262_144).nullable(),
      refusal: z.string().max(262_144).nullable().optional(), tool_calls: z.array(Call).max(32).optional() }),
  })).length(1),
  usage: z.unknown().optional(),
});

/** Invalid JSON arguments remain an explicit invalid-input call for the local schema validator.
 * The dispatcher must still enforce exact tool names, current authority and canonical-engine rules. */
function argumentsFor(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function readOpenRouterCompletion(value: unknown): ConverseResult {
  const parsed = Response.safeParse(value);
  if (!parsed.success || parsed.data.error !== undefined)
    throw new AiGatewayError('No complete AI response was available.');
  const response = parsed.data, choice = response.choices[0];
  if (choice.error !== undefined || choice.finish_reason === 'error')
    throw new AiGatewayError('No complete AI response was available.');
  const calls = (choice.message.tool_calls ?? []).map(call => ({ id: call.id,
    name: call.function.name, input: argumentsFor(call.function.arguments) }));
  if (new Set(calls.map(call => call.id)).size !== calls.length)
    throw new AiGatewayError('No complete AI response was available.');
  const raw: AiStop = choice.message.refusal || choice.finish_reason === 'content_filter' ? 'refusal'
    : choice.finish_reason === 'length' ? 'max_tokens'
    : choice.finish_reason === 'tool_calls' ? 'tool_use'
    : choice.finish_reason === 'stop' ? 'end' : 'other';
  // Unlike a supported provider stop label, a new/unknown label must not turn stray calls into effects.
  const normalized = normaliseStop(raw, raw === 'other' ? [] : calls);
  const accounting = readOpenRouterAccounting(response.usage);
  return { text: raw === 'refusal' ? '' : choice.message.content ?? '',
    ...normalized, usage: accounting.usage ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    usageReported: accounting.usage !== null };
}
