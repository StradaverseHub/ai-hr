import { z } from 'zod';

/**
 * EmailBodyDoc — the structured email body (board 6bdda222). Our own JSON schema; node and mark names match the
 * tiptap editor so the client maps it with attribute clean-up only (lib/email-body/editor-json.ts).
 *
 * The schema built by createEmailBodyDocSchema is the SERVER TRUST BOUNDARY for saved bodies: unknown node types,
 * marks and attributes are rejected (strict objects), tables are bounded, cells hold no tables and at most one image,
 * merged cells are refused and every link is re-validated. Pure: no React, tiptap or DOM (docs/SCALE-AND-RELEASE-RULES.md rule 7).
 */
export type EmailLinkKind = 'web' | 'mailto' | 'document';
export type EmailLinkAttrs = { kind: EmailLinkKind; href?: string; documentId?: string };
export type EmailMark = { type: 'bold' } | { type: 'italic' } | { type: 'underline' } | { type: 'link'; attrs: EmailLinkAttrs };
export type EmailTextNode = { type: 'text'; text: string; marks?: EmailMark[] };
export type EmailHardBreak = { type: 'hardBreak' };
export type EmailFieldNode = { type: 'field'; attrs: { key: string }; marks?: EmailMark[] };
export type EmailImageNode = { type: 'image'; attrs: { assetId: string; alt: string } };
export type EmailInline = EmailTextNode | EmailHardBreak | EmailFieldNode | EmailImageNode;
export type EmailParagraph = { type: 'paragraph'; content?: EmailInline[] };
export type EmailListItem = { type: 'listItem'; content: EmailFlowBlock[] };
export type EmailBulletList = { type: 'bulletList'; content: EmailListItem[] };
export type EmailOrderedList = { type: 'orderedList'; attrs?: { start?: number }; content: EmailListItem[] };
/** Blocks allowed inside list items and table cells: everything except tables. */
export type EmailFlowBlock = EmailParagraph | EmailBulletList | EmailOrderedList;
export type EmailTableCell = { type: 'tableCell' | 'tableHeader'; attrs?: { colspan?: 1; rowspan?: 1 }; content: EmailFlowBlock[] };
export type EmailTableRow = { type: 'tableRow'; content: EmailTableCell[] };
export type EmailTableWidths = 'fit' | 'equal';
export type EmailTable = { type: 'table'; attrs: { headerRow: boolean; widths: EmailTableWidths }; content: EmailTableRow[] };
export type EmailBlock = EmailFlowBlock | EmailTable;
export type EmailBodyDoc = { type: 'doc'; content: EmailBlock[] };

export const EMAIL_TABLE_MAX_COLUMNS = 6;
export const EMAIL_TABLE_MAX_ROWS = 30;
/** Columns from which the editor warns that the table is hard to read on phones. */
export const EMAIL_TABLE_WARN_COLUMNS = 5;
export const EMAIL_BODY_MAX_JSON_BYTES = 200_000;
export const EMAIL_BODY_MAX_TEXT_LENGTH = 20_000;
export const EMAIL_BODY_MAX_NODES = 10_000;
export const EMAIL_LINK_MAX_LENGTH = 2000;
export const EMAIL_IMAGE_ALT_MAX = 300;
/** Same grammar as lib/lifecycle-v9-model.ts merge(): {employee.name}, {joiner.joinDate}, {company.name}. */
export const EMAIL_FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?$/;
export const EMAIL_ID = /^[A-Za-z0-9_-]{1,100}$/;

export const emptyEmailBodyDoc = (): EmailBodyDoc => ({ type: 'doc', content: [{ type: 'paragraph' }] });

// ---------------------------------------------------------------------------------------------- link validation

export type EmailLinkError = 'empty' | 'length' | 'spaces' | 'field' | 'scheme' | 'domain' | 'credentials' | 'email' | 'document' | 'kind';
export type EmailLinkResult =
  | { ok: true; kind: EmailLinkKind; href?: string; documentId?: string; warning?: 'insecure' }
  | { ok: false; error: EmailLinkError };
