import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFRawStream, PDFName } from 'pdf-lib';
import sharp from 'sharp';
import { renderV9DocumentPdf, v9PdfDocument } from '../lib/lifecycle-v9-pdf';
import { validV9SignatureValue } from '../lib/lifecycle-v9-signature';
import type { Document } from '../lib/lifecycle-v9-model';
function fixture(): Document {
  return { id: 'document', templateId: 'form', templateType: 'Form', version: 2, name: 'Fictional signed onboarding form', status: 'signed', createdAt: '2026-10-29T01:00:00Z', sentAt: '2026-10-29T01:00:00Z', hrSignature: null, employeeSignature: { by: { id: 'actual-fixture-user', name: 'Fictional Employee' }, at: '2026-10-29T02:00:00Z', method: 'typed', value: 'Fictional Employee', consent: true },
    mergeValues: { 'employee.name': 'Fictional Employee', 'company.name': 'Fictional Company', 'company.regNo': 'FICTIONAL-REG-001', 'company.address': 'Fictional address line 1\nFictional address line 2', 'company.color': '#336699' }, values: { contact: '+60111111111', showMore: 'no', hidden: 'Hidden answer', assets: JSON.stringify([['Laptop', 'FICTIONAL-001']]) }, edits: { intro: 'Saved edit for {employee.name}' },
    blocks: [{ id: 'head', type: 'letterhead', text: '', section: '' }, { id: 'title', type: 'heading', text: 'Your saved form', section: '' }, { id: 'intro', type: 'text', text: 'Old template wording', section: '' }, { id: 'fields', type: 'fields', text: '', section: 'main' }, { id: 'signature', type: 'signature', text: '', section: '', role: 'employee', label: 'I confirm these details.' }], fields: [{ id: 'contact', label: 'Contact number', type: 'phone', owner: 'employee', pmKey: 'mobile', required: true, sensitive: false, options: [], section: 'main', when: null }, { id: 'hidden', label: 'Hidden field', type: 'text', owner: 'employee', pmKey: null, required: false, sensitive: false, options: [], section: 'main', when: { field: 'showMore', value: 'yes' } }, { id: 'assets', label: 'Equipment received', type: 'table', owner: 'employee', pmKey: null, required: true, sensitive: false, options: [], columns: ['Asset', 'Serial'], section: 'main', when: null }] };
}
it('exports the saved instance values, per-person edits, conditional fields and signature evidence without mutation', async () => {
  const document = fixture(), before = structuredClone(document), resolved = v9PdfDocument(document, true), text = JSON.stringify(resolved);
  expect(text).toContain('FICTIONAL-REG-001'); expect(text).toContain('Fictional address line 1'); expect(text).toContain('Saved edit for Fictional Employee'); expect(text).toContain('+60111111111'); expect(text).toContain('FICTIONAL-001'); expect(text).not.toContain('Old template wording'); expect(text).not.toContain('Hidden answer'); expect(text).not.toContain('Hidden field');
  const result = await renderV9DocumentPdf(document, 'OB-FICTIONAL-1', true), pdf = await PDFDocument.load(result.bytes);
  expect(Buffer.from(result.bytes).subarray(0, 5).toString()).toBe('%PDF-'); expect(pdf.getTitle()).toBe(document.name); expect(pdf.getSubject()).toContain('v2'); expect(pdf.getPageCount()).toBe(result.pages); expect(document).toEqual(before);
  if (process.env.AIHR_TEST_ARTIFACT_DIR) { await mkdir(process.env.AIHR_TEST_ARTIFACT_DIR, { recursive: true }); await writeFile(join(process.env.AIHR_TEST_ARTIFACT_DIR, 'v9-saved-document.pdf'), result.bytes); }
});
it('refuses unresolved attachment merges, incomplete required tables and invalid recorded signatures', async () => {
  const document = fixture(); document.blocks.push({ id: 'missing', type: 'text', text: '{missing.value}', section: '' });
  expect(() => v9PdfDocument(document, true)).toThrow('missing document fields');
  document.blocks.pop(); document.values.assets = '[]'; expect(() => v9PdfDocument(document, true)).toThrow('Equipment received');
  document.values.assets = JSON.stringify([['Laptop', 'FICTIONAL-001']]); document.employeeSignature!.method = 'drawn'; document.employeeSignature!.value = 'https://untrusted.invalid/signature.png';
  await expect(renderV9DocumentPdf(document, 'OB-FICTIONAL-1')).rejects.toThrow('signature needs review');
});
it('bounds signature images and retains both drawn marks in a countersigned PDF', async () => {
  const bytes = await sharp({ create: { width: 128, height: 48, channels: 4, background: '#334455' } }).png().toBuffer();
  const value = 'data:image/png;base64,' + bytes.toString('base64');
  expect(validV9SignatureValue('drawn', value)).toBe(true); expect(validV9SignatureValue('drawn', 'data:image/svg+xml;base64,PHN2Zz4=')).toBe(false); expect(validV9SignatureValue('typed', 'x'.repeat(201))).toBe(false); expect(validV9SignatureValue('typed', 'Name\nInjected')).toBe(false);
  const document = fixture(); document.employeeSignature = { ...document.employeeSignature!, method: 'drawn', value }; document.hrSignature = { ...document.employeeSignature, by: { id: 'actual-fixture-hr', name: 'Fictional HR' } };
  const result = await renderV9DocumentPdf(document, 'OB-FICTIONAL-1', true); const pdf = await PDFDocument.load(result.bytes); expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  expect(pdf.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image').length).toBeGreaterThanOrEqual(2);
});
it('prints frozen signer names, titles and unsigned status in the signature blocks',()=>{
  const document=fixture();document.hrSignature=null;document.employeeSignature=null;document.signatoryUserId='frozen-hr';
  document.mergeValues!['signatory.name']='Fictional frozen HR';document.mergeValues!['signatory.title']='Frozen printed title';document.blocks.push({id:'hr-sign',type:'signature',role:'hr',label:'Yours sincerely,',text:'',section:''});
  const output=JSON.stringify(v9PdfDocument(document));expect(output).toContain('Fictional frozen HR');expect(output).toContain('Frozen printed title, Fictional Company');expect(output).toContain('Not signed yet');
});
