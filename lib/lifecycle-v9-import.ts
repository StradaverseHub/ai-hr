import type { Block, Module, Template } from './lifecycle-v9-model';

export type ImportItem = { kind: 'heading' | 'subheading' | 'text'; text: string } | { kind: 'table'; rows: string[][] };
export type ParsedImport = { items: ImportItem[]; notes: string[]; unreadable?: boolean };
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', copy: '©', reg: '®' };
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, key: string) => {
    if (!key.startsWith('#')) return entities[key.toLowerCase()] ?? whole;
    const point = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '�';
  });
}
function bounded(text: string) { if (text.length > 60000) throw Error('This document has more than 60,000 characters. Import a shorter section or paste the text you need.'); return text; }
/** The supplied importer's Markdown/text conventions; no markup is evaluated. */
export function parseV9ImportText(source: string): ParsedImport {
  const items: ImportItem[] = [], buffer: string[] = []; let first = true;
  function flush() { const text = buffer.join('\n').trim(); buffer.length = 0; if (text) { items.push({ kind: 'text', text }); first = false; } }
  for (const line of bounded(source).replace(/\r\n?/g, '\n').split('\n')) {
    let text = line.trim(); if (!text) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading) { flush(); items.push({ kind: heading[1].length === 1 ? 'heading' : 'subheading', text: heading[2] }); first = false; continue; }
    const table = /^\|(.+)\|$/.exec(text);
    if (table) { flush(); if (/^[\s|:\-]+$/.test(text)) continue; const cells = table[1].split('|').map(c => c.trim()), previous = items.at(-1); if (previous?.kind === 'table') previous.rows.push(cells); else items.push({ kind: 'table', rows: [cells] }); first = false; continue; }
    if (/^[-*]\s+/.test(text)) text = '• ' + text.replace(/^[-*]\s+/, '');
    if (!buffer.length && text.length < 80 && /[A-Z]/.test(text) && text === text.toUpperCase() && !/[.:,;]$/.test(text)) { items.push({ kind: first ? 'heading' : 'subheading', text }); first = false; continue; }
    if (first && !buffer.length && text.length < 90 && !/[.:,;]$/.test(text)) { items.push({ kind: 'heading', text }); first = false; continue; }
    buffer.push(text);
  }
  flush(); return { items, notes: [] };
}
export function parseV9ImportHtml(source: string): ParsedImport {
  // String-only parsing prevents scripts, frames, remote images and styles from loading during import.
  const html = bounded(source).replace(/<(script|style|head|iframe|object|template)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<br\s*\/?>/gi, '\n');
  const strip = (text: string) => decode(text.replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  const items: ImportItem[] = [], pattern = /<table\b[\s\S]*?<\/table\s*>|<h[1-6]\b[\s\S]*?<\/h[1-6]\s*>|<(p|li|pre|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const chunk = match[0], tag = /^<(\w+)/.exec(chunk)![1].toLowerCase();
    if (tag === 'table') { const rows = [...chunk.matchAll(/<tr\b[\s\S]*?<\/tr\s*>/gi)].map(row => [...row[0].matchAll(/<t[dh]\b[\s\S]*?<\/t[dh]\s*>/gi)].map(cell => strip(cell[0]).replace(/\n/g, ' '))); if (rows.length) items.push({ kind: 'table', rows }); }
    else { const text = strip(chunk); if (text) items.push({ kind: /^h[1-6]$/.test(tag) ? tag === 'h1' ? 'heading' : 'subheading' : 'text', text: tag === 'li' ? '• ' + text : text }); }
  }
  return items.length ? { items, notes: [] } : parseV9ImportText(strip(html));
}
const shared = { 'employee.name': 'Employee name', 'employee.icNo': 'NRIC no.', 'employee.passportNo': 'Passport no.', 'employee.empNo': 'Employee no.', 'employee.position': 'Job title', 'employee.department': 'Department', 'employee.company': 'Company', 'employee.businessGroup': 'Business Group', 'employee.grade': 'Job grade', 'employee.supervisor': 'Supervisor', 'employee.companyEmail': 'Company email', 'employee.personalEmail': 'Personal email', 'company.name': 'Company name (letterhead)', 'company.regNo': 'Company registration no.', 'company.address': 'Company address', 'signatory.name': 'HR signatory name', 'signatory.title': 'HR signatory title', today: 'Date generated' };
const moduleFields = { onb: { 'joiner.joinDate': 'Join date', 'joiner.empType': 'Employment type', 'joiner.workLocation': 'Work location', 'joiner.ta': 'GBS TA name' }, off: { 'leaver.lastDay': 'Last working day', 'leaver.noticeDate': 'Notice date', 'leaver.caseType': 'Case type', 'leave.entitled': 'Annual leave entitlement (pro-rated)', 'leave.taken': 'Annual leave taken', 'leave.remaining': 'Remaining annual leave', 'leave.encashDays': 'Leave encashment days', 'leave.dailyRate': 'Daily rate', 'leave.encashAmount': 'Leave encashment amount', 'pay.finalPayDate': 'Final pay date' } };
export function v9ImportMergeFields(module: Module): Record<string, string> { return { ...shared, ...moduleFields[module] }; }
const synonyms: Record<string, string> = { fullname: 'employee.name', name: 'employee.name', employeename: 'employee.name', staffname: 'employee.name', newjoinername: 'employee.name', jobtitle: 'employee.position', position: 'employee.position', designation: 'employee.position', department: 'employee.department', dept: 'employee.department', companyname: 'company.name', company: 'company.name', startdate: 'joiner.joinDate', joiningdate: 'joiner.joinDate', joindate: 'joiner.joinDate', dateofjoining: 'joiner.joinDate', supervisor: 'employee.supervisor', linemanager: 'employee.supervisor', reportingto: 'employee.supervisor', lastworkingday: 'leaver.lastDay', lastday: 'leaver.lastDay', icno: 'employee.icNo', nric: 'employee.icNo', nricno: 'employee.icNo', icnumber: 'employee.icNo' };
export function buildV9Import(parsed: ParsedImport, type: Template['type'], module: Module, nextId: () => string) {
  const fields = v9ImportMergeFields(module), dictionary = new Map<string, string>(), normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, label] of Object.entries(fields)) { dictionary.set(normalize(key), key); dictionary.set(normalize(label), key); }
  const matched: { from: string; to: string }[] = [], unmatched: string[] = [], counts = { headings: 0, paragraphs: 0, tables: 0 };
  function fix(text: string): string {
    return text.replace(/\[\[([^\]\n]{1,40})\]\]|<<([^>\n]{1,40})>>|\{\{\s*([^}\n]{1,40}?)\s*\}\}|\$\{([^}\n]{1,40})\}|\[([A-Za-z][A-Za-z0-9 _.\/]{1,40})\]|\{([A-Za-z][A-Za-z0-9 _.]{1,40})\}/g, (whole, ...groups: unknown[]) => {
      const captures = groups.slice(0, 6) as (string | undefined)[], raw = (captures.find(Boolean) ?? '').trim(), single = !!(captures[4] || captures[5]);
      if (captures[5] && fields[raw]) return whole;
      const normalized = normalize(raw), key = dictionary.get(normalized) ?? (fields[synonyms[normalized]] ? synonyms[normalized] : '');
      if (key) { const to = `{${key}}`; if (!matched.some(m => m.from === whole)) matched.push({ from: whole, to }); return to; }
      if ((!single || /^[A-Z][A-Za-z]*(?: [A-Za-z]+){0,3}$/.test(raw)) && !unmatched.includes(whole)) unmatched.push(whole);
      return whole;
    });
  }
  const blocks: Block[] = [], block = (type: Block['type'], patch: Partial<Block> = {}) => { blocks.push({ id: nextId(), type, text: '', section: '', ...patch }); };
  block('letterhead'); let titled = false, sawSignature = false;
  for (const item of parsed.items) {
    if (item.kind === 'heading' || item.kind === 'subheading') { block(titled ? 'subheading' : 'heading', { text: fix(item.text) }); titled = true; counts.headings++; }
    else if (item.kind === 'table') { const rows = item.rows.filter(row => row.some(cell => cell.trim())); if (!rows.length) continue; const width = rows[0].length; block('table', { columns: rows[0].map(cell => fix(cell.replace(/,/g, ' ').replace(/\s+/g, ' ').trim())).join(', '), rows: rows.slice(1).map(row => Array.from({ length: width }, (_, i) => fix((row[i] ?? '').replace(/\|/g, '/'))).join(' | ')).join('\n') }); counts.tables++; }
    else { let text = item.text.trim(); if (!text) continue; if (/^(employee'?s? )?(signature|signed)\b[\s:_.\-]*$/i.test(text) || /^[_.\-\s]{6,}$/.test(text) || /^date( signed)?\s*[:_.\s]*$/i.test(text) || type === 'Letter' && /^(yours (sincerely|faithfully)|sincerely|best regards|regards|kind regards),?$/i.test(text)) { sawSignature = true; continue; } if (!titled) { const [heading, ...rest] = text.split('\n'); block('heading', { text: fix(heading) }); titled = true; counts.headings++; text = rest.join('\n').trim(); } if (text) { block('text', { text: fix(text) }); counts.paragraphs++; } }
  }
  if (type !== 'Attachment') block('signature', { role: type === 'Letter' ? 'hr' : 'employee', label: type === 'Letter' ? 'Yours sincerely,' : 'I confirm the above.' });
  if (blocks.length > 500 || blocks.some(block => block.text.length > 20000 || (block.rows?.length ?? 0) > 20000)) throw Error('This document is too long for a single template. Import a shorter section.');
  return { blocks, report: { matched, unmatched, counts, signature: type !== 'Attachment', sawSignature }, notes: parsed.notes };
}

async function readV9Docx(bytes: ArrayBuffer): Promise<ParsedImport> {
  const { default: JSZip } = await import('jszip'), zip = await JSZip.loadAsync(bytes), entry = zip.file('word/document.xml');
  if (!entry) throw Error("This doesn't look like a Word (.docx) file.");
  const xml = await new Promise<string>((resolve, reject) => {
    let length = 0; const chunks: string[] = [];
    const stream = (entry as typeof entry & { internalStream(type: 'string'): import('jszip').JSZipStreamHelper<string> }).internalStream('string');
    stream.on('data', chunk => { length += chunk.length; if (length > 2_000_000) { stream.pause(); reject(Error('This Word document is too large to import.')); } else chunks.push(chunk); });
    stream.on('error', reject); stream.on('end', () => resolve(chunks.join(''))); stream.resume();
  });
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('This Word file contains unsupported XML declarations.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw Error('This Word file could not be read.');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', body = document.getElementsByTagNameNS(ns, 'body')[0];
  if (!body) throw Error('This Word file has no document body.');
  const descendants = (element: Element, name: string) => Array.from(element.getElementsByTagNameNS(ns, name));
  function paragraphText(element: Element): string {
    const parts: string[] = [];
    function visit(node: Element) { if (node.namespaceURI === ns && node.localName === 't') parts.push(node.textContent ?? ''); else if (node.namespaceURI === ns && node.localName === 'tab') parts.push('\t'); else if (node.namespaceURI === ns && node.localName === 'br') parts.push('\n'); else for (const child of Array.from(node.children)) visit(child); }
    visit(element); return parts.join('');
  }
  const items: ImportItem[] = [], notes: string[] = []; let characters = 0;
  for (const child of Array.from(body.children)) {
    if (child.namespaceURI !== ns) continue;
    if (child.localName === 'tbl') {
      const rows = Array.from(child.children).filter(node => node.localName === 'tr').map(row => Array.from(row.children).filter(node => node.localName === 'tc').map(cell => descendants(cell, 'p').map(paragraphText).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')));
      characters += rows.flat().join('').length; if (rows.length) items.push({ kind: 'table', rows });
    } else if (child.localName === 'p') {
      let text = paragraphText(child).trim(); if (!text) continue;
      const style = descendants(child, 'pStyle')[0]?.getAttributeNS(ns, 'val') ?? '';
      const runs = descendants(child, 'r').filter(run => descendants(run, 't').some(t => t.textContent?.trim()));
      const bold = runs.length > 0 && runs.every(run => { const b = descendants(run, 'b')[0]; return b && !['0', 'false', 'off'].includes(b.getAttributeNS(ns, 'val') ?? ''); });
      const kind = /^(Title|Heading1)$/i.test(style) ? 'heading' : /^(Heading\d|Subtitle)$/i.test(style) || bold && text.length < 80 && !text.includes('\n') ? 'subheading' : 'text';
      if (kind === 'text' && (descendants(child, 'numPr').length || /^List/i.test(style))) text = '• ' + text;
      characters += text.length; items.push({ kind, text });
    }
    if (characters > 60000) throw Error('This document has more than 60,000 characters. Import a shorter section.');
  }
  const images = descendants(body, 'drawing').length + descendants(body, 'pict').length;
  if (images) notes.push(`${images} ${images === 1 ? 'image was' : 'images were'} left out.`);
  if (Object.keys(zip.files).some(name => /^word\/(header|footer)\d*\.xml$/.test(name))) notes.push('Headers and footers were left out.');
  return { items, notes };
}
/** Browser-only file reading; callers save only the reviewed editable draft, never the raw file. */
export async function readV9ImportFile(file: File): Promise<ParsedImport> {
  if (!file.size || file.size > 10 * 1024 * 1024) throw Error('Choose a file of at most 10 MB.');
  const extension = file.name.toLowerCase().split('.').at(-1);
  if (extension === 'doc') throw Error("Old Word files (.doc) can't be read. Open it in Word and save it as .docx, then try again.");
  if (extension === 'docx') return readV9Docx(await file.arrayBuffer());
  if (['txt', 'md', 'markdown'].includes(extension ?? '')) return parseV9ImportText(await file.text());
  if (extension === 'html' || extension === 'htm') return parseV9ImportHtml(await file.text());
  if (extension !== 'pdf') throw Error('Use Word (.docx), text, Markdown, HTML or PDF.');
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), disableFontFace: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 100) throw Error('This PDF has more than 100 pages. Import a shorter section.');
    const pages: string[] = []; let length = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      length += text.length; if (length > 60000) throw Error('This document has more than 60,000 characters. Import a shorter section.');
      pages.push(text);
    }
    const text = pages.join('\n\n').trim();
    if (text.length < 20) return { items: [], notes: [], unreadable: true };
    return { ...parseV9ImportText(text), notes: ['Read from a PDF, so headings, tables and line breaks may need tidying.'] };
  } finally { await task.destroy(); }
}
