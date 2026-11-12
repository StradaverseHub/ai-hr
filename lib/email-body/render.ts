import { EMAIL_ID, sameLink, validateEmailLink, type EmailBodyDoc, type EmailBlock, type EmailFlowBlock, type EmailInline, type EmailLinkAttrs, type EmailMark, type EmailTable } from './doc';

/**
 * One pure renderer: EmailBodyDoc + merged values -> email-safe HTML and plain text (board 6bdda222). No DOM, React or
 * tiptap (docs/SCALE-AND-RELEASE-RULES.md rule 7), so the mailer, the case preview and the editor preview share it.
 *
 * Values are escaped per text node and never spliced into markup: a value holding "<b>", "&", "{image:x}" or
 * "{employee.x}" stays literal text. Document links render a {{document-link:<id>}} href token that
 * resolveDocumentLinks() swaps for each person's own link at send time. sanitiseEmailHtml() is the final allowlist pass.
 */
export type EmailRenderImage = { id: string; alt?: string; cid: string };
export type EmailRenderOptions = {
  values: Readonly<Record<string, string | undefined>>;
  /** Readable name for a field key, used for "[Employee name]" when readableMissing (mirrors merge()). */
  missingLabel?: (key: string) => string | undefined;
  readableMissing?: boolean;
  images?: readonly EmailRenderImage[];
  documentLink?: (documentId: string) => { name: string; placeholder?: string } | null | undefined;
  /** Sensitive keys throw, exactly like merge(). */
  sensitive?: (key: string) => boolean;
  /** Plain-text wording, for i18n. */
  textLabels?: { personalLinkBelow?: string; image?: string };
};
export type EmailRenderResult = { html: string; text: string; missing: string[]; fields: string[]; documents: string[] };

export const EMAIL_HTML_WARN_BYTES = 100_000; // Gmail clips messages around 102 KB
export const EMAIL_HTML_MAX_BYTES = 1_000_000;
export const emailHtmlBytes = (html: string) => new TextEncoder().encode(html).length;
export const emailHtmlNearLimit = (html: string) => emailHtmlBytes(html) >= EMAIL_HTML_WARN_BYTES;

export const documentLinkToken = (documentId: string) => {
  if (!EMAIL_ID.test(documentId)) throw new Error('Invalid document id');
  return `{{document-link:${documentId}}}`;
};
const DOCUMENT_HREF = /href="\{\{document-link:([A-Za-z0-9_-]{1,100})\}\}"/g;
export const documentLinkIds = (html: string) => [...new Set([...html.matchAll(DOCUMENT_HREF)].map(match => match[1]))];

/**
 * Replaces ONLY document-link href tokens produced by the renderer (inside href="…") with each person's link. Text
 * is returned unchanged: the plain-text body says "(personal link below)" and the mailer lists the links after it.
 * Every referenced id must have an https/http link, otherwise this throws rather than send a token.
 */
export function resolveDocumentLinks(html: string, text: string, links: ReadonlyMap<string, string> | Readonly<Record<string, string>>): { html: string; text: string } {
  const get = (id: string) => links instanceof Map ? links.get(id) : (links as Record<string, string>)[id];
  return { text, html: html.replace(DOCUMENT_HREF, (_, id: string) => {
    const url = get(id), check = url ? validateEmailLink({ kind: 'web', href: url }, { normalise: false }) : null;
    if (!url || !check?.ok) throw new Error('A document link is unavailable');
    return `href="${escapeAttr(url)}"`;
  }) };
}

