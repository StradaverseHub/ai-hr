import sharp from 'sharp';
import { v9SignaturePresentation } from './lifecycle-v9-signature-presentation';
import { v9Letterhead } from './lifecycle-v9-letterhead';
import { renderLetterPdf, type LetterPdfInput } from './letter-pdf';
import { merge, V9Error, type Document, type Field, type Signature } from './lifecycle-v9-model';
import type { ResolvedLetterBlock, LetterInline } from './letter-model';
import { validV9SignatureValue } from './lifecycle-v9-signature';
const text = (value: string): LetterInline[] => [{ type: 'text', text: value }];
const shown = (field: Field, document: Document) => !field.when || document.values[field.when.field] === field.when.value;
/** Render only the saved instance. No current Personnel read, remote assets or template regeneration. */
export function v9PdfDocument(document: Document, requireComplete = false): LetterPdfInput['document'] {
  const blocks: ResolvedLetterBlock[] = [], values = { ...document.mergeValues, ...document.values };
  function resolved(value: string) { const result = merge(value, values); if (requireComplete && result.missing.length) throw new V9Error('Complete missing document fields before exporting an attachment.'); return result.text; }
  function field(field: Field) {
    if (!shown(field, document)) return;
    const value = document.values[field.id] ?? '';
    if (requireComplete && field.required && (!value.trim() || field.type === 'checkbox' && value !== 'true')) throw new V9Error(`Complete ${field.label} before exporting an attachment.`);
    blocks.push({ type: 'paragraph', content: [{ type: 'text', text: field.label, marks: ['bold'] }] });
    if (field.type === 'table') {
      let rows: unknown; try { rows = value ? JSON.parse(value) : []; } catch { throw new V9Error(`Enter valid rows for ${field.label}.`); }
      if (!Array.isArray(rows) || rows.length > 50 || !rows.every(row => Array.isArray(row) && row.length === (field.columns?.length ?? 0) && row.every(cell => typeof cell === 'string' && cell.length <= 1000))) throw new V9Error(`Enter valid rows for ${field.label}.`);
      if (requireComplete && field.required && rows.length === 0) throw new V9Error(`Complete ${field.label} before exporting an attachment.`);
      if (field.columns?.length) blocks.push({ type: 'table', rows: [field.columns, ...rows as string[][]].map(row => row.map(cell => text(cell))) });
    } else blocks.push({ type: 'paragraph', content: text(field.type === 'checkbox' ? value === 'true' ? 'Yes' : value === 'false' ? 'No' : '' : value) });
  }
  for (const block of document.blocks) {
    const value = resolved(document.edits[block.id] ?? block.text);
    if (block.type === 'letterhead') { const letterhead = v9Letterhead(document); blocks.push({ type: 'heading', level: 2, content: text(letterhead.name) }, { type: 'paragraph', content: text(letterhead.registration) }, { type: 'paragraph', content: text(letterhead.address) }); }
    else if (block.type === 'heading' || block.type === 'subheading') blocks.push({ type: 'heading', level: block.type === 'heading' ? 1 : 2, content: text(value) });
    else if (block.type === 'text') blocks.push({ type: 'paragraph', content: text(value) });
    else if (block.type === 'fields') document.fields.filter(field => field.section === block.section).forEach(field);
    else if (block.type === 'field') { const definition = document.fields.find(field => field.id === block.fieldId); if (definition) field(definition); }
    else if (block.type === 'table') blocks.push({ type: 'table', rows: [(block.columns ?? '').split(/[,|]/).map(cell => cell.trim()), ...(block.rows ?? '').split('\n').filter(Boolean).map(row => row.split('|').map(cell => resolved(cell.trim())))].map(row => row.map(cell => text(cell))) });
    else if (block.type === 'signature') { const presentation=v9SignaturePresentation(document,block.role==='hr'?'hr':'employee'); blocks.push({type:'paragraph',content:text(resolved(block.label??''))},{type:'paragraph',content:[{type:'text',text:presentation.name,marks:['bold']}]},{type:'paragraph',content:text(presentation.detail)},{type:'paragraph',content:text(presentation.status)}); }
  }
  return { version: 1, language: 'en', blocks };
}
function timestamp(value: string) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new V9Error('This document timestamp needs review.'); return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) + ' MYT'; }
async function evidence(signature: Signature | null, role: string, document: Document): Promise<LetterPdfInput['signature']> {
  if (!signature) return { name: '', caption: document.templateType === 'Attachment' ? 'Generated attachment' : `Unsigned document · ${document.status}`, timestamp: timestamp(document.createdAt) };
  if (!validV9SignatureValue(signature.method, signature.value)) throw new V9Error('This recorded signature needs review before PDF export.');
  const stamp = signature.method === 'drawn' ? await sharp(Buffer.from(signature.value.slice(signature.value.indexOf(',') + 1), 'base64'), { limitInputPixels: 2097152, failOn: 'error' }).png().toBuffer() : undefined;
  return { name: signature.method === 'typed' ? signature.value : signature.by.name, caption: `${role} signature recorded in AI HR${signature.method === 'typed' && signature.value !== signature.by.name ? ' · account: ' + signature.by.name : ''}`, timestamp: timestamp(signature.at), ...(stamp ? { stamp } : {}) };
}
export async function renderV9DocumentPdf(document: Document, reference: string, requireComplete = false) {
  const signatures = document.hrStep === 'before' ? [{ signature: document.hrSignature, role: 'HR' }, { signature: document.employeeSignature, role: 'Employee' }] : [{ signature: document.employeeSignature, role: 'Employee' }, { signature: document.hrSignature, role: 'HR' }];
  const recorded = signatures.filter(value => value.signature);
  const primary = recorded[0] ?? { signature: null, role: 'Employee' };
  const result = await renderLetterPdf({ document: v9PdfDocument(document, requireComplete), title: document.name, ...(document.blocks.some(block => block.type === 'letterhead') ? { accentColor: v9Letterhead(document).color } : {}), reference: `${reference} · v${document.version} · ${document.status}`, signature: await evidence(primary.signature, primary.role, document), ...(recorded.length > 1 ? { additionalSignatures: [await evidence(recorded[1].signature, recorded[1].role, document)] } : {}) });
  return { bytes: result.bytes, pages: result.pages };
}
