import { describe, expect, it } from 'vitest';
import { createEmailBodyDocSchema, emailBodyDocSchema, emptyTableCells, normaliseWebLink, summariseEmailBody, validateEmailLink, type EmailBodyDoc, type EmailTable } from '../lib/email-body/doc';
import { editorJsonToEmailBody, emailBodyToEditorJson } from '../lib/email-body/editor-json';
import { truncateDocTables, truncateTableGrid, safePastedLink } from '../lib/email-body/paste';

const p = (text: string) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] });
const cell = (text: string, type: 'tableCell' | 'tableHeader' = 'tableCell') => ({ type, content: [text ? p(text) : { type: 'paragraph' as const }] });
const table = (rows: number, cols: number, headerRow = true): EmailTable => ({ type: 'table', attrs: { headerRow, widths: 'equal' },
  content: Array.from({ length: rows }, (_, r) => ({ type: 'tableRow' as const, content: Array.from({ length: cols }, (_, c) => cell(`r${r}c${c}`, headerRow && r === 0 ? 'tableHeader' : 'tableCell')) })) });
const doc = (...content: unknown[]) => ({ type: 'doc', content }) as EmailBodyDoc;
const link = (attrs: Record<string, unknown>) => doc({ type: 'paragraph', content: [{ type: 'text', text: 'Portal', marks: [{ type: 'link', attrs }] }] });
const ok = (value: unknown) => emailBodyDocSchema.safeParse(value).success;

