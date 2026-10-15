import { describe,expect,it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { PDFDocument,StandardFonts } from 'pdf-lib';
import { extractEvidenceText,evidenceTextMax } from '../packs/performance/onehr/evidence-extraction';
import { evidenceFigureInText } from '../packs/performance/onehr/evidence-figure-model';
const bytes=(text:string)=>new TextEncoder().encode(text);
describe('bounded evidence contents',()=>{
 it('reads text and delimited tables without executing formulas or treating names as proof',async()=>{
  expect(await extractEvidenceText('delivery.txt',bytes('Delivered 15.9 million units.'))).toMatchObject({status:'ok',text:'Delivered 15.9 million units.',method:'local'});
  expect(await extractEvidenceText('empty.txt',bytes(' \n '))).toMatchObject({status:'no_text',text:''});
  const csv=await extractEvidenceText('delivery.csv',bytes('Metric;Actual;Note\r\nDelivery;15.9;"Verified; record"\r\nFormula;=1+1;unchanged'));
  expect(csv).toMatchObject({status:'ok'});expect(csv.text).toContain('| Delivery | 15.9 | Verified; record |');expect(csv.text).toContain('=1+1');
  const long=await extractEvidenceText('long.txt',bytes('x'.repeat(10000)));expect(long.text).toBe('x'.repeat(evidenceTextMax)+'\n[... the rest of the file is not shown]');
  for(const extension of ['doc','xls','png'])expect(await extractEvidenceText(`proof.${extension}`,bytes('15.9'))).toMatchObject({status:'unsupported',text:''});
 });
 it('reads Word paragraphs and tables with namespaces and refuses entity definitions and oversized expansion',async()=>{
  const zip=new JSZip();zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Verified &amp; recorded</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Actual</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Delivery</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>15.9</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  const result=await extractEvidenceText('proof.docx',await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}));expect(result.status).toBe('ok');expect(result.text).toContain('Verified & recorded');expect(result.text).toContain('| Delivery | 15.9 |');
  zip.file('word/document.xml','<!DOCTYPE document [<!ENTITY secret SYSTEM "file:///etc/passwd">]><document>&secret;</document>');expect(await extractEvidenceText('proof.docx',await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}))).toMatchObject({status:'unreadable',text:''});
  zip.file('word/document.xml','x'.repeat(8*1024*1024+1));expect(await extractEvidenceText('bomb.docx',await zip.generateAsync({type:'uint8array',compression:'DEFLATE'}))).toMatchObject({status:'too_big',text:''});
 });
 it('reads only four workbook sheets, sixty rows and twelve columns, using cached values',async()=>{
  const book=XLSX.utils.book_new();for(let sheet=1;sheet<=5;sheet++)XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Metric','Actual'],...Array.from({length:70},(_,i)=>[`row ${i+1}`,i===60?'NEVER_ROW':15.9,...Array.from({length:11},(_,j)=>j===10?'NEVER_COLUMN':'')])]),`Sheet${sheet}`);
  const result=await extractEvidenceText('proof.xlsx',XLSX.write(book,{type:'buffer',bookType:'xlsx'}));expect(result.status).toBe('ok');expect(result.text).toContain('### Sheet: Sheet4');expect(result.text).not.toContain('Sheet5');expect(result.text).not.toContain('NEVER_ROW');expect(result.text).not.toContain('NEVER_COLUMN');
 });
 it('reads PDF text through the isolated parser and reports a scan or corrupt file without inventing contents',async()=>{
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);pdf.addPage().drawText('Verified delivery 15.9 million units.',{font});
  const result=await extractEvidenceText('proof.pdf',await pdf.save());expect(result).toMatchObject({status:'ok'});expect(result.text).toContain('15.9');
  const blank=await PDFDocument.create();blank.addPage();expect(await extractEvidenceText('scan.pdf',await blank.save())).toMatchObject({status:'no_text',text:''});
  const many=await PDFDocument.create(),manyFont=await many.embedFont(StandardFonts.Helvetica);for(let page=1;page<=16;page++)many.addPage().drawText(page===16?'NEVER_PAGE':'Verified page '+page,{font:manyFont});const capped=await extractEvidenceText('pages.pdf',await many.save());expect(capped.status).toBe('ok');expect(capped.text).toContain('Verified page 15');expect(capped.text).not.toContain('NEVER_PAGE');
  expect(await extractEvidenceText('broken.pdf',bytes('Not a PDF'))).toMatchObject({status:'unreadable',text:''});
 });
 it('grounds figures in contents with source scaling and rounding rules, ignoring dates and decorative headings',()=>{
  for(const text of ['15.90','RM15.9m','15,900,000','15.95'])expect(evidenceFigureInText(15.9,text),text).toBe(true);
  expect(evidenceFigureInText(2000000,'Q3 H2 Sheet1 2')).toBe(false);expect(evidenceFigureInText(2026,'2026-10-13 12:30')).toBe(false);expect(evidenceFigureInText(15.9,'### Sheet: 15.9\n--- page ---')).toBe(false);
  expect(evidenceFigureInText(-42,'(42)')).toBe(true);expect(evidenceFigureInText(42,'(42)')).toBe(false);expect(evidenceFigureInText(50,'0.5')).toBe(true);expect(evidenceFigureInText(0,'0')).toBe(true);
 });
});
