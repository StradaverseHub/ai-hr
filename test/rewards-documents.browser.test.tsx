import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readDescription } from '../packs/rewards/document-reader';

describe('Rewards document readers in Chromium', () => {
  it('extracts Word paragraphs without retaining markup', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Operations analyst</w:t></w:r></w:p><w:p><w:r><w:t>Prepare weekly reporting for one department.</w:t></w:r></w:p></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const text = await readDescription(new File([new Uint8Array(bytes)], 'role.docx'));
    expect(text).toBe('Operations analyst\nPrepare weekly reporting for one department.');
  });
  it('extracts a real PDF text layer through its worker', async () => {
    const doc = await PDFDocument.create(); const page = doc.addPage(); const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Lead reporting across three departments.', { x: 40, y: 700, font, size: 12 });
    const text = await readDescription(new File([new Uint8Array(await doc.save())], 'role.pdf'));
    expect(text).toContain('Lead reporting across three departments.');
  });
  it('rejects scanned PDFs, unsupported files, oversized text and expanded Word documents', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    await expect(readDescription(new File([new Uint8Array(await pdf.save())], 'scan.pdf'))).rejects.toThrow();
    await expect(readDescription(new File(['x'.repeat(100)], 'role.exe'))).rejects.toThrow();
    await expect(readDescription(new File(['x'.repeat(30001)], 'role.txt'))).rejects.toThrow();
    const zip = new JSZip(); zip.file('word/document.xml', 'x'.repeat(2_000_001));
    await expect(readDescription(new File([new Uint8Array(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))], 'large.docx'))).rejects.toThrow();
  });
});
