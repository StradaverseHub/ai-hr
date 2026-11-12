import { describe, expect, it } from 'vitest';
import type { EmailBodyDoc, EmailInline, EmailMark } from '../lib/email-body/doc';
import { documentLinkIds, documentLinkToken, emailHtmlBytes, emailHtmlNearLimit, renderEmailBody, resolveDocumentLinks, sanitiseEmailHtml, type EmailRenderOptions } from '../lib/email-body/render';

const text = (value: string, ...marks: EmailMark[]): EmailInline => marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const field = (key: string, ...marks: EmailMark[]): EmailInline => marks.length ? { type: 'field', attrs: { key }, marks } : { type: 'field', attrs: { key } };
const web = (href: string): EmailMark => ({ type: 'link', attrs: { kind: 'web', href } });
const para = (...content: EmailInline[]) => ({ type: 'paragraph' as const, content });
const doc = (...content: EmailBodyDoc['content']): EmailBodyDoc => ({ type: 'doc', content });
const labels: Record<string, string> = { 'employee.name': 'Full name', 'employee.position': 'Position', email: 'Work email' };
const base: EmailRenderOptions = { values: { 'employee.name': 'Aria Fenwick', 'company.name': 'Northwind Fixture' }, missingLabel: key => labels[key],
  images: [{ id: 'img-1', alt: 'Northwind logo', cid: 'v9-image.img-1@aihr' }], documentLink: id => id === 'nda' ? { name: 'Confidentiality agreement' } : null };
const inner = (html: string) => html.replace(/^<table role="presentation"[^>]*><tr><td style="[^"]*">/, '').replace(/<\/td><\/tr><\/table>$/, '');