describe('validateEmailLink', () => {
  it('adds https:// when no scheme is typed and keeps a typed scheme so it can be blocked', () => {
    expect(normaliseWebLink(' portal.example.test/start ')).toBe('https://portal.example.test/start');
    expect(normaliseWebLink('www.example.test:8443/x')).toBe('https://www.example.test:8443/x');
    expect(normaliseWebLink('//cdn.example.test')).toBe('https://cdn.example.test');
    expect(normaliseWebLink('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(validateEmailLink({ kind: 'web', href: 'portal.example.test' })).toEqual({ ok: true, kind: 'web', href: 'https://portal.example.test' });
  });
  it.each([
    ['javascript:alert(1)', 'scheme'], ['JaVaScRiPt:alert(1)', 'scheme'], ['data:text/html,<b>x</b>', 'scheme'], ['file:///etc/passwd', 'scheme'],
    ['vbscript:msgbox(1)', 'scheme'], ['ftp://files.example.test', 'scheme'], ['https://intranet portal.test', 'spaces'], ['java\tscript:alert(1)', 'spaces'],
    ['https://portal.example.test/{employee.name}', 'field'], ['{company.website}', 'field'], ['https://intranet', 'domain'], ['localhost:3000', 'domain'],
    ['https://10.0.0.1/admin', 'domain'], ['https://', 'domain'], ['https://user:secret@portal.example.test', 'credentials'],
    [`https://portal.example.test/${'a'.repeat(2000)}`, 'length'], ['', 'empty'],
  ])('blocks %s (%s)', (href, error) => expect(validateEmailLink({ kind: 'web', href })).toEqual({ ok: false, error }));
  it('accepts http with an insecure warning (the editor offers Apply anyway)', () => {
    expect(validateEmailLink({ kind: 'web', href: 'http://legacy.example.test/a?b=1#c' })).toEqual({ ok: true, kind: 'web', href: 'http://legacy.example.test/a?b=1#c', warning: 'insecure' });
  });
  it('requires a full email address for mailto', () => {
    expect(validateEmailLink({ kind: 'mailto', href: 'people.ops@example.test' })).toEqual({ ok: true, kind: 'mailto', href: 'mailto:people.ops@example.test' });
    expect(validateEmailLink({ kind: 'mailto', href: 'mailto:hr@example.test' })).toMatchObject({ ok: true, href: 'mailto:hr@example.test' });
    for (const href of ['hr@', 'hr@example', '@example.test', 'hr example@example.test', 'hr@@example.test', 'mailto:hr@example.test?subject=x', 'javascript:alert(1)', '{employee.email}'])
      expect(validateEmailLink({ kind: 'mailto', href }).ok, href).toBe(false);
  });
  it('requires a document link to name an allowed document', () => {
    expect(validateEmailLink({ kind: 'document', documentId: 'doc-1' }, { documentIds: ['doc-1'] })).toEqual({ ok: true, kind: 'document', documentId: 'doc-1' });
    expect(validateEmailLink({ kind: 'document', documentId: 'doc-2' }, { documentIds: ['doc-1'] })).toEqual({ ok: false, error: 'document' });
    expect(validateEmailLink({ kind: 'document', documentId: 'doc-1', href: 'https://example.test' })).toEqual({ ok: false, error: 'kind' });
    expect(validateEmailLink({ kind: 'script', href: 'https://example.test' })).toEqual({ ok: false, error: 'kind' });
  });
});

describe('emailBodyDocSchema (server trust boundary)', () => {
  it('accepts paragraphs, marks, fields, images, lists and a bounded table', () => {
    expect(ok(doc(
      { type: 'paragraph', content: [{ type: 'text', text: 'Dear ', marks: [{ type: 'bold' }] }, { type: 'field', attrs: { key: 'employee.name' } }, { type: 'hardBreak' }, { type: 'image', attrs: { assetId: 'img-1', alt: 'Logo' } }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p('One'), { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [p('Nested')] }] }] }] },
      table(30, 6),
    ))).toBe(true);
  });
  it('rejects scripts, unknown nodes, marks and attributes', () => {
    expect(ok(doc({ type: 'script', text: 'alert(1)' }))).toBe(false);
    expect(ok(doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { color: 'red' } }] }] }))).toBe(false);
    expect(ok(doc({ type: 'paragraph', attrs: { style: 'color:red' }, content: [{ type: 'text', text: 'x' }] }))).toBe(false);
    expect(ok(doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', onclick: 'alert(1)' }] }))).toBe(false);
    expect(ok(doc({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'x' }] }))).toBe(false);
    expect(ok(doc({ type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'img-1', alt: 'x', src: 'https://tracker.example.test/p.gif' } }] }))).toBe(false);
    expect(ok({ type: 'doc', content: [] })).toBe(false);
  });
  it.each([
    [{ kind: 'web', href: 'javascript:alert(1)' }], [{ kind: 'web', href: 'data:text/html,x' }], [{ kind: 'web', href: 'file:///c:/x' }], [{ kind: 'web', href: 'vbscript:x' }],
    [{ kind: 'web', href: 'https://a b.example.test' }], [{ kind: 'web', href: 'https://portal.example.test/{employee.empNo}' }], [{ kind: 'web', href: 'https://intranet' }],
    [{ kind: 'web', href: 'portal.example.test' }], [{ kind: 'web', href: `https://example.test/${'x'.repeat(2000)}` }], [{ kind: 'mailto', href: 'mailto:not-an-address' }],
    [{ kind: 'mailto', href: 'hr@example.test' }], [{ kind: 'document' }], [{ kind: 'web', href: 'https://example.test', documentId: 'd1' }], [{ kind: 'web', href: 'https://example.test', target: '_self' }],
  ])('rejects the link %j', attrs => expect(ok(link(attrs))).toBe(false));
  it('accepts http links (warning is an editor concern) and canonical mailto/document links', () => {
    expect(ok(link({ kind: 'web', href: 'http://legacy.example.test' }))).toBe(true);
    expect(ok(link({ kind: 'mailto', href: 'mailto:hr@example.test' }))).toBe(true);
    expect(ok(link({ kind: 'document', documentId: 'offer-letter' }))).toBe(true);
  });
  it('rejects oversize, ragged, nested and merged tables and two images in a cell', () => {
    expect(ok(doc(table(31, 2)))).toBe(false);
    expect(ok(doc(table(2, 7)))).toBe(false);
    const ragged = table(3, 3); ragged.content[2].content.pop();
    expect(ok(doc(ragged))).toBe(false);
    const nested = table(2, 2); (nested.content[1].content[0].content as unknown[]) = [table(2, 2)];
    expect(ok(doc(nested))).toBe(false);
    const listNested = table(2, 2); (listNested.content[1].content[0].content as unknown[]) = [{ type: 'bulletList', content: [{ type: 'listItem', content: [p('x'), table(1, 1, false)] }] }];
    expect(ok(doc(listNested))).toBe(false);
    for (const attrs of [{ colspan: 2 }, { rowspan: 2 }, { colwidth: [100] }]) {
      const merged = table(2, 2); (merged.content[1].content[0] as { attrs?: unknown }).attrs = attrs;
      expect(ok(doc(merged)), JSON.stringify(attrs)).toBe(false);
    }
    const images = table(2, 2); images.content[1].content[0].content = [{ type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'a', alt: 'A' } }] }, { type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'b', alt: 'B' } }] }];
    expect(ok(doc(images))).toBe(false);
    const one = table(2, 2); one.content[1].content[0].content = [{ type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'a', alt: 'A' } }] }];
    expect(ok(doc(one))).toBe(true);
    const misplacedHeader = table(2, 2); misplacedHeader.content[1].content[0].type = 'tableHeader';
    expect(ok(doc(misplacedHeader))).toBe(false);
    expect(ok(doc(table(2, 2, false)))).toBe(true);
    const claimsHeader = table(2, 2, false); claimsHeader.attrs.headerRow = true;
    expect(ok(doc(claimsHeader))).toBe(false);
  });
  it('enforces text and overall size limits', () => {
    expect(ok(doc(p('x'.repeat(20000))))).toBe(true);
    expect(ok(doc(p('x'.repeat(20001))))).toBe(false);
    expect(ok(doc(...Array.from({ length: 12 }, () => p('x'.repeat(19000)))))).toBe(false);
  });
  it('binds fields, sensitive keys, documents and images supplied by the caller', () => {
    const schema = createEmailBodyDocSchema({ fieldAllowed: key => key === 'employee.name' || key === 'employee.icNo', sensitive: key => key.endsWith('icNo'), documentIds: ['doc-1'], imageIds: ['img-1'] });
    const field = (key: string) => doc({ type: 'paragraph', content: [{ type: 'field', attrs: { key } }] });
    expect(schema.safeParse(field('employee.name')).success).toBe(true);
    expect(schema.safeParse(field('employee.salary')).success).toBe(false);
    const sensitive = schema.safeParse(field('employee.icNo'));
    expect(sensitive.success).toBe(false);
    expect(sensitive.error?.issues[0].message).toBe('Sensitive fields cannot be included in an email.');
    expect(schema.safeParse(link({ kind: 'document', documentId: 'doc-2' })).success).toBe(false);
    expect(schema.safeParse(doc({ type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'img-9', alt: 'x' } }] })).success).toBe(false);
    expect(emailBodyDocSchema.safeParse(field('{bad}')).success).toBe(false);
  });
});

