/**
 * Google (Gemini) adapter (ADR-0023). Uses the current unified SDK `@google/genai` (Gemini Developer
 * API, not Vertex). Per-call client; generic error mapping. The system prompt goes in
 * `config.systemInstruction`; `response.text` is a getter that may be undefined.
 */
import { ApiError, GoogleGenAI } from '@google/genai';
import { AiGatewayError, type AiAdapter, type GenerateArgs, type ResolvedAiConfig, type ValidateResult } from '../types';

function client(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

export const googleAdapter: AiAdapter = {
  provider: 'google',

  async generate(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
    try {
      const response = await client(cfg.apiKey).models.generateContent({
        model: cfg.model,
        contents: args.prompt,
        config: { systemInstruction: args.system, maxOutputTokens: args.maxTokens ?? 2048 },
      });
      return (response.text ?? '').trim();
    } catch (e) {
      throw mapError(e);
    }
  },

  async validate(cfg: ResolvedAiConfig): Promise<ValidateResult> {
    try {
      // Cheapest probe that validates BOTH the key and the model id: a 1-token generation.
      await client(cfg.apiKey).models.generateContent({
        model: cfg.model,
        contents: 'hi',
        config: { maxOutputTokens: 1 },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: reason(e) };
    }
  },
};

function reason(e: unknown): string {
  const s = e instanceof ApiError ? e.status : undefined;
  if (s === 400 || s === 401 || s === 403) return 'Invalid API key';
  if (s === 404) return 'Model not available for this key';
  if (s === 429) return 'Rate limited — try again shortly';
  return 'Could not reach Google';
}

function mapError(e: unknown): AiGatewayError {
  return new AiGatewayError(reason(e));
}
