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
import {
  AiGatewayError,
  type AiAdapter,
  type AiProvider,
  type ConverseArgs,
  type ConverseResult,
  type GenerateArgs,
  type ResolvedAiConfig,
} from './types';

export { AiGatewayError, normaliseStop } from './types';
export type { AiProvider, ResolvedAiConfig, GenerateArgs, ValidateResult } from './types';
export type {
  AiJsonSchema,
  AiToolSpec,
  AiToolCall,
  AiToolResult,
  AiProviderState,
  AiTurn,
  AiStop,
  AiUsage,
  ConverseArgs,
  ConverseResult,
} from './types';
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

/** Whether this provider can run the assistant loop (ADR-0082). A cheap UI gate that mirrors
 *  isAiConfigured — "this provider cannot converse" is a state a screen can render, not a crash. */
export function supportsConverse(provider: AiProvider): boolean {
  return typeof ADAPTERS[provider]?.converse === 'function';
}

/**
 * ONE non-streaming, tool-aware exchange against the resolved provider/model (ADR-0082). Generic errors
 * only. This is the assistant's transport; it is NOT a loop — the caller owns the turn cap, the budget
 * re-check, the audit row and the whole-exchange deadline.
 *
 * Deliberately does NOT throw on empty text. With tools, `stop === 'tool_use'` with an empty `text` is
 * the normal, correct shape — unlike generateDraft above, where empty means failure. The loop decides
 * what an empty answer means.
 *
 * `generateDraft` is NOT reimplemented on top of this, and must not be. Three test files mock `lib/ai`
 * as `{ ...importActual, generateDraft: vi.fn() }`; an intra-module call from generateDraft into
 * converse would NOT be intercepted, so those suites would make real network calls with a real key.
 * The two share adapters, error mapping and the per-call client factory — and share no call path.
 *
 * redactPII is deliberately NOT applied here. The drafting callers wrap every free-text field at the
 * call site because employee PII is leaving the tenant for a model. The assistant's tool results are
 * rows the caller is already entitled to read, fetched under its own RLS-scoped session — redacting
 * them produces an assistant that answers "[email]" for an address the user can see on screen. The
 * caller applies an untrusted-content fence to tool results instead. Do not copy the drafting pattern
 * here.
 */
export async function converse(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult> {
  const adapter = adapterFor(cfg.provider);
  if (!adapter.converse) throw new AiGatewayError('This AI provider does not support the assistant.');
  // Defaults are normalised HERE, not per adapter, so a fourth adapter cannot silently send `undefined`
  // and inherit a server-side default nobody chose.
  return adapter.converse(cfg, { ...args, maxTokens: args.maxTokens ?? 2048, timeoutMs: args.timeoutMs ?? 120_000 });
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