export type EmailLinkOptions = {
  /** Documents this email may link to. When given, a document link must name one of them. */
  documentIds?: Iterable<string>;
  /** Default true: the user typed it, so a missing scheme becomes https://. The schema passes false (stored hrefs are canonical). */
  normalise?: boolean;
};

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** Adds https:// when the user typed no scheme ("example.com/x", "www.example.com:8080"). A typed scheme is kept so it can be blocked. */
export function normaliseWebLink(input: string): string {
  const value = input.trim();
  if (!value) return value;
  if (value.startsWith('//')) return `https:${value}`;
  const scheme = value.match(SCHEME);
  if (scheme && !scheme[1].includes('.') && !/^\d+$/.test(value.slice(scheme[0].length).split(/[/?#]/)[0] ?? '')) return value;
  return `https://${value}`;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
/** A full public-looking domain: at least two labels and an alphabetic (or punycode) top-level label. No IP literals. */
export function isFullDomain(host: string): boolean {
  if (!host || host.length > 253) return false;
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.length < 2 || !labels.every(label => LABEL.test(label))) return false;
  const top = labels.at(-1)!;
  return /^[a-z]{2,63}$/i.test(top) || /^xn--[a-z0-9-]{2,59}$/i.test(top);
}

const EMAIL_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`|~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`|~-]+)*$/;
export function isEmailAddress(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.lastIndexOf('@');
  if (at < 1) return false;
  const local = value.slice(0, at), domain = value.slice(at + 1);
  return local.length <= 64 && EMAIL_LOCAL.test(local) && isFullDomain(domain);
}

/** One rule set for the editor link panel and the server schema. http is valid but carries warning 'insecure' ("Apply anyway"). */
export function validateEmailLink(input: { kind: EmailLinkKind | string; href?: string | null; documentId?: string | null }, options: EmailLinkOptions = {}): EmailLinkResult {
  const normalise = options.normalise ?? true;
  if (input.kind === 'document') {
    const id = input.documentId ?? '';
    if (input.href) return { ok: false, error: 'kind' };
    if (!EMAIL_ID.test(id)) return { ok: false, error: 'document' };
    if (options.documentIds && !new Set(options.documentIds).has(id)) return { ok: false, error: 'document' };
    return { ok: true, kind: 'document', documentId: id };
  }
  if (input.kind !== 'web' && input.kind !== 'mailto') return { ok: false, error: 'kind' };
  if (input.documentId) return { ok: false, error: 'kind' };
  const raw = normalise ? (input.href ?? '').trim() : input.href ?? '';
  if (!raw) return { ok: false, error: 'empty' };
  if (raw.length > EMAIL_LINK_MAX_LENGTH) return { ok: false, error: 'length' };
  // Whitespace and control characters first: "java\tscript:" and "https://a b.com" are both refused here.
  if (/[\s\u0000-\u001f\u007f-\u009f\u00a0\u2000-\u200f\u2028\u2029\ufeff]/.test(raw)) return { ok: false, error: 'spaces' };
  if (/[{}]/.test(raw)) return { ok: false, error: 'field' };
  if (input.kind === 'mailto') {
    const address = raw.replace(/^mailto:/i, '');
    if (SCHEME.test(address) && !address.includes('@')) return { ok: false, error: 'scheme' };
    if (!isEmailAddress(address)) return { ok: false, error: 'email' };
    const href = `mailto:${address}`;
    if (!normalise && raw !== href) return { ok: false, error: 'email' };
    return { ok: true, kind: 'mailto', href };
  }
  const href = normalise ? normaliseWebLink(raw) : raw;
  if (href.length > EMAIL_LINK_MAX_LENGTH) return { ok: false, error: 'length' };
  const scheme = href.match(SCHEME)?.[1]?.toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return { ok: false, error: 'scheme' };
  if (!/^https?:\/\/[^/]/i.test(href)) return { ok: false, error: 'domain' };
  let url: URL;
  try { url = new URL(href); } catch { return { ok: false, error: 'domain' }; }
  if (url.username || url.password) return { ok: false, error: 'credentials' };
  if (!isFullDomain(url.hostname)) return { ok: false, error: 'domain' };
  return scheme === 'http' ? { ok: true, kind: 'web', href, warning: 'insecure' } : { ok: true, kind: 'web', href };
}

// ---------------------------------------------------------------------------------------------- structural schema

const linkAttrs = z.strictObject({ kind: z.enum(['web', 'mailto', 'document']), href: z.string().max(EMAIL_LINK_MAX_LENGTH).optional(), documentId: z.string().max(100).optional() });
const mark: z.ZodType<EmailMark> = z.union([
  z.strictObject({ type: z.literal('bold') }), z.strictObject({ type: z.literal('italic') }), z.strictObject({ type: z.literal('underline') }),
  z.strictObject({ type: z.literal('link'), attrs: linkAttrs }),
]);
const marks = z.array(mark).max(4).optional();
const inline: z.ZodType<EmailInline> = z.union([
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(EMAIL_BODY_MAX_TEXT_LENGTH), marks }),
  z.strictObject({ type: z.literal('hardBreak') }),
  z.strictObject({ type: z.literal('field'), attrs: z.strictObject({ key: z.string().regex(EMAIL_FIELD_KEY).max(100) }), marks }),
  z.strictObject({ type: z.literal('image'), attrs: z.strictObject({ assetId: z.string().regex(EMAIL_ID), alt: z.string().max(EMAIL_IMAGE_ALT_MAX) }) }),
]);
const paragraph: z.ZodType<EmailParagraph> = z.strictObject({ type: z.literal('paragraph'), content: z.array(inline).optional() });
const listItem: z.ZodType<EmailListItem> = z.lazy(() => z.strictObject({ type: z.literal('listItem'), content: z.array(flow).min(1) }));
const bulletList: z.ZodType<EmailBulletList> = z.lazy(() => z.strictObject({ type: z.literal('bulletList'), content: z.array(listItem).min(1) }));
const orderedList: z.ZodType<EmailOrderedList> = z.lazy(() => z.strictObject({ type: z.literal('orderedList'), attrs: z.strictObject({ start: z.number().int().min(0).max(10000).optional() }).optional(), content: z.array(listItem).min(1) }));
const flow: z.ZodType<EmailFlowBlock> = z.lazy(() => z.union([paragraph, bulletList, orderedList]));
// Merged cells: colspan/rowspan may only be absent or 1. Cells hold flow blocks only, so a nested table is a type error.
const cell: z.ZodType<EmailTableCell> = z.strictObject({ type: z.enum(['tableCell', 'tableHeader']), attrs: z.strictObject({ colspan: z.literal(1).optional(), rowspan: z.literal(1).optional() }).optional(), content: z.array(flow).min(1) });
const row: z.ZodType<EmailTableRow> = z.strictObject({ type: z.literal('tableRow'), content: z.array(cell).min(1).max(EMAIL_TABLE_MAX_COLUMNS) });
const table: z.ZodType<EmailTable> = z.strictObject({ type: z.literal('table'), attrs: z.strictObject({ headerRow: z.boolean(), widths: z.enum(['fit', 'equal']) }), content: z.array(row).min(1).max(EMAIL_TABLE_MAX_ROWS) });
const block: z.ZodType<EmailBlock> = z.union([paragraph, bulletList, orderedList, table]);

