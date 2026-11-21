import { EMAIL_TABLE_MAX_COLUMNS, EMAIL_TABLE_MAX_ROWS, validateEmailLink, type EmailBodyDoc, type EmailBlock } from './doc';

/**
 * Paste policy shared by the browser cleaner (components/email-body-editor/paste-clean.ts, DOMPurify) and the server.
 * No DOM here. On the server, pasted content arrives as an EmailBodyDoc and is cleaned by the strict schema in
 * ./doc.ts; truncateDocTables is the server-side equivalent of the browser's table truncation.
 */
export const EMAIL_PASTE_MAX_HTML = 512_000;
export const EMAIL_PASTE_ALLOWED_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'div', 'img'] as const;
/** Only our own editor markers survive (internal copy/paste of chips, document links and uploaded images); no style, class, src or size. */
export const EMAIL_PASTE_ALLOWED_ATTR = ['href', 'alt', 'start', 'data-email-field', 'data-email-image', 'data-email-link', 'data-email-document', 'data-widths'] as const;

/** A pasted href the editor may keep as a link: https, http or mailto, fully valid; anything else loses the link (text stays). */
export function safePastedLink(href: string | null | undefined): { kind: 'web' | 'mailto'; href: string } | null {
  const value = (href ?? '').trim();
  if (!value) return null;
  const kind = /^mailto:/i.test(value) ? 'mailto' : 'web';
  if (kind === 'web' && !/^https?:\/\//i.test(value)) return null; // no scheme guessing on paste: relative and odd hrefs drop
  const result = validateEmailLink({ kind, href: value });
  return result.ok && result.href ? { kind, href: result.href } : null;
}

/** Keeps the first 6 columns x 30 rows of a grid and reports whether anything was cut. */
export function truncateTableGrid<T>(rows: readonly (readonly T[])[], maxRows = EMAIL_TABLE_MAX_ROWS, maxColumns = EMAIL_TABLE_MAX_COLUMNS): { rows: T[][]; truncated: boolean } {
  const truncated = rows.length > maxRows || rows.some(row => row.length > maxColumns);
  return { rows: rows.slice(0, maxRows).map(row => row.slice(0, maxColumns)), truncated };
}

/** Server-side: cut oversize tables in an otherwise well-formed doc (e.g. an import) before strict validation. */
export function truncateDocTables(doc: EmailBodyDoc): { doc: EmailBodyDoc; truncated: boolean } {
  let truncated = false;
  const content = doc.content.map((item): EmailBlock => {
    if (item.type !== 'table') return item;
    const cut = truncateTableGrid(item.content.map(row => row.content));
    truncated ||= cut.truncated;
    return { ...item, content: cut.rows.map(cells => ({ type: 'tableRow', content: cells })) };
  });
  return { doc: { ...doc, content }, truncated };
}
