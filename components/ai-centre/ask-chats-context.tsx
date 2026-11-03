'use client';
import { createContext, useContext } from 'react';

/** AI v2 Phase 1, W4 — the one link between Ask's conversation (components/assistant/workspace-conversation.tsx)
 * and its Chats column (components/ai-centre/ask-chats.tsx). The conversation reports the stored chat a reply
 * was written to (the chat id the conversation command returned), so the column can show it and offer Delete.
 * It carries no words. Outside Ask (the side panel, tests) there is no provider and nothing is reported. */
export type AskChatsLink = { storedChat: (chatId: string) => void };

export const AskChatsContext = createContext<AskChatsLink | null>(null);

export function useAskChatsLink(): AskChatsLink | null {
  return useContext(AskChatsContext);
}