export type EmailBodyDocOptions = EmailLinkOptions & {
  /** Field keys the caller allows (e.g. the lifecycle field registry). Unknown keys are rejected when given. */
  fieldAllowed?: (key: string) => boolean;
  /** Sensitive keys (identity, tax, banking) are rejected. Supplied by the caller; nothing is hard-coded here. */
  sensitive?: (key: string) => boolean;
  /** Uploaded image ids of this template. When given, an image node must reference one of them. */
  imageIds?: Iterable<string>;
  maxBytes?: number;
};

const byteLength = (value: string) => new TextEncoder().encode(value).length;
type Issue = { message: string; path: (string | number)[] };

/** Walks a structurally valid doc and returns every contextual problem. Exported so the editor's save checks reuse it. */
export function emailBodyDocIssues(doc: EmailBodyDoc, options: EmailBodyDocOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const documentIds = options.documentIds ? new Set(options.documentIds) : undefined;
  const imageIds = options.imageIds ? new Set(options.imageIds) : undefined;
  let nodes = 0;
  const size = byteLength(JSON.stringify(doc));
  if (size > (options.maxBytes ?? EMAIL_BODY_MAX_JSON_BYTES)) issues.push({ message: 'The email body is too large.', path: [] });
  const checkMarks = (list: EmailMark[] | undefined, path: (string | number)[]) => {
    const seen = new Set<string>();
    for (const [index, item] of (list ?? []).entries()) {
      if (seen.has(item.type)) issues.push({ message: 'A mark is repeated.', path: [...path, 'marks', index] });
      seen.add(item.type);
      if (item.type !== 'link') continue;
      // Stored hrefs are canonical: no normalisation, so "example.com" saved without https:// is refused.
      const result = validateEmailLink(item.attrs, { documentIds, normalise: false });
      if (!result.ok) issues.push({ message: `Invalid link (${result.error}).`, path: [...path, 'marks', index] });
    }
  };
  const countImages = (blocks: EmailFlowBlock[]): number => blocks.reduce((sum, item) => sum + (item.type === 'paragraph'
    ? (item.content ?? []).filter(node => node.type === 'image').length
    : item.content.reduce((total, li) => total + countImages(li.content), 0)), 0);
  const walkInline = (list: EmailInline[], path: (string | number)[]) => list.forEach((node, index) => {
    nodes++;
    const here = [...path, index];
    if (node.type === 'text') checkMarks(node.marks, here);
    if (node.type === 'field') {
      checkMarks(node.marks, here);
      if (options.sensitive?.(node.attrs.key)) issues.push({ message: 'Sensitive fields cannot be included in an email.', path: here });
      else if (options.fieldAllowed && !options.fieldAllowed(node.attrs.key)) issues.push({ message: `Unknown field ${node.attrs.key}.`, path: here });
    }
    if (node.type === 'image' && imageIds && !imageIds.has(node.attrs.assetId)) issues.push({ message: 'The image is not one of the uploaded images.', path: here });
  });
  const walkBlock = (item: EmailFlowBlock, here: (string | number)[]) => {
    nodes++;
    if (item.type === 'paragraph') return walkInline(item.content ?? [], [...here, 'content']);
    item.content.forEach((li, liIndex) => {
      nodes++;
      if (li.content[0]?.type !== 'paragraph') issues.push({ message: 'A list item must start with a paragraph.', path: [...here, 'content', liIndex] });
      walkFlow(li.content, [...here, 'content', liIndex, 'content']);
    });
  };
  const walkFlow = (list: EmailFlowBlock[], path: (string | number)[]) => list.forEach((item, index) => walkBlock(item, [...path, index]));
  doc.content.forEach((item, index) => {
    if (item.type !== 'table') return walkBlock(item, ['content', index]);
    nodes++;
    const width = item.content[0]?.content.length ?? 0;
    item.content.forEach((tr, r) => {
      nodes++;
      if (tr.content.length !== width) issues.push({ message: 'Every table row needs the same number of cells.', path: ['content', index, 'content', r] });
      tr.content.forEach((td, c) => {
        const here = ['content', index, 'content', r, 'content', c];
        const header = td.type === 'tableHeader';
        if (header !== (item.attrs.headerRow && r === 0)) issues.push({ message: 'Header cells belong only in the header row.', path: here });
        if (countImages(td.content) > 1) issues.push({ message: 'A table cell can hold one image.', path: here });
        walkFlow(td.content, [...here, 'content']);
      });
    });
  });
  if (nodes > EMAIL_BODY_MAX_NODES) issues.push({ message: 'The email body has too many elements.', path: [] });
  return issues;
}