describe('renderEmailBody', () => {
  it('renders paragraphs, breaks and marks as inline-styled HTML and plain text', () => {
    const result = renderEmailBody(doc(para(text('Dear '), field('employee.name', { type: 'bold' }), text(',')), para(text('Line one'), { type: 'hardBreak' }, text('two', { type: 'italic' }, { type: 'underline' })), { type: 'paragraph' }), base);
    expect(result.html).toMatch(/^<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse"><tr><td style="font-family:Arial,Helvetica,sans-serif;[^"]*">/);
    expect(inner(result.html)).toBe('<p style="margin:0 0 12px 0">Dear <strong>Aria Fenwick</strong>,</p><p style="margin:0 0 12px 0">Line one<br><em><u>two</u></em></p><p style="margin:0 0 12px 0">&#160;</p>');
    expect(result.text).toBe('Dear Aria Fenwick,\n\nLine one\ntwo\n\n');
    expect(result.fields).toEqual(['employee.name']);
    expect(result.missing).toEqual([]);
  });
  it('escapes hostile field values per text node: markup, entities and token injection stay literal', () => {
    const values = { 'employee.name': '<img src=x onerror=alert(1)> & "Co" \'x\'', 'employee.position': '{image:img-1} {employee.icNo} {{document-link:nda}}' };
    const result = renderEmailBody(doc(para(field('employee.name'), text(' / '), field('employee.position'))), { ...base, values, sensitive: key => key === 'employee.icNo' });
    expect(inner(result.html)).toBe('<p style="margin:0 0 12px 0">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot; &#39;x&#39; / &#123;image:img-1&#125; &#123;employee.icNo&#125; &#123;&#123;document-link:nda&#125;&#125;</p>');
    expect(result.html).not.toContain('<img');
    expect(result.text).toBe(`${values['employee.name']} / ${values['employee.position']}`);
    expect(result.fields).toEqual(['employee.name', 'employee.position']);
    expect(documentLinkIds(result.html)).toEqual([]);
    expect(resolveDocumentLinks(result.html, result.text, { nda: 'https://hr.example.test/d/1' }).html).toBe(result.html);
  });
  it('escapes typed text the same way and keeps leading and repeated spaces visible', () => {
    const result = renderEmailBody(doc(para(text('  a <b> & {employee.name}  b'))), base);
    expect(inner(result.html)).toBe('<p style="margin:0 0 12px 0">&#160; a &lt;b&gt; &amp; &#123;employee.name&#125;&#160; b</p>');
    expect(result.fields).toEqual([]);
  });
  it('renders links with target, rel and wrapping styles; plain text shows "text (address)"', () => {
    const result = renderEmailBody(doc(para(
      text('Open the '), text('portal for ', web('https://portal.example.test/start?a=1&b=2')), field('company.name', web('https://portal.example.test/start?a=1&b=2'), { type: 'bold' }),
      text(', mail '), text('HR', { type: 'link', attrs: { kind: 'mailto', href: 'mailto:hr@example.test' } }),
      text(' or '), text('portal.example.test', web('https://portal.example.test')),
    )), base);
    expect(inner(result.html)).toBe('<p style="margin:0 0 12px 0">Open the <a href="https://portal.example.test/start?a=1&amp;b=2" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;word-break:break-word;overflow-wrap:anywhere">portal for <strong>Northwind Fixture</strong></a>, mail <a href="mailto:hr@example.test" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;word-break:break-word;overflow-wrap:anywhere">HR</a> or <a href="https://portal.example.test" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;word-break:break-word;overflow-wrap:anywhere">portal.example.test</a></p>');
    expect(result.text).toBe('Open the portal for Northwind Fixture (https://portal.example.test/start?a=1&b=2), mail HR (hr@example.test) or https://portal.example.test');
  });
  it('renders document links as tokens resolved per person; text says the personal link is below', () => {
    const result = renderEmailBody(doc(para(text('Please '), text('sign the agreement', { type: 'link', attrs: { kind: 'document', documentId: 'nda' } }), text('.'))), base);
    expect(result.html).toContain(`<a href="${documentLinkToken('nda')}" target="_blank" rel="noopener noreferrer"`);
    expect(result.text).toBe('Please sign the agreement (personal link below).');
    expect(result.documents).toEqual(['nda']);
    expect(documentLinkIds(result.html)).toEqual(['nda']);
    const resolved = resolveDocumentLinks(result.html, result.text, new Map([['nda', 'https://hr.example.test/sign?t=abc&x=1']]));
    expect(resolved.html).toContain('<a href="https://hr.example.test/sign?t=abc&amp;x=1" target="_blank"');
    expect(resolved.html).not.toContain('document-link');
    expect(resolved.text).toBe(result.text);
    expect(() => resolveDocumentLinks(result.html, result.text, {})).toThrow('A document link is unavailable');
    expect(() => resolveDocumentLinks(result.html, result.text, { nda: 'javascript:alert(1)' })).toThrow('A document link is unavailable');
    expect(() => renderEmailBody(doc(para(text('x', { type: 'link', attrs: { kind: 'document', documentId: 'gone' } }))), base)).toThrow('A linked document is unavailable');
    expect(renderEmailBody(doc(para(text('x', { type: 'link', attrs: { kind: 'document', documentId: 'nda' } }))), { ...base, textLabels: { personalLinkBelow: 'lien personnel ci-dessous' } }).text).toBe('x (lien personnel ci-dessous)');
  });
  it('refuses to render an invalid stored link', () => {
    expect(() => renderEmailBody(doc(para(text('x', web('javascript:alert(1)')))), base)).toThrow('A link in the email body is invalid');
  });
  it('renders CID images with alt text and the 64 px cap in cells; text shows [Image: alt]', () => {
    const result = renderEmailBody(doc(para(text('Logo '), { type: 'image', attrs: { assetId: 'img-1', alt: 'old name.png' } })), base);
    expect(inner(result.html)).toBe('<p style="margin:0 0 12px 0">Logo <img src="cid:v9-image.img-1@aihr" alt="Northwind logo" style="display:inline-block;max-width:100%;height:auto;border:0"></p>');
    expect(result.text).toBe('Logo [Image: Northwind logo]');
    expect(() => renderEmailBody(doc(para({ type: 'image', attrs: { assetId: 'img-9', alt: 'x' } })), base)).toThrow('An inline image is unavailable');
  });
  it('renders a header-row table as th/td with equal % widths; text rows become "Heading: value"', () => {
    const row = (type: 'tableHeader' | 'tableCell', ...cells: EmailInline[][]) => ({ type: 'tableRow' as const, content: cells.map(content => ({ type, content: [para(...content)] })) });
    const result = renderEmailBody(doc({ type: 'table', attrs: { headerRow: true, widths: 'equal' }, content: [
      row('tableHeader', [text('System')], [text('Access')], [text('Owner')]),
      row('tableCell', [text('Payroll', { type: 'bold' })], [text('Read')], [field('employee.position')]),
      row('tableCell', [text('Portal', web('https://portal.example.test'))], [text('Full'), { type: 'hardBreak' }, text('Admin')], [{ type: 'image', attrs: { assetId: 'img-1', alt: 'x' } }]),
    ] }), { ...base, readableMissing: true });
    const cell = 'padding:6px 8px;border:1px solid #d1d5db;vertical-align:top;text-align:left;word-break:break-word;overflow-wrap:anywhere;width:33.33%';
    expect(inner(result.html)).toBe('<table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 12px 0">'
      + `<tr><th scope="col" width="33.33%" align="left" valign="top" style="${cell};background:#f3f4f6;font-weight:bold"><p style="margin:0">System</p></th><th scope="col" width="33.33%" align="left" valign="top" style="${cell};background:#f3f4f6;font-weight:bold"><p style="margin:0">Access</p></th><th scope="col" width="33.33%" align="left" valign="top" style="${cell};background:#f3f4f6;font-weight:bold"><p style="margin:0">Owner</p></th></tr>`
      + `<tr><td width="33.33%" align="left" valign="top" style="${cell}"><p style="margin:0"><strong>Payroll</strong></p></td><td width="33.33%" align="left" valign="top" style="${cell}"><p style="margin:0">Read</p></td><td width="33.33%" align="left" valign="top" style="${cell}"><p style="margin:0">[Position]</p></td></tr>`
      + `<tr><td width="33.33%" align="left" valign="top" style="${cell}"><p style="margin:0"><a href="https://portal.example.test" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8;text-decoration:underline;word-break:break-word;overflow-wrap:anywhere">Portal</a></p></td><td width="33.33%" align="left" valign="top" style="${cell}"><p style="margin:0">Full<br>Admin</p></td><td width="33.33%" align="left" valign="top" style="${cell}"><p style="margin:0"><img src="cid:v9-image.img-1@aihr" alt="Northwind logo" width="64" style="display:inline-block;width:64px;max-width:64px;height:auto;border:0"></p></td></tr>`
      + '</table>');
    expect(result.text).toBe('System: Payroll\nAccess: Read\nOwner: [Position]\n\nSystem: Portal (https://portal.example.test)\nAccess: Full\n  Admin\nOwner: [Image: Northwind logo]');
    expect(result.missing).toEqual(['employee.position']);
  });
  it('renders a fit-width table without a header row; text joins cells', () => {
    const result = renderEmailBody(doc({ type: 'table', attrs: { headerRow: false, widths: 'fit' }, content: [
      { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('A'))] }, { type: 'tableCell', content: [para(text('B'))] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('C'))] }, { type: 'tableCell', content: [{ type: 'paragraph' }] }] },
    ] }), base);
    expect(inner(result.html)).toMatch(/^<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:100%;margin:0 0 12px 0"><tr><td align="left" valign="top" style="padding:6px 8px;[^"]*overflow-wrap:anywhere">/);
    expect(result.html).not.toContain('width="50%"');
    expect(result.text).toBe('A | B\nC | ');
  });
  it('renders lists as ul/ol with inline styles and "- " / "1. " text lines', () => {
    const li = (...content: EmailBodyDoc['content']) => ({ type: 'listItem' as const, content: content as never });
    const result = renderEmailBody(doc(
      { type: 'bulletList', content: [li(para(text('Laptop'))), li(para(text('Badge')), { type: 'orderedList', content: [li(para(text('Photo'))), li(para(text('Sign')))] })] },
      { type: 'orderedList', attrs: { start: 3 }, content: [li(para(text('Third')))] },
    ), base);
    expect(inner(result.html)).toBe('<ul style="margin:0 0 12px 0;padding:0 0 0 24px"><li style="margin:0 0 4px 0"><p style="margin:0">Laptop</p></li><li style="margin:0 0 4px 0"><p style="margin:0 0 6px 0">Badge</p><ol style="margin:0 0 6px 0;padding:0 0 0 24px"><li style="margin:0 0 4px 0"><p style="margin:0">Photo</p></li><li style="margin:0 0 4px 0"><p style="margin:0">Sign</p></li></ol></li></ul><ol start="3" style="margin:0 0 12px 0;padding:0 0 0 24px"><li style="margin:0 0 4px 0"><p style="margin:0">Third</p></li></ol>');
    expect(result.text).toBe('- Laptop\n- Badge\n  1. Photo\n  2. Sign\n\n3. Third');
  });
  it('lists missing values from text, table cells and link text, bracketed like merge()', () => {
    const d = doc(
      para(text('Hi '), field('employee.name'), text(' see '), field('email', web('https://portal.example.test'))),
      { type: 'table', attrs: { headerRow: false, widths: 'fit' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(field('employee.position'), field('custom.code'))] }] }] },
    );
    const raw = renderEmailBody(d, { ...base, values: {} });
    expect(raw.missing).toEqual(['employee.name', 'email', 'employee.position', 'custom.code']);
    expect(raw.text).toBe('Hi [employee.name] see [email] (https://portal.example.test)\n\n[employee.position][custom.code]');
    const readable = renderEmailBody(d, { ...base, values: { 'employee.name': '' }, readableMissing: true });
    expect(readable.text).toBe('Hi [Full name] see [Work email] (https://portal.example.test)\n\n[Position][custom.code]');
  });
  it('throws on a sensitive key wherever it appears, mirroring merge()', () => {
    const inCell = doc({ type: 'table', attrs: { headerRow: false, widths: 'fit' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [para(field('employee.icNo', web('https://example.test')))] }] }] });
    expect(() => renderEmailBody(inCell, { ...base, sensitive: key => key.endsWith('icNo') })).toThrow('Sensitive fields cannot be included in an email.');
  });
  it('measures HTML bytes for the 100 KB warning', () => {
    expect(emailHtmlBytes('é')).toBe(2);
    expect(emailHtmlNearLimit('x'.repeat(99_999))).toBe(false);
    expect(emailHtmlNearLimit('x'.repeat(100_000))).toBe(true);
  });
});

