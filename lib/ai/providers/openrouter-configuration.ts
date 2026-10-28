/** Versioned persisted options boundary. Not provider registration or authorization to disclose data. */
import { z } from 'zod';
import { OpenRouterRoutingConfiguration } from './openrouter-policy';

const Options = z.object({ version: z.literal(1), routing: OpenRouterRoutingConfiguration }).strict();
export type OpenRouterOptions = Readonly<{
  version: 1;
  routing: Readonly<{ allowedProviders: readonly string[]; allowFallbacks: boolean; sort: 'price' | 'latency' }>;
}>;

/** No guessed allowlist, opaque option passthrough or automatic provider/model selection. Save and
 * privileged resolution must both call this owner. Old/unknown versions refuse before key use. */
export function readOpenRouterOptions(value: unknown): OpenRouterOptions {
  const parsed = Options.safeParse(value);
  if (!parsed.success) throw new Error('AI routing configuration unavailable.');
  return Object.freeze({ version: 1 as const, routing: Object.freeze({
    allowedProviders: Object.freeze([...parsed.data.routing.allowedProviders]),
    allowFallbacks: parsed.data.routing.allowFallbacks,
    sort: parsed.data.routing.sort,
  }) });
}
