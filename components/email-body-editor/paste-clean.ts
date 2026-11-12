import DOMPurify from 'dompurify';
import { EMAIL_TABLE_MAX_COLUMNS, EMAIL_TABLE_MAX_ROWS } from '@/lib/email-body/doc';
import { EMAIL_PASTE_ALLOWED_ATTR, EMAIL_PASTE_ALLOWED_TAGS, EMAIL_PASTE_MAX_HTML, safePastedLink } from '@/lib/email-body/paste';

export type EmailPasteResult = { html: string; truncated: boolean; droppedImages: number; tooLarge: boolean };
export type EmailPasteOptions = { imageIds?: Iterable<string>; documentIds?: Iterable<string>; fieldKeys?: Iterable<string> };

/**
 * Browser-only clipboard boundary for the email body. Word/Outlook/Google Docs HTML keeps paragraphs, line breaks,
 * bold, italic, underline, lists, safe links (https/http/mailto) and tables (first 6 columns x 30 rows, flagged when
 * cut). Fonts, sizes, colours, highlights, alignment, classes, Word markup (mso-*, o:p, conditional comments), scripts
 * and pasted images go. Our own chips, document links and uploaded images survive an internal copy/paste.
 * Parsing uses DOMParser (inert: no scripts run, no images load) before DOMPurify has the last word.
 */
