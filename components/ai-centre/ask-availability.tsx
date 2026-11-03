'use client';
import { createContext, useContext, type ReactNode } from 'react';

/** AI v2 Phase 1, W4 — whether the command bar offers "Ask AI Centre". The shell passes the result it already
 * reads for the sidebar's AI Centre row (app/layout.tsx: mayUseAssistant, failing closed). Presentation only:
 * every question is re-checked by the conversation command (app/assistant/launcher-actions.ts). Outside the
 * provider (tests, the sign-in shell) it is false, so the command bar is exactly the old one. */
const AskAvailable = createContext(false);

export function AiAskAvailability({ available, children }: { available: boolean; children: ReactNode }) {
  return <AskAvailable.Provider value={available}>{children}</AskAvailable.Provider>;
}

export function useAiAskAvailable(): boolean {
  return useContext(AskAvailable);
}