describe('summaries, empty cells and the editor mapper', () => {
  const sample = doc(
    { type: 'paragraph', content: [
      { type: 'text', text: 'Open ', marks: [{ type: 'link', attrs: { kind: 'web', href: 'https://portal.example.test' } }] },
      { type: 'field', attrs: { key: 'company.name' }, marks: [{ type: 'bold' }, { type: 'link', attrs: { kind: 'web', href: 'https://portal.example.test' } }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'sign', marks: [{ type: 'link', attrs: { kind: 'document', documentId: 'nda' } }] },
    ] },
    { ...table(3, 2), content: [table(3, 2).content[0], { type: 'tableRow', content: [cell('IT'), cell('')] }, { type: 'tableRow', content: [cell(' '), { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'field', attrs: { key: 'email' } }] }] }] }] },
    { type: 'paragraph', content: [{ type: 'image', attrs: { assetId: 'img-1', alt: 'Logo' } }] },
  );
  it('counts link runs, tables, images and linked documents', () => {
    const summary = summariseEmailBody(sample);
    expect({ ...summary, documentLinks: [...summary.documentLinks] }).toEqual({ links: 2, tables: 1, images: 1, documentLinks: ['nda'] });
  });
  it('finds empty table cells in order for Show me', () => {
    expect(emptyTableCells(sample)).toEqual([{ table: 0, row: 1, column: 1 }, { table: 0, row: 2, column: 0 }]);
  });
  it('maps tiptap JSON to the schema and back, deriving the header row and dropping tiptap defaults', () => {
    const tiptap = { type: 'doc', content: [
      { type: 'paragraph', attrs: {}, content: [{ type: 'text', text: 'Hi', marks: [{ type: 'link', attrs: { kind: 'web', href: 'https://example.test', documentId: null } }] }, { type: 'hardBreak', marks: [{ type: 'bold' }] }] },
      { type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
      { type: 'table', attrs: { widths: 'equal' }, content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'System' }] }] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [{ type: 'paragraph' }] }] },
      ] },
    ] };
    const mapped = editorJsonToEmailBody(tiptap);
    expect(emailBodyDocSchema.parse(mapped)).toEqual(mapped);
    expect(mapped.content[2]).toEqual({ type: 'table', attrs: { headerRow: true, widths: 'equal' }, content: [{ type: 'tableRow', content: [cell('System', 'tableHeader')] }, { type: 'tableRow', content: [cell('')] }] });
    expect(mapped.content[1]).toEqual({ type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] });
    expect(editorJsonToEmailBody(emailBodyToEditorJson(mapped))).toEqual(mapped);
    const merged = editorJsonToEmailBody({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 1 }, content: [{ type: 'paragraph' }] }] }] }] });
    expect(emailBodyDocSchema.safeParse(merged).success).toBe(false);
  });
});

describe('paste policy (server-safe)', () => {
  it('truncates grids and docs to 6 x 30 with a flag', () => {
    const grid = Array.from({ length: 40 }, (_, r) => Array.from({ length: 8 }, (_, c) => `${r}:${c}`));
    const cut = truncateTableGrid(grid);
    expect(cut.truncated).toBe(true);
    expect(cut.rows.length).toBe(30);
    expect(cut.rows.every(row => row.length === 6)).toBe(true);
    expect(cut.rows[29][5]).toBe('29:5');
    expect(truncateTableGrid([[1, 2]]).truncated).toBe(false);
    const big = truncateDocTables(doc({ ...table(35, 6) }));
    expect(big.truncated).toBe(true);
    expect(ok(big.doc)).toBe(true);
  });
  it('keeps only safe pasted links', () => {
    expect(safePastedLink('https://portal.example.test/a')).toEqual({ kind: 'web', href: 'https://portal.example.test/a' });
    expect(safePastedLink('mailto:hr@example.test')).toEqual({ kind: 'mailto', href: 'mailto:hr@example.test' });
    for (const href of ['javascript:alert(1)', '/relative', 'file:///x', 'portal.example.test', '#top', 'https://intranet']) expect(safePastedLink(href), href).toBeNull();
  });
});
