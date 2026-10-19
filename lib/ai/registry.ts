/**
 * Provider/model registry (ADR-0023). The dropdown options + display labels + the env-var fallback.
 * Model lists are SUGGESTIONS for the picker, not an allowlist — provider model ids drift, so any
 * non-empty model string is accepted and the provider rejects unknown ids at call time.
 *
 * PROVENANCE OF THE SUGGESTED IDS (verified 2026-10-19; NOT exercised against a live key):
 *   - Anthropic:  the claude-api reference (model ids and the current lineup).
 *   - OpenAI:     developers.openai.com/api/docs/models.
 *   - Google:     ai.google.dev/gemini-api/docs/models and its pricing page. gemini-2.0-flash and
 *                 gemini-2.0-flash-lite are shut down and were removed; the 2.5 family is legacy with
 *                 access limited to previous users, which is why the Google default moved to 3.8 Flash.
 *   - OpenRouter: the live `GET https://openrouter.ai/api/v1/models` listing (every slug below was an
 *                 `id` in its `data[]` on that date).
 * Lists are newest first. A suggestion that later disappears upstream fails at call time with a generic
 * "model not available" reason; it never needs a migration.
 *
 * DEFAULT MODELS ARE DELIBERATELY STICKY. `defaultModel` is also the env-fallback model
 * (`envFallbackConfig` below), so changing Anthropic's or OpenAI's default would silently change the
 * model production's platform key runs on. Anthropic stays claude-opus-4-8 and OpenAI stays gpt-5.5 for
 * that reason. Google's default moves because its previous default is in limited legacy access.
 */
import type { AiProvider, ResolvedAiConfig } from './types';

/** Order is the env-fallback PRECEDENCE. OpenRouter is last and has no env keys, so it never competes. */
export const PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'google', 'openrouter'];

export const PROVIDER_META: Record<
  AiProvider,
  {
    label: string;
    models: string[];
    defaultModel: string;
    envKeyVars: string[];
    envModelVar?: string;
    /**
     * True when a tenant must explicitly allow the provider (the `ai.openrouter_enabled` tenant setting)
     * before a key can be saved, activated or used. The service enforces it (core/ai-config.ts); the UI
     * reads it to explain the extra step.
     */
    optIn: boolean;
  }
> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-1',
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
    defaultModel: 'claude-opus-4-8',
    envKeyVars: ['ANTHROPIC_API_KEY'],
    envModelVar: 'AI_DRAFT_MODEL',
    optIn: false,
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-5.5',
    envKeyVars: ['OPENAI_API_KEY'],
    optIn: false,
  },
  google: {
    label: 'Google (Gemini)',
    models: [
      'gemini-4-argon',
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
    defaultModel: 'gemini-3.8-flash',
    envKeyVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    optIn: false,
  },
  openrouter: {
    label: 'OpenRouter (multi-provider)',
    models: [
      'anthropic/claude-opus-5.5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'anthropic/claude-fable-5.1',
      'openai/gpt-6-astra',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-luna',
      'google/gemini-4-argon',
      'google/gemini-3.8-flash',
    ],
    defaultModel: 'anthropic/claude-sonnet-5.5',
    // EMPTY ON PURPOSE, AND IT MUST STAY EMPTY. A platform key must never be sent to an aggregator: the
    // env fallback serves every tenant that has no config of its own, so an OPENROUTER_API_KEY here would
    // route tenants who never opted in through a third party. OpenRouter is tenant-key (BYOK) only.
    envKeyVars: [],
    optIn: true,
  },
};

export function isProvider(v: unknown): v is AiProvider {
  return typeof v === 'string' && (PROVIDERS as string[]).includes(v);
}

export function defaultModelFor(provider: AiProvider): string {
  return PROVIDER_META[provider].defaultModel;
}

/**
 * Platform-level fallback: the first provider (in precedence order) whose key env var is set, with
 * its default model (or the env model override for Anthropic). Used ONLY when a tenant has no active
 * config of its own. Returns null when no provider key is present in the environment.
 */
export function envFallbackConfig(): ResolvedAiConfig | null {
  for (const provider of PROVIDERS) {
    const meta = PROVIDER_META[provider];
    const keyVar = meta.envKeyVars.find((v) => process.env[v]?.trim());
    if (!keyVar) continue;
    const apiKey = process.env[keyVar]!.trim();
    const model = (meta.envModelVar && process.env[meta.envModelVar]?.trim()) || meta.defaultModel;
    return { provider, model, apiKey };
  }
  return null;
}

/** True when at least one provider key is present in the environment (platform default available). */
export function hasEnvFallback(): boolean {
  return envFallbackConfig() != null;
}
