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