const escapeAttr = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
/** Text escaping; braces too, so no merged value can look like a token to a later pass. */
export const escapeHtml = (value: string) => value.replace(/[&<>"'{}]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[character]!);

const FONT = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937';
const LINK_STYLE = 'color:#1d4ed8;text-decoration:underline;word-break:break-word;overflow-wrap:anywhere';
const CELL_STYLE = 'padding:6px 8px;border:1px solid #d1d5db;vertical-align:top;text-align:left;word-break:break-word;overflow-wrap:anywhere';
const P = '<p style="margin:0 0 12px 0">', P_TIGHT = '<p style="margin:0">';

type Ctx = { options: EmailRenderOptions; missing: string[]; fields: string[]; documents: string[]; images: Map<string, EmailRenderImage> };
type LinkMark = Extract<EmailMark, { type: 'link' }>;
const linkOf = (node: EmailInline) => node.type === 'text' || node.type === 'field' ? node.marks?.find((item): item is LinkMark => item.type === 'link')?.attrs : undefined;
const has = (node: EmailInline, type: 'bold' | 'italic' | 'underline') => (node.type === 'text' || node.type === 'field') && !!node.marks?.some(item => item.type === type);

function fieldValue(key: string, ctx: Ctx): string {
  if (ctx.options.sensitive?.(key)) throw new Error('Sensitive fields cannot be included in an email.');
  if (!ctx.fields.includes(key)) ctx.fields.push(key);
  const value = ctx.options.values[key];
  if (value !== undefined && value !== '') return value;
  if (!ctx.missing.includes(key)) ctx.missing.push(key);
  return `[${(ctx.options.readableMissing && ctx.options.missingLabel?.(key)) || key}]`;
}
function image(id: string, ctx: Ctx) {
  const found = ctx.images.get(id);
  if (!found) throw new Error('An inline image is unavailable');
  return found;
}
/** Consecutive nodes sharing one link render as one <a> and one "text (address)". */
function groups(list: EmailInline[]): { link?: EmailLinkAttrs; nodes: EmailInline[] }[] {
  const out: { link?: EmailLinkAttrs; nodes: EmailInline[] }[] = [];
  for (const node of list) {
    const link = linkOf(node), last = out.at(-1);
    if (last && (link ? sameLink(last.link, link) : !last.link)) last.nodes.push(node);
    else out.push({ link, nodes: [node] });
  }
  return out;
}
function checkedLink(link: EmailLinkAttrs, ctx: Ctx): string {
  if (link.kind === 'document') {
    const id = link.documentId ?? '';
    if (!EMAIL_ID.test(id) || !ctx.options.documentLink?.(id)) throw new Error('A linked document is unavailable');
    if (!ctx.documents.includes(id)) ctx.documents.push(id);
    return ctx.options.documentLink(id)!.placeholder ?? documentLinkToken(id);
  }
  const result = validateEmailLink(link, { normalise: false });
  if (!result.ok) throw new Error('A link in the email body is invalid');
  return result.href!;
}

// ------------------------------------------------------------------------------------------------------------ HTML

const spaces = (html: string) => html.replace(/ (?= )/g, '&#160;');
function inlineHtml(list: EmailInline[], ctx: Ctx, inCell: boolean): string {
  const node = (item: EmailInline): string => {
    if (item.type === 'hardBreak') return '<br>';
    if (item.type === 'image') {
      const found = image(item.attrs.assetId, ctx), alt = escapeHtml(found.alt ?? item.attrs.alt);
      return inCell ? `<img src="cid:${escapeHtml(found.cid)}" alt="${alt}" width="64" style="display:inline-block;width:64px;max-width:64px;height:auto;border:0">`
        : `<img src="cid:${escapeHtml(found.cid)}" alt="${alt}" style="display:inline-block;max-width:100%;height:auto;border:0">`;
    }
    let html = spaces(escapeHtml(item.type === 'text' ? item.text : fieldValue(item.attrs.key, ctx))).replace(/\r?\n/g, '<br>');
    if (has(item, 'underline')) html = `<u>${html}</u>`;
    if (has(item, 'italic')) html = `<em>${html}</em>`;
    if (has(item, 'bold')) html = `<strong>${html}</strong>`;
    return html;
  };
  const html = groups(list).map(group => {
    const inner = group.nodes.map(node).join('');
    return group.link ? `<a href="${escapeAttr(checkedLink(group.link, ctx))}" target="_blank" rel="noopener noreferrer" style="${LINK_STYLE}">${inner}</a>` : inner;
  }).join('');
  // A leading space (start of paragraph or line) would collapse in HTML; keep it visible like the plain text.
  return html.replace(/(^|<br>)((?:<(?:strong|em|u|a)\b[^>]*>)*) /g, '$1$2&#160;');
}
function flowHtml(blocks: EmailFlowBlock[], ctx: Ctx, tight: boolean, inCell: boolean): string {
  return blocks.map((item, index) => {
    if (item.type === 'paragraph') {
      const inner = inlineHtml(item.content ?? [], ctx, inCell);
      return (tight ? (index === blocks.length - 1 ? P_TIGHT : '<p style="margin:0 0 6px 0">') : P) + (inner || '&#160;') + '</p>';
    }
    const tag = item.type === 'orderedList' ? 'ol' : 'ul';
    const start = item.type === 'orderedList' && item.attrs?.start !== undefined && item.attrs.start !== 1 ? ` start="${item.attrs.start}"` : '';
    return `<${tag}${start} style="margin:0 0 ${tight ? 6 : 12}px 0;padding:0 0 0 24px">` + item.content.map(li => `<li style="margin:0 0 4px 0">${flowHtml(li.content, ctx, true, inCell)}</li>`).join('') + `</${tag}>`;
  }).join('');
}
function tableHtml(item: EmailTable, ctx: Ctx): string {
  const columns = item.content[0]?.content.length ?? 1, equal = item.attrs.widths === 'equal';
  const width = `${Math.floor(10000 / columns) / 100}%`;
  const open = equal ? '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 12px 0">'
    : '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:100%;margin:0 0 12px 0">';
  const rows = item.content.map(tr => '<tr>' + tr.content.map(td => {
    const header = td.type === 'tableHeader', tag = header ? 'th' : 'td';
    const sizing = equal ? ` width="${width}"` : '';
    const style = CELL_STYLE + (equal ? `;width:${width}` : '') + (header ? ';background:#f3f4f6;font-weight:bold' : '');
    return `<${tag}${header ? ' scope="col"' : ''}${sizing} align="left" valign="top" style="${style}">${flowHtml(td.content, ctx, true, true)}</${tag}>`;
  }).join('') + '</tr>').join('');
  return open + rows + '</table>';
}
const blockHtml = (item: EmailBlock, ctx: Ctx) => item.type === 'table' ? tableHtml(item, ctx) : flowHtml([item], ctx, false, false);

// ------------------------------------------------------------------------------------------------------ plain text

function inlineText(list: EmailInline[], ctx: Ctx): string {
  const labels = ctx.options.textLabels ?? {};
  const node = (item: EmailInline) => item.type === 'text' ? item.text : item.type === 'hardBreak' ? '\n' : item.type === 'field' ? fieldValue(item.attrs.key, ctx)
    : `[${labels.image ?? 'Image'}: ${image(item.attrs.assetId, ctx).alt ?? item.attrs.alt}]`;
  return groups(list).map(group => {
    const inner = group.nodes.map(node).join('');
    if (!group.link) return inner;
    const target = checkedLink(group.link, ctx);
    if (group.link.kind === 'document') return `${inner.trim() || ctx.options.documentLink!(group.link.documentId!)!.name} (${labels.personalLinkBelow ?? 'personal link below'})`;
    const address = group.link.kind === 'mailto' ? target.replace(/^mailto:/i, '') : target;
    const shown = inner.trim();
    return !shown || shown === address || shown === target || `https://${shown}` === target || `http://${shown}` === target ? address : `${inner} (${address})`;
  }).join('');
}
function flowText(blocks: EmailFlowBlock[], ctx: Ctx, indent: string): string[] {
  return blocks.map(item => {
    if (item.type === 'paragraph') return indent + inlineText(item.content ?? [], ctx).replace(/\n/g, `\n${indent}`);
    const start = item.type === 'orderedList' ? item.attrs?.start ?? 1 : 1;
    return item.content.map((li, index) => {
      const bullet = item.type === 'orderedList' ? `${start + index}. ` : '- ';
      const inner = flowText(li.content, ctx, indent + ' '.repeat(bullet.length)).join('\n');
      return indent + bullet + inner.slice(indent.length + bullet.length);
    }).join('\n');
  });
}
const cellText = (blocks: EmailFlowBlock[], ctx: Ctx) => flowText(blocks, ctx, '').join('\n').trim();
function tableText(item: EmailTable, ctx: Ctx): string {
  const rows = item.content.map(tr => tr.content.map(td => cellText(td.content, ctx)));
  if (!item.attrs.headerRow) return rows.map(cells => cells.join(' | ')).join('\n');
  const [headings, ...data] = rows;
  if (!data.length) return headings.join(' | ');
  // "Heading: value" per cell; a multi-line value continues on indented lines; rows are separated by a blank line.
  return data.map(cells => cells.map((value, c) => {
    const heading = headings[c] || `${c + 1}`;
    return `${heading}: ${value.replace(/\n/g, '\n  ')}`.trimEnd();
  }).join('\n')).join('\n\n');
}
const blockText = (item: EmailBlock, ctx: Ctx) => item.type === 'table' ? tableText(item, ctx) : flowText([item], ctx, '').join('\n\n');

export function renderEmailBody(doc: EmailBodyDoc, options: EmailRenderOptions): EmailRenderResult {
  const ctx: Ctx = { options, missing: [], fields: [], documents: [], images: new Map((options.images ?? []).map(item => [item.id, item])) };
  const body = doc.content.map(item => blockHtml(item, ctx)).join('');
  const text = doc.content.map(item => blockText(item, ctx)).join('\n\n');
  const html = sanitiseEmailHtml(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse"><tr><td style="${FONT}">${body}</td></tr></table>`);
  return { html, text, missing: ctx.missing, fields: ctx.fields, documents: ctx.documents };
}

// ------------------------------------------------------------------------------------------------- allowlist pass

const ATTRS: Record<string, readonly string[]> = {
  table: ['role', 'width', 'cellpadding', 'cellspacing', 'border', 'style'], tr: [], td: ['width', 'align', 'valign', 'style'], th: ['scope', 'width', 'align', 'valign', 'style'],
  p: ['style'], br: [], strong: [], em: [], u: [], ul: ['style'], ol: ['start', 'style'], li: ['style'],
  a: ['href', 'target', 'rel', 'style'], img: ['src', 'alt', 'width', 'style'],
};
const VALUE: Record<string, RegExp> = {
  href: /^(?:https?:\/\/[^\s"<>]+|mailto:[^\s"<>]+|\{\{document-link:[A-Za-z0-9_-]{1,100}\}\})$/i,
  src: /^cid:[A-Za-z0-9._@-]+$/, style: /^[a-z0-9\s:;%#.,()-]*$/i, role: /^presentation$/, target: /^_blank$/, rel: /^noopener noreferrer$/,
  width: /^\d{1,4}(?:\.\d{1,2})?%?$/, cellpadding: /^\d{1,2}$/, cellspacing: /^\d{1,2}$/, border: /^\d$/, align: /^(?:left|center|right)$/, valign: /^(?:top|middle|bottom)$/,
  scope: /^col$/, start: /^\d{1,5}$/, alt: /^[^"<>]*$/,
};
const VOID = new Set(['br', 'img']);
/**
 * Deterministic tag/attribute allowlist over HTML (no DOM needed). Tags off the list are dropped (their text stays),
 * attributes off the list or with a value outside its pattern are dropped, quotes must be double, styles may not
 * hold url()/expression(), and stray ">" in text is escaped. Run last on the renderer's own output.
 */
export function sanitiseEmailHtml(html: string): string {
  return html.split(/(<[^<>]*>)/g).map(part => {
    if (!part.startsWith('<')) return part.replace(/>/g, '&gt;').replace(/<|&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, character => character === '<' ? '&lt;' : '&amp;');
    const tag = part.match(/^<(\/?)([a-z][a-z0-9]*)\b([^>]*?)\/?>$/i);
    if (!tag) return '';
    const [, closing, rawName, rawAttrs] = tag, name = rawName.toLowerCase(), allowed = ATTRS[name];
    if (!allowed) return '';
    if (closing) return VOID.has(name) ? '' : `</${name}>`;
    const attrs = [...rawAttrs.matchAll(/\s([a-z-]+)="([^"]*)"/gi)].flatMap(([, rawKey, value]) => {
      const key = rawKey.toLowerCase();
      if (!allowed.includes(key)) return [];
      if (key === 'style' && /url\s*\(|expression|javascript|@import|behaviou?r/i.test(value)) return [];
      return VALUE[key] && !VALUE[key].test(value) ? [] : [` ${key}="${value}"`];
    });
    return `<${name}${attrs.join('')}>`;
  }).join('');
}
