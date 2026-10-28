import { describe, expect, it } from 'vitest';
import { readOpenRouterAccounting } from '../lib/ai/providers/openrouter-accounting';

describe('unregistered OpenRouter accounting reader', () => {
  it('counts cached input once and keeps reasoning inside total output', () => {
    expect(readOpenRouterAccounting({ prompt_tokens: 194, completion_tokens: 60, total_tokens: 254,
      prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 40 }, cost: 0.0095,
      cost_details: { upstream_inference_cost: 19 } })).toEqual({
      totalTokens: 254, usage: { inputTokens: 174, cachedInputTokens: 20, outputTokens: 60 },
      accountCostCredits: 0.0095, reasoningTokens: 40, cacheWriteTokens: 100,
    });
  });
  it('distinguishes an explicit reported zero from absent accounting', () => {
    expect(readOpenRouterAccounting(undefined)).toEqual({ totalTokens: null, usage: null,
      accountCostCredits: null, reasoningTokens: null, cacheWriteTokens: null });
    expect(readOpenRouterAccounting({ prompt_tokens: 0, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 }, cost: 0 }).usage)
      .toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(readOpenRouterAccounting({ cost: 0 }).accountCostCredits).toBe(0);
  });
  it('retains known total while refusing to invent an absent cache breakdown', () => {
    const result = readOpenRouterAccounting({ prompt_tokens: 10, completion_tokens: 5 });
    expect(result.totalTokens).toBe(15);
    expect(result.usage).toBeNull();
    expect(result.accountCostCredits).toBeNull();
  });
  it.each([
    { prompt_tokens: -1, completion_tokens: 5 },
    { prompt_tokens: 1.5, completion_tokens: 5 },
    { prompt_tokens: '10', completion_tokens: 5 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 16 },
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: null },
  ])('refuses invalid or inconsistent totals %#', value => {
    expect(readOpenRouterAccounting(value).totalTokens).toBeNull();
    expect(readOpenRouterAccounting(value).usage).toBeNull();
  });
  it('refuses impossible cache/reasoning detail without replacing it with zero', () => {
    const result = readOpenRouterAccounting({ prompt_tokens: 10, completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 11, cache_write_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 6 } });
    expect(result.totalTokens).toBe(15);
    expect(result.usage).toBeNull();
    expect(result.reasoningTokens).toBeNull();
    expect(result.cacheWriteTokens).toBeNull();
  });
  it.each([NaN, Infinity, -1, '0.1', null])('keeps malformed charges unknown %#', cost => {
    expect(readOpenRouterAccounting({ cost, cost_details: { upstream_inference_cost: 1 } }).accountCostCredits).toBeNull();
  });
  it('returns only bounded accounting fields and freezes returned counters', () => {
    const result = readOpenRouterAccounting({ prompt_tokens: 10, completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 2 }, private_debug: 'not retained' });
    expect(Object.keys(result).sort()).toEqual(['accountCostCredits', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'usage']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
  });
});
