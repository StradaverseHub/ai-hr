/**
 * Anthropic (Claude) adapter (ADR-0023). Client is constructed PER CALL from the resolved key — never
 * memoized at module scope (a singleton would pin one tenant's key process-wide). Provider errors are
 * mapped to the generic AiGatewayError so no key fragment or raw SDK body escapes.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AiGatewayError, type AiAdapter, type GenerateArgs, type ResolvedAiConfig, type ValidateResult } from '../types';

function client(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

export const anthropicAdapter: AiAdapter = {
  provider: 'anthropic',

  async generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
    try {
      const message = await client(cfg.apiKey).messages.create({
        model: cfg.model,
        max_tokens: args.maxTokens ?? 2048,
        thinking: { type: 'adaptive' },
        system: args.system,
        messages: [{ role: 'user', content: args.prompt }],
      });
      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
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
  return e instanceof Anthropic.APIError ? e.status : undefined;
}

function reason(e: unknown): string {
  const s = status(e);
  if (s === 401 || s === 403) return 'Invalid API key';
  if (s === 404) return 'Model not available for this key';
  if (s === 429) return 'Rate limited — try again shortly';
  return 'Could not reach Anthropic';
}

function mapError(e: unknown): AiGatewayError {
  return new AiGatewayError(reason(e));
}