describe('sanitiseEmailHtml allowlist pass', () => {
  it('keeps the renderer vocabulary unchanged', () => {
    const html = '<p style="margin:0">A <a href="https://a.example.test/x?y=1&amp;z=2" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8">b</a><br><img src="cid:v9-image.a@aihr" alt="A &amp; B" width="64" style="width:64px"></p>';
    expect(sanitiseEmailHtml(html)).toBe(html);
  });
  it('strips tags and attributes off the allowlist and unsafe values', () => {
    expect(sanitiseEmailHtml('<p onclick="x()" style="color:red">a<script>alert(1)</script><iframe src="https://e.test"></iframe></p>')).toBe('<p style="color:red">aalert(1)</p>');
    expect(sanitiseEmailHtml('<a href="javascript:alert(1)" target="_self">x</a>')).toBe('<a>x</a>');
    expect(sanitiseEmailHtml('<img src="https://tracker.example.test/p.gif" alt="t" onerror="x">')).toBe('<img alt="t">');
    expect(sanitiseEmailHtml('<p style="background:url(https://e.test/x)">a</p>')).toBe('<p>a</p>');
    expect(sanitiseEmailHtml("<p style='color:red'>a</p>")).toBe('<p>a</p>');
    expect(sanitiseEmailHtml('<div><span>a</span> > b & c</div>')).toBe('a &gt; b &amp; c');
    expect(sanitiseEmailHtml('<a href="{{document-link:nda}}">x</a><a href="{{document-link:a b}}">y</a>')).toBe('<a href="{{document-link:nda}}">x</a><a>y</a>');
  });
});
