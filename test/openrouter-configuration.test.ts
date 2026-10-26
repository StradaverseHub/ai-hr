/** Authored pure configuration regressions; UNRUN pending local resource handback. */
import { describe, expect, it } from 'vitest';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { buildOpenRouterRoutingPolicy } from '../lib/ai/providers/openrouter-policy';

describe('versioned OpenRouter persisted options', () => {
  it('materializes conservative defaults and captures deeply immutable routing before use', () => {
    const source = { version: 1, routing: { allowedProviders: ['approved-a', 'approved-b'] } };
    const options = readOpenRouterOptions(source);
    source.routing.allowedProviders[0] = 'unexpected';
    expect(options).toEqual({ version: 1, routing: { allowedProviders: ['approved-a', 'approved-b'], allowFallbacks: false, sort: 'latency' } });
    expect(Object.isFrozen(options)).toBe(true); expect(Object.isFrozen(options.routing)).toBe(true);
    expect(Object.isFrozen(options.routing.allowedProviders)).toBe(true);
    expect(buildOpenRouterRoutingPolicy(options.routing)).toMatchObject({ only: ['approved-a', 'approved-b'],
      order: ['approved-a', 'approved-b'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true });
    expect(readOpenRouterOptions(JSON.parse(JSON.stringify(options)))).toEqual(options);
  });
  it.each([null, {}, { version: 0, routing: { allowedProviders: ['approved'] } },
    { version: '1', routing: { allowedProviders: ['approved'] } },
    { version: 1, routing: { allowedProviders: [] } },
    { version: 1, routing: { allowedProviders: ['approved\n'] } },
    { version: 1, routing: { allowedProviders: ['approved', 'approved'] } },
    { version: 1, routing: { allowedProviders: ['https://unapproved.example'] } },
    { version: 1, routing: { allowedProviders: ['approved'], zdr: false } },
    { version: 1, routing: { allowedProviders: ['approved'], data_collection: 'allow' } },
    { version: 1, routing: { allowedProviders: ['approved'] }, plugins: ['web'] },
    { version: 1, routing: { allowedProviders: ['approved'] }, apiKey: 'not-an-option' },
  ])('refuses malformed/unknown version or uncontrolled fields before key/network access', source => {
    expect(() => readOpenRouterOptions(source)).toThrow('AI routing configuration unavailable.');
  });
});
