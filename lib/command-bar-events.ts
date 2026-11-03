/**
 * r398 — the ONE way to open the command bar from outside it (components/command-bar.tsx).
 *
 * The Monolith intent bar (components/intent-bar.tsx) is the command bar MADE VISIBLE (docs/design/monolith
 * README §3), not a second palette: it owns no results, no registry and no dialog. It hands what the user
 * typed to the existing <CommandBar /> — which stays mounted in the header in both themes, with its ⌘K
 * listener — through this window event. A DOM event rather than a shared React store because the two sit in
 * different subtrees of a server layout, and because this module must stay importable without dragging the
 * command bar's delegation panel and server action along (the intent bar's tests import it bare).
 */
export const OPEN_COMMAND_BAR_EVENT = 'aihr:open-command-bar';

export type OpenCommandBarDetail = { query: string };

export function openCommandBar(query = ''): void {
  window.dispatchEvent(new CustomEvent<OpenCommandBarDetail>(OPEN_COMMAND_BAR_EVENT, { detail: { query } }));
}

/**
 * AI v2 Phase 1, W4 — the command bar hands typed text to AI Centre on the page the person is on.
 *
 * The side panel (components/assistant/assistant-launcher.tsx) or, on Ask itself, the conversation
 * (components/assistant/workspace-conversation.tsx) takes the question and sends it through its own existing
 * command, so the answer continues the chat that surface already holds and the page context is the one that
 * surface already sends (an area and at most one record id from the address). Only the words travel here: no
 * label, record value or action. A listener sets `result` synchronously: 'sent' when it took the question,
 * 'busy' while it is still answering. 'none' means nothing on this page took it, and the command bar carries the
 * question to a new Ask chat instead (lib/today/ask-handoff.ts). Nothing here runs an action: a reply may hold a
 * prepared card, which still needs the person's Confirm.
 */
export const ASK_AI_CENTRE_EVENT = 'aihr:ask-ai-centre';

export type AskAiCentreResult = 'sent' | 'busy' | 'none';
export type AskAiCentreDetail = { question: string; result: AskAiCentreResult };

export function askAiCentre(question: string): AskAiCentreResult {
  const detail: AskAiCentreDetail = { question, result: 'none' };
  window.dispatchEvent(new CustomEvent<AskAiCentreDetail>(ASK_AI_CENTRE_EVENT, { detail }));
  return detail.result;
}

/** For a listener: the question, when the event carries a usable one and nothing has taken it yet. */
export function unclaimedAskQuestion(event: Event): { detail: AskAiCentreDetail; question: string } | null {
  const detail = (event as CustomEvent<AskAiCentreDetail>).detail;
  if (!detail || detail.result !== 'none' || typeof detail.question !== 'string') return null;
  const question = detail.question.trim();
  return question ? { detail, question } : null;
}
