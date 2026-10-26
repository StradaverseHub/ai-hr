/** Synthetic transport fixture ONLY. Real canonical governance/storage still run in DB tests. */
import { vi } from 'vitest';
import type { SessionContext } from '../db/client';
import { openrouterAdapter } from '../lib/ai/providers/openrouter';
export function syntheticProviderTransport() {
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const draft = vi.spyOn(openrouterAdapter, 'generate').mockImplementation(async (_cfg, args) => {
    const marker = /eval_[a-f0-9-]+/.exec(args.prompt)?.[0];
    if (!marker) throw Error('Missing synthetic marker');
    args.onUsage?.(usage); return marker;
  });
  const conversation = vi.spyOn(openrouterAdapter, 'converse').mockImplementation(async (_cfg, args) => {
    const marker = /eval_[a-f0-9-]+/.exec(JSON.stringify(args.turns))?.[0];
    if (!marker) throw Error('Missing synthetic marker');
    if (args.turns.length === 1) return { text: '', stop: 'tool_use', toolCalls: [{ id: 'synthetic-call', name: 'integration_echo', input: { marker } }], usage, usageReported: true };
    return { text: marker, stop: 'end', toolCalls: [], usage, usageReported: true };
  });
  return { draft, conversation, restore() { draft.mockRestore(); conversation.mockRestore(); } };
}
export const syntheticConsent = { provider: 'openrouter', review: { version: 1, accountDefaultsReviewed: true, externalProcessingReviewed: true }, syntheticProbeConsent: true } as const;
export async function evaluateSyntheticCandidate(ctx: SessionContext) {
  const { evaluateProviderCandidate } = await import('../core/ai-provider-readiness');
  const mock = syntheticProviderTransport();
  try { return await evaluateProviderCandidate(ctx, syntheticConsent); }
  finally { mock.restore(); }
}
export async function activateSyntheticCandidate(ctx: SessionContext) {
  const { setActiveProvider } = await import('../core/ai-config');
  const result = await evaluateSyntheticCandidate(ctx);
  await setActiveProvider(ctx, { provider: 'openrouter', evaluationReceipt: result.receipt });
  return result;
}
