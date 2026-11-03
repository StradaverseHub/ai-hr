'use server';

import { revalidatePath } from 'next/cache';
import { authenticateOwnLeaveBrowserSession } from '@/core/assistant-actions/own-leave-server';
import { confirmChatImport, type ChatImportConfirmResult } from '@/core/chat-import/confirm';
import { CHAT_IMPORT_PAGES } from '@/lib/chat-import';

/** AI v2 Phase 1, slice 3 (issue 16b) — "Confirm N rows" on an import prepared in chat. The session comes from the
 * person's own cookie login (the browser-command authenticator the chat cards use), never from the post; the posted
 * proposal and file are only data, verified for this caller inside the owner (core/chat-import/confirm.ts), which
 * commits through the import owner's own path. Nothing happens unless `confirm` is exactly true. */
export async function confirmChatImportAction(input: { proposal: unknown; confirm: unknown; file?: unknown }): Promise<ChatImportConfirmResult> {
  let session: Awaited<ReturnType<typeof authenticateOwnLeaveBrowserSession>>;
  try { session = await authenticateOwnLeaveBrowserSession(); } catch { return { kind: 'refused', reason: 'unavailable' }; }
  const result = await confirmChatImport(session.ctx, { proposal: input?.proposal, confirm: input?.confirm, file: input?.file });
  if (result.kind === 'imported' && !result.replayed) revalidatePath(CHAT_IMPORT_PAGES[result.importKind]);
  return result;
}