/** Strict schema, optionally bound to the caller's registry (fields, documents, images). */
export function createEmailBodyDocSchema(options: EmailBodyDocOptions = {}): z.ZodType<EmailBodyDoc> {
  return z.strictObject({ type: z.literal('doc'), content: z.array(block).min(1) }).superRefine((doc, ctx) => {
    for (const issue of emailBodyDocIssues(doc as EmailBodyDoc, options)) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  }) as z.ZodType<EmailBodyDoc>;
}
/** Context-free schema: structure, limits and link syntax. Use createEmailBodyDocSchema to bind fields/documents/images. */
export const emailBodyDocSchema = createEmailBodyDocSchema();

// ---------------------------------------------------------------------------------------------- walkers and summaries

export type EmailTableCellLocation = { table: number; row: number; column: number };
const inlineOf = (blocks: EmailFlowBlock[]): EmailInline[] => blocks.flatMap(item => item.type === 'paragraph' ? item.content ?? [] : item.content.flatMap(li => inlineOf(li.content)));
const allInline = (doc: EmailBodyDoc): EmailInline[] => doc.content.flatMap(item => item.type === 'table'
  ? item.content.flatMap(tr => tr.content.flatMap(td => inlineOf(td.content))) : inlineOf([item]));

/** Every empty table cell in document order (the first one is the "Show me" target). table = index among tables. */
export function emptyTableCells(doc: EmailBodyDoc): EmailTableCellLocation[] {
  const result: EmailTableCellLocation[] = [];
  doc.content.filter((item): item is EmailTable => item.type === 'table').forEach((item, t) => item.content.forEach((tr, r) => tr.content.forEach((td, c) => {
    const filled = inlineOf(td.content).some(node => node.type === 'field' || node.type === 'image' || (node.type === 'text' && node.text.trim() !== ''));
    if (!filled) result.push({ table: t, row: r, column: c });
  })));
  return result;
}

