/** Current canonical replay for historical answers. No model, provider, effect or stored result rows. */
import type { SessionContext } from '../db/client';
import { assistantSourceDigest, openAssistantDisclosure, type AssistantDisclosureBinding, type AssistantSourceRead } from '../lib/ai/assistant-disclosure';
import type { AssistantReadSession } from './assistant-read-session';
import { toolsFor } from './assistant-tools';
import { assistantPublicToolResult } from '../lib/ai/assistant-public-replies';

/** One bounded replay budget per source owner, with exact lookup/fingerprint deduplication.
 * It lives only in the current authorized read transaction, never a cross-user/process cache.
 * A changed result retires this answer; it never silently rewrites historical facts as current ones.
 */
export function assistantSourceReplay(ctx: SessionContext, session: AssistantReadSession,reopenModule?:(source:AssistantSourceRead)=>Promise<unknown>) {
  let remaining = 128;
  const checked = new Map<string, boolean>();
  const offered = toolsFor(ctx);
  return async (reads: readonly AssistantSourceRead[]): Promise<boolean> => {
    if (reads.length > 128) return false;
    for (const source of reads) {
      const tool = offered.find(item => item.spec.name === source.name);
      if (!tool) return false;
      const key = JSON.stringify([source.name, source.input, source.digest,source.moduleJobId??null]);
      const prior = checked.get(key);
      if (prior !== undefined) { if (!prior) return false; continue; }
      if (remaining-- <= 0) return false;
      let allowed = false;
      try { allowed = assistantSourceDigest(source.moduleJobId?(reopenModule?await reopenModule(source):null):assistantPublicToolResult(await tool.run(ctx, source.input, session))) === source.digest; }
      catch { allowed = false; }
      checked.set(key, allowed);
      if (!allowed) return false;
    }
    return true;
  };
}

export function assistantHistoryReplay(ctx: SessionContext, session: AssistantReadSession) {
  const replay = assistantSourceReplay(ctx, session);
  return async (binding: AssistantDisclosureBinding, sealed: unknown): Promise<boolean> => {
    if (binding.tenantId !== ctx.tenantId || binding.userId !== ctx.userId) return false;
    const reads = openAssistantDisclosure(binding, sealed);
    return reads !== null && await replay(reads);
  };
}
