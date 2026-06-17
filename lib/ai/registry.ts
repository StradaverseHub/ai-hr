/**
 * Provider/model registry (ADR-0023). The dropdown options + display labels + the env-var fallback.
 * Model lists are SUGGESTIONS for the picker, not an allowlist — provider model ids drift, so any
 * non-empty model string is accepted and the provider rejects unknown ids at call time.
 */
import type { AiProvider, ResolvedAiConfig } from './types';

export const PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'google'];

export const PROVIDER_META: Record<
  AiProvider,
  { label: string; models: string[]; defaultModel: string; envKeyVars: string[]; envModelVar?: string }
> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    defaultModel: 'claude-opus-4-8',
    envKeyVars: ['ANTHROPIC_API_KEY'],
    envModelVar: 'AI_DRAFT_MODEL',
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-5.5', 'gpt-4o', 'gpt-4o-mini'],
    defaultModel: 'gpt-5.5',
    envKeyVars: ['OPENAI_API_KEY'],
  },
  google: {
    label: 'Google (Gemini)',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
    defaultModel: 'gemini-2.5-flash',
    envKeyVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
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
