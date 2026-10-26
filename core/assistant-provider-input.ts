/** Trusted Assistant preparation. No posted/model capability selects authority or an admission check. */
import { createHash } from 'node:crypto';
import type { SessionContext } from '../db/client';
import { captureAgentReadBatch } from '../lib/ai/agent-read-batch';
import { captureAssistantSourceReads, type AssistantSourceRead } from '../lib/ai/assistant-disclosure';
import { captureConversationInput, conversationInputDigest } from '../lib/ai/conversation-input';
import { AiGatewayError, type ConverseArgs, type ResolvedAiConfig } from '../lib/ai/types';
import { withAiAdmissionCheck } from './ai-governance';
import { withAssistantAdmissionReadsTx } from './assistant-read-session';
import { assistantSourceReplay } from './assistant-disclosure-read';
import { resolveEntitlementsTx } from './entitlements';
import { specsFor } from './assistant-tools';
import { ASSISTANT_PUBLIC_REPLIES } from '../lib/ai/assistant-public-replies';
const refused = (): never => { throw new AiGatewayError('The current Assistant source access could not be confirmed.'); };
const fingerprint = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const key = (name: string, input: unknown, digest: string) => JSON.stringify([name, input, digest]);

/** Match EVERY non-error tool result to its actual captured source evidence, not an unrelated
 * successful read used as a decoy. Result IDs/names must close the exact preceding call graph.
 * Errors can carry only the loop's three fixed generic sentences, never source/provider bodies.
 */
function assertConversationSources(args: ConverseArgs, sources: readonly AssistantSourceRead[]) {
  const available = new Map<string, number>();
  for (const source of sources) {
    const k = key(source.name, source.input, source.digest);
    available.set(k, (available.get(k) ?? 0) + 1);
  }
  const pending = new Map<string, { name: string; input: unknown }>();
  for (const turn of args.turns) {
    if (turn.role === 'assistant') {
      if (pending.size) return refused();
      if (turn.toolCalls?.length) for (const call of captureAgentReadBatch(turn.toolCalls)) pending.set(call.id, call);
    } else if (turn.role === 'tool') {
      if (!pending.size || turn.results.length !== pending.size) return refused();
      for (const result of turn.results) {
        const call = pending.get(result.id);
        if (!call || call.name !== result.name) return refused();
        pending.delete(result.id);
        if (result.isError) {
          if (![ASSISTANT_PUBLIC_REPLIES.tool, ASSISTANT_PUBLIC_REPLIES.arguments, ASSISTANT_PUBLIC_REPLIES.lookup].some(message => message === result.content)) return refused();
          continue;
        }
        const k = key(call.name, call.input, fingerprint(result.content));
        const count = available.get(k) ?? 0;
        if (count < 1) return refused();
        available.set(k, count - 1);
      }
    } else if (pending.size) return refused();
  }
  if (pending.size || [...available.values()].some(count => count !== 0)) return refused();
}

/** Exact immutable request -> source replay in the SAME current provider admission transaction ->
 * canonical reservation -> provider outside that transaction. Current fingerprints must still match.
 * This establishes an admission-time check, not retroactive erasure or model-fact adjudication.
 */
export function prepareAssistantConversation(ctx: SessionContext, configuration: ResolvedAiConfig,
  input: ConverseArgs, evidence: readonly AssistantSourceRead[], expiresAt = Date.now() + 300_000) {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return refused();
  let args: ConverseArgs, sources: readonly AssistantSourceRead[];
  try { args = captureConversationInput(input); sources = captureAssistantSourceReads(evidence); assertConversationSources(args, sources); }
  catch { return refused(); }
  const expected = conversationInputDigest(args);
  const bound = withAiAdmissionCheck(configuration, 'hr_assistant', async (tx, request) => {
    if (Date.now() >= expiresAt || request.operation !== 'conversation' || request.inputDigest !== expected) return refused();
    const fresh = { ...captured, entitlements: await resolveEntitlementsTx(tx, captured.tenantId) };
    if (JSON.stringify(specsFor(fresh)) !== JSON.stringify(args.tools)) return refused();
    const current = await withAssistantAdmissionReadsTx(fresh, tx, session => assistantSourceReplay(fresh, session)(sources));
    if (!current || Date.now() >= expiresAt) return refused();
  });
  return Object.freeze({ configuration: bound, args });
}
