/** Where a decision page was opened from, carried only as an allow-listed marker (never a return URL, so nothing a
 * link carries can redirect anywhere): Today's Review links add it, and the shell then offers the way back to Today
 * (components/ai-centre/back-to-inbox.tsx). Staging acceptance, 3 November 2026; AI v2 Phase 1 retired the AI
 * Centre Inbox, which Today replaces, so the same mechanism now returns to Today at `/`. */
export const TODAY_ORIGIN = 'today';
export const TODAY_HREF = '/';

/** The same link with the Today origin added to its query, before any fragment. */
export function withTodayOrigin(href: string): string {
  const at = href.indexOf('#'), path = at < 0 ? href : href.slice(0, at), hash = at < 0 ? '' : href.slice(at);
  return path + (path.includes('?') ? '&' : '?') + 'from=' + TODAY_ORIGIN + hash;
}

/** True only for the allow-listed origin; anything else, repeated or foreign, is ignored. */
export const cameFromToday = (params: Pick<URLSearchParams, 'getAll'> | null | undefined) => {
  const values = params?.getAll('from') ?? [];
  return values.length === 1 && values[0] === TODAY_ORIGIN;
};
