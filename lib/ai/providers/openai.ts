/**
 * OpenAI adapter (ADR-0023). Per-call client; generic error mapping. Uses chat.completions with the
 * `developer` role for the system message and `max_completion_tokens` (current models reject the
 * legacy `max_tokens`).
 */
import OpenAI from 'openai';
import { AiGatewayError, type AiAdapter, type GenerateArgs, type ResolvedAiConfig, type ValidateResult } from '../types';

function client(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
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
};

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
