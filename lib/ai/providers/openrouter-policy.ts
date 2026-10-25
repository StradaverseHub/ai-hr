/** Unregistered OpenRouter routing boundary. Pure policy construction only: no key, network,
 * model selection, HR data or tool execution. The eventual adapter must derive these preferences
 * from authorized tenant configuration and keep them outside user/model-controlled request fields.
 * Routing filters are not evidence of provider compliance or permission to disclose a field. */
import { z } from 'zod';

const providerSlug = z.string().min(1).max(128).regex(/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/);
const Configuration = z.object({
  allowedProviders: z.array(providerSlug).min(1).max(32)
    .refine(values => new Set(values).size === values.length),
  allowFallbacks: z.boolean().default(false),
  sort: z.enum(['price', 'latency']).default('latency'),
}).strict();

/** An ordered approved provider list also constrains every fallback. OpenRouter's `order` alone
 * is a preference; `only` is the allowlist. Never silently relax privacy or parameter support to
 * recover availability. `latency` is a routing preference, not an end-to-end deadline guarantee. */
export function buildOpenRouterRoutingPolicy(configuration: unknown) {
  const parsed = Configuration.safeParse(configuration);
  if (!parsed.success) throw new Error('OpenRouter routing configuration unavailable');
  const providers = Object.freeze([...parsed.data.allowedProviders]);
  return Object.freeze({
    only: providers,
    order: providers,
    allow_fallbacks: parsed.data.allowFallbacks,
    require_parameters: true as const,
    data_collection: 'deny' as const,
    zdr: true as const,
    sort: parsed.data.sort,
  });
}
