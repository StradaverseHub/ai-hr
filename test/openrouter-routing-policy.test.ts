import { describe, expect, it } from 'vitest';
import { buildOpenRouterRoutingPolicy } from '../lib/ai/providers/openrouter-policy';

describe('unregistered OpenRouter routing policy', () => {
  it('pins privacy, supported parameters and the approved provider set', () => {
    expect(buildOpenRouterRoutingPolicy({ allowedProviders: ['openai', 'google-vertex/us-east5'] }))
      .toEqual({ only: ['openai', 'google-vertex/us-east5'], order: ['openai', 'google-vertex/us-east5'],
        allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true, sort: 'latency' });
  });
  it('bounds an explicitly enabled fallback to the same approved set', () => {
    const result = buildOpenRouterRoutingPolicy({ allowedProviders: ['openai', 'anthropic'], allowFallbacks: true, sort: 'price' });
    expect(result.allow_fallbacks).toBe(true);
    expect(result.only).toEqual(result.order);
    expect(result.only).toEqual(['openai', 'anthropic']);
    expect(result.data_collection).toBe('deny');
    expect(result.zdr).toBe(true);
  });
  it.each([
    {}, { allowedProviders: [] }, { allowedProviders: ['*'] },
    { allowedProviders: ['https://example.com'] }, { allowedProviders: ['openai', 'openai'] },
    { allowedProviders: ['openai'], data_collection: 'allow' },
    { allowedProviders: ['openai'], require_parameters: false },
    { allowedProviders: ['openai'], zdr: false },
    { allowedProviders: ['openai'], baseURL: 'http://127.0.0.1' },
    { allowedProviders: ['openai'], plugins: [{ id: 'web' }] },
    { allowedProviders: ['openai'], sort: 'unrecognized' },
    { allowedProviders: Array.from({ length: 33 }, (_, i) => `provider-${i}`) },
  ])('refuses malformed or policy-expanding configuration %#', value => {
    expect(() => buildOpenRouterRoutingPolicy(value)).toThrow('OpenRouter routing configuration unavailable');
  });
  it('captures and freezes policy so a caller cannot mutate the in-flight allowlist', () => {
    const configured = ['openai'];
    const result = buildOpenRouterRoutingPolicy({ allowedProviders: configured });
    configured.push('unapproved');
    expect(result.only).toEqual(['openai']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.only)).toBe(true);
  });
});
