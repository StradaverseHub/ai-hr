/** Current canonical replay for historical answers. No model, provider, effect or stored result rows. */
import type { SessionContext } from '../db/client';
import { assistantSourceDigest, openAssistantDisclosure, type AssistantDisclosureBinding } from '../lib/ai/assistant-disclosure';
import type { AssistantReadSession } from './assistant-read-session';
import { toolsFor } from './assistant-tools';

/** One bounded replay budget for the whole workspace, with exact lookup/fingerprint deduplication.
 * It lives only in the current authorized read transaction, never a cross-user/process cache.
 * A changed result retires this answer; it never silently rewrites historical facts as current ones.
 */
export function assistantHistoryReplay(ctx: SessionContext, session: AssistantReadSession) {
  let remaining = 128;
  const checked = new Map<string, boolean>();
  const offered = toolsFor(ctx);
  return async (binding: AssistantDisclosureBinding, sealed: unknown): Promise<boolean> => {
    if (binding.tenantId !== ctx.tenantId || binding.userId !== ctx.userId) return false;
    const reads = openAssistantDisclosure(binding, sealed);
    if (!reads) return false;
    for (const source of reads) {
      const tool = offered.find(item => item.spec.name === source.name);
      if (!tool) return false;
      const key = JSON.stringify([source.name, source.input, source.digest]);
      const prior = checked.get(key);
      if (prior !== undefined) { if (!prior) return false; continue; }
      if (remaining-- <= 0) return false;
      let allowed = false;
      try { allowed = assistantSourceDigest(await tool.run(ctx, source.input, session)) === source.digest; }
      catch { allowed = false; }
      checked.set(key, allowed);
      if (!allowed) return false;
    }
    return true;
  };
}