export function cleanEmailPaste(html: string, options: EmailPasteOptions = {}): EmailPasteResult {
  if (html.length > EMAIL_PASTE_MAX_HTML) return { html: '', truncated: false, droppedImages: 0, tooLarge: true };
  if (!DOMPurify.isSupported || typeof DOMParser === 'undefined') throw new Error('Paste cleaning needs a browser.');
  const imageIds = new Set(options.imageIds ?? []), documentIds = new Set(options.documentIds ?? []), fieldKeys = options.fieldKeys ? new Set(options.fieldKeys) : null;
  // Conditional comments (<!--[if gte mso 9]>…<![endif]-->) hold Word/VML markup only.
  const source = html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '');
  const dom = new DOMParser().parseFromString(source, 'text/html'), body = dom.body;
  const style = (element: Element) => (element.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
  const replace = (element: Element, tag: string) => { const next = dom.createElement(tag); while (element.firstChild) next.appendChild(element.firstChild); element.replaceWith(next); return next; };
  const unwrap = (element: Element) => element.replaceWith(...Array.from(element.childNodes));

  body.querySelectorAll('script,style,xml,head,title,meta,link,noscript,template,iframe,object,embed,svg,math,form,input,button,select,textarea').forEach(element => element.remove());
  // Word's list bullets/numbers sit in <span style="mso-list:Ignore">; read the kind, then drop them.
  body.querySelectorAll('p').forEach(paragraph => {
    if (!/mso-list:l\d/.test(style(paragraph))) return;
    const marker = Array.from(paragraph.querySelectorAll('span')).find(span => /mso-list:ignore/.test(style(span)));
    paragraph.setAttribute('data-paste-list', /^\s*(\d+|[a-z]|[ivxlc]+)[.)]/i.test(marker?.textContent ?? '') ? 'ol' : 'ul');
  });
  body.querySelectorAll('span').forEach(element => { if (/mso-list:ignore/.test(style(element))) element.remove(); });
  body.querySelectorAll('o\\:p').forEach(unwrap);
  // Google Docs wraps the whole clipboard in <b style="font-weight:normal">; that is not bold.
  body.querySelectorAll('b,strong').forEach(element => { if (/font-weight:(normal|400)/.test(style(element))) unwrap(element); });
  // Formatting expressed only as CSS (Google Docs, Outlook web) becomes real tags before styles are dropped.
  body.querySelectorAll('span').forEach(element => {
    const css = style(element);
    let node: Element = element;
    const wrap = (tag: string) => { const outer = dom.createElement(tag); node.replaceWith(outer); outer.appendChild(node); node = outer; };
    if (/font-weight:(bold|[6-9]00)/.test(css)) wrap('strong');
    if (/font-style:italic/.test(css)) wrap('em');
    if (/text-decoration[a-z-]*:[^;]*underline/.test(css)) wrap('u');
  });
  body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(element => { const p = replace(element, 'p'); const strong = dom.createElement('strong'); while (p.firstChild) strong.appendChild(p.firstChild); p.appendChild(strong); });
  // Word desktop lists are paragraphs with mso-list styles: consecutive ones become one <ul>/<ol>.
  for (const paragraph of Array.from(body.querySelectorAll('p'))) {
    const kind = paragraph.getAttribute('data-paste-list');
    if (!paragraph.isConnected || !kind) continue;
    const list = dom.createElement(kind);
    paragraph.before(list);
    let current: Element | null = paragraph;
    while (current && current.tagName === 'P' && current.getAttribute('data-paste-list') === kind) {
      const next: Element | null = current.nextElementSibling;
      const li = dom.createElement('li'); li.appendChild(replace(current, 'p')); list.appendChild(li);
      current = next;
    }
  }
  let droppedImages = 0;
  body.querySelectorAll('img').forEach(element => {
    const id = element.getAttribute('data-email-image');
    if (id && imageIds.has(id)) { for (const attr of Array.from(element.attributes)) if (attr.name !== 'data-email-image' && attr.name !== 'alt') element.removeAttribute(attr.name); return; }
    droppedImages++; element.remove();
  });
  body.querySelectorAll('[data-email-field]').forEach(element => { if (fieldKeys && !fieldKeys.has(element.getAttribute('data-email-field') ?? '')) element.removeAttribute('data-email-field'); });
  body.querySelectorAll('a').forEach(element => {
    const documentId = element.getAttribute('data-email-document');
    if (element.getAttribute('data-email-link') === 'document' && documentId && documentIds.has(documentId)) { element.removeAttribute('href'); return; }
    const safe = safePastedLink(element.getAttribute('href'));
    if (!safe) return unwrap(element);
    for (const attr of Array.from(element.attributes)) element.removeAttribute(attr.name);
    element.setAttribute('href', safe.href);
  });
  // Tables: inner tables flatten to paragraphs (no nested tables); then cut to 6 x 30.
  let nested: Element | null;
  while ((nested = body.querySelector('table table'))) {
    const parts = Array.from(nested.querySelectorAll('tr')).map(row => { const p = dom.createElement('p'); p.textContent = Array.from(row.children).map(cell => cell.textContent?.trim() ?? '').filter(Boolean).join(' '); return p; });
    nested.replaceWith(...parts);
  }
  let truncated = false;
  body.querySelectorAll('table').forEach(table => {
    table.querySelectorAll('caption,colgroup,col').forEach(element => element.remove());
    const rows = Array.from(table.querySelectorAll('tr'));
    rows.forEach((row, index) => {
      if (index >= EMAIL_TABLE_MAX_ROWS) { truncated = true; row.remove(); return; }
      Array.from(row.children).forEach((cell, c) => { if (c >= EMAIL_TABLE_MAX_COLUMNS) { truncated = true; cell.remove(); } });
    });
    table.querySelectorAll('tfoot').forEach(element => unwrap(element));
  });
  // Hrefs were validated above; plain spans (styling carriers) go, our chips stay.
  body.querySelectorAll('span').forEach(element => { if (!element.hasAttribute('data-email-field')) unwrap(element); });
  const clean = DOMPurify.sanitize(body.innerHTML, {
    ALLOWED_TAGS: [...EMAIL_PASTE_ALLOWED_TAGS], ALLOWED_ATTR: [...EMAIL_PASTE_ALLOWED_ATTR], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['data-email-field', 'data-email-image', 'data-email-link', 'data-email-document', 'data-widths'], RETURN_TRUSTED_TYPE: false,
  });
  return { html: clean, truncated, droppedImages, tooLarge: false };
}