const linkOf = (node: EmailInline) => node.type === 'text' || node.type === 'field' ? node.marks?.find((item): item is Extract<EmailMark, { type: 'link' }> => item.type === 'link') : undefined;
export const sameLink = (a?: EmailLinkAttrs, b?: EmailLinkAttrs) => !!a && !!b && a.kind === b.kind && a.href === b.href && a.documentId === b.documentId;

/** Counts for the template list ("2 links · 1 table") and the documents untick rule. A link = one run of adjacent linked nodes. */
export function summariseEmailBody(doc: EmailBodyDoc): { links: number; tables: number; images: number; documentLinks: Set<string> } {
  let links = 0;
  const documentLinks = new Set<string>();
  const runs = (list: EmailInline[]) => { let previous: EmailLinkAttrs | undefined; for (const node of list) { const link = linkOf(node)?.attrs; if (link && !sameLink(previous, link)) { links++; if (link.kind === 'document' && link.documentId) documentLinks.add(link.documentId); } previous = link; } };
  const paragraphs = (blocks: EmailFlowBlock[]) => blocks.forEach(item => item.type === 'paragraph' ? runs(item.content ?? []) : item.content.forEach(li => paragraphs(li.content)));
  doc.content.forEach(item => item.type === 'table' ? item.content.forEach(tr => tr.content.forEach(td => paragraphs(td.content))) : paragraphs([item]));
  return { links, tables: doc.content.filter(item => item.type === 'table').length, images: allInline(doc).filter(node => node.type === 'image').length, documentLinks };
}

/** Field keys used anywhere (text, cells, link text), unique, in document order. */
export const emailBodyFieldKeys = (doc: EmailBodyDoc) => [...new Set(allInline(doc).flatMap(node => node.type === 'field' ? [node.attrs.key] : []))];
/** Uploaded image ids used anywhere, unique, in document order. */
export const emailBodyImageIds = (doc: EmailBodyDoc) => [...new Set(allInline(doc).flatMap(node => node.type === 'image' ? [node.attrs.assetId] : []))];
