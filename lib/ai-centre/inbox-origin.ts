/** Where a decision page was opened from, carried only as an allow-listed marker (never a return URL, so nothing a
 * link carries can redirect anywhere): the AI centre Inbox's Review links add it, and the shell then offers the way
 * back to the Inbox (components/ai-centre/back-to-inbox.tsx). Staging acceptance, 3 November 2026. */
export const AI_INBOX_ORIGIN = 'ai-inbox';
export const AI_INBOX_HREF = '/assistant?view=inbox';

/** The same link with the Inbox origin added to its query, before any fragment. */
export function withInboxOrigin(href: string): string {
  const at = href.indexOf('#'), path = at < 0 ? href : href.slice(0, at), hash = at < 0 ? '' : href.slice(at);
  return path + (path.includes('?') ? '&' : '?') + 'from=' + AI_INBOX_ORIGIN + hash;
}

/** True only for the allow-listed origin; anything else, repeated or foreign, is ignored. */
export const cameFromInbox = (params: Pick<URLSearchParams, 'getAll'> | null | undefined) => {
  const values = params?.getAll('from') ?? [];
  return values.length === 1 && values[0] === AI_INBOX_ORIGIN;
};
