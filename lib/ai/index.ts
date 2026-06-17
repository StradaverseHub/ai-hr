/**
 * AI gateway (ADR-0007 / ADR-0023). The single boundary between this product and any LLM provider.
 * Provider-agnostic: callers pass a already-resolved {provider, model, apiKey} and a redacted prompt;
 * this dispatches to the right adapter. Draft-only by contract — nothing here writes a review or pay.
 *
 * Two rails baked in:
 *  1. redactPII() — scrub direct identifiers from any free text before it leaves the tenant, for
 *     EVERY provider (employee PII now potentially travels to a tenant-chosen third party).
 *  2. Generic errors — adapters map provider SDK errors to AiGatewayError, so no key fragment or raw
 *     provider body ever reaches a log, a server-action return, or the browser.
 *
 * The provider client is constructed PER CALL inside each adapter from the resolved key — never cached
 * at module scope (a singleton would serve one tenant's drafts with another tenant's key).
 */
import { anthropicAdapter } from './providers/anthropic';
import { googleAdapter } from './providers/google';
import { openaiAdapter } from './providers/openai';
import { AiGatewayError, type AiAdapter, type AiProvider, type GenerateArgs, type ResolvedAiConfig } from './types';

export { AiGatewayError } from './types';
export type { AiProvider, ResolvedAiConfig, GenerateArgs, ValidateResult } from './types';
export { PROVIDERS, PROVIDER_META, isProvider, defaultModelFor, envFallbackConfig, hasEnvFallback } from './registry';
export { isSecretStorable, SecretConfigError } from './crypto';

const ADAPTERS: Record<AiProvider, AiAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter,
};

function adapterFor(provider: AiProvider): AiAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new AiGatewayError(`Unknown AI provider: ${provider}`);
  return a;
}

/** One non-streaming generation against the resolved provider/model. Generic errors only. Throws if
 *  the provider returns no text (e.g. the whole budget was spent on thinking, or a safety block) so a
 *  caller never silently receives an empty draft. */
export async function generateDraft(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
  const text = await adapterFor(cfg.provider).generate(cfg, args);
  if (!text) throw new AiGatewayError('No draft was produced — please try again.');
  return text;
}

/** Cheapest credential+model probe. Returns ok/false + a generic reason; never throws. */
export function validateConfig(cfg: ResolvedAiConfig) {
  return adapterFor(cfg.provider).validate(cfg);
}

/**
 * Scrub direct identifiers before any free text leaves the tenant for a model. Conservative — only
 * high-precision patterns (emails, Malaysian IC numbers, long phone-like runs), so ordinary prose is
 * untouched. Names are handled at the prompt level (the employee is referred to generically; peer
 * feedback is anonymous).
 */
export function redactPII(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{6}-\d{2}-\d{4}\b/g, '[id]') // MY IC, dashed
    .replace(/\b\d{12}\b/g, '[id]') // MY IC, undashed
    .replace(/\b(?:\+?6?0)\d[\d\s-]{6,}\d\b/g, '[phone]') // MY phone-like runs
    .trim();
}
