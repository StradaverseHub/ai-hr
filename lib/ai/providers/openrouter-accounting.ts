/** Provider accounting reader. No request, settlement, estimate or price lookup.
 * Missing provider metadata stays unknown. Never use upstream inference cost as the account charge. */
import type { AiUsage } from '../types';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const charge = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export type OpenRouterAccounting = Readonly<{
  totalTokens: number | null;
  usage: Readonly<AiUsage> | null;
  accountCostCredits: number | null;
  reasoningTokens: number | null;
  cacheWriteTokens: number | null;
}>;

/** Takes the response's usage object, not the whole provider response. Completion includes reasoning;
 * prompt includes cache reads. Cache writes are diagnostic, not an additional token debit. Costs are
 * provider-reported credits, not a computed USD invoice. Each independently missing value is null. */
export function readOpenRouterAccounting(value: unknown): OpenRouterAccounting {
  const source = record(value);
  const prompt = count(source?.prompt_tokens), completion = count(source?.completion_tokens);
  const candidateTotal = prompt !== null && completion !== null ? count(prompt + completion) : null;
  const total = candidateTotal !== null && (source?.total_tokens === undefined
    || count(source.total_tokens) === candidateTotal) ? candidateTotal : null;
  const promptDetails = record(source?.prompt_tokens_details);
  const cached = count(promptDetails?.cached_tokens);
  const usage = total !== null && prompt !== null && completion !== null && cached !== null && cached <= prompt
    ? Object.freeze({ inputTokens: prompt - cached, outputTokens: completion, cachedInputTokens: cached }) : null;
  const reasoning = count(record(source?.completion_tokens_details)?.reasoning_tokens);
  const writes = count(promptDetails?.cache_write_tokens);
  return Object.freeze({
    totalTokens: total,
    usage,
    accountCostCredits: charge(source?.cost),
    reasoningTokens: reasoning !== null && completion !== null && reasoning <= completion ? reasoning : null,
    cacheWriteTokens: writes !== null && prompt !== null && writes <= prompt ? writes : null,
  });
}
