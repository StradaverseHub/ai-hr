import {describe,it,expect} from 'vitest';
import {PDFDocument,PDFArray,PDFRawStream,decodePDFRawStream} from 'pdf-lib';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {renderLetterPdf,type LetterPdfInput} from '../lib/letter-pdf';
import {letterVerificationWords} from '../lib/letter-verification';

const input:LetterPdfInput={reference:'HR/2026/0001',title:'Fictional appointment',signature:{name:'Fictional Signatory',caption:'Approved through authenticated internal approval',timestamp:'26 October 2026, 21:00 MYT'},document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'Dear Fictional Employee,',marks:['bold','italic','underline']}]},{type:'table',rows:[[[{type:'text',text:'Department'}],[{type:'text',text:'Fictional operations'}]]]},{type:'list',ordered:true,items:[[{type:'text',text:'First condition'}],[{type:'text',text:'Second condition'}]]}]}};
describe('sealed letter PDF layout',()=>{
 it('renders frozen structured content without changing the input',async()=>{
  const before=JSON.stringify(input),result=await renderLetterPdf(input),pdf=await PDFDocument.load(result.bytes);
  expect(Buffer.from(result.bytes).subarray(0,5).toString()).toBe('%PDF-');expect(pdf.getPageCount()).toBe(1);expect(pdf.getTitle()).toBe(input.title);expect(pdf.getSubject()).toBe(input.reference);expect(JSON.stringify(input)).toBe(before);
  for(const box of result.bounds){expect(box.x).toBeGreaterThanOrEqual(48);expect(box.x+box.width).toBeLessThanOrEqual(548);expect(box.y).toBeGreaterThanOrEqual(58);expect(box.y+box.height).toBeLessThanOrEqual(794);}
  const page=pdf.getPage(0),contents=page.node.Contents(),streams=contents instanceof PDFArray?contents.asArray().map(ref=>page.node.context.lookup(ref)):[contents];
  const operators=streams.filter(stream=>stream instanceof PDFRawStream).map(stream=>Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString('latin1')).join('\n');
  const matrices=[...operators.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) Tm/g)];expect(matrices.some(match=>Number(match[3])>0)).toBe(true);expect(matrices.every(match=>Number(match[2])===0)).toBe(true);
 });
 it('continues oversized table rows and long identifiers across pages instead of clipping them',async()=>{
  const result=await renderLetterPdf({...input,document:{...input.document,blocks:[{type:'table',rows:[[[{type:'text',text:'LongIdentifier'.repeat(700)}],[{type:'text',text:'Retained row'.repeat(300)}]]]}]}});
  expect(result.pages).toBeGreaterThan(3);expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(result.pages);expect(new Set(result.bounds.map(box=>box.page)).size).toBe(result.pages);
  for(const box of result.bounds){expect(box.x+box.width).toBeLessThanOrEqual(548);expect(box.y).toBeGreaterThanOrEqual(58);}
 });
 it.each(['en','ms','zh','ta','th','vi'] as const)('embeds the committed script fonts for %s without replacement characters',async language=>{
  const samples={en:'Fictional Employee',ms:'Pekerja Rekaan',zh:'虚构员工',ta:'கற்பனை ஊழியர்',th:'พนักงานสมมติ',vi:'Nhân viên giả định'};
  // A cross-script name must retain every script, including on an English letter.
  const result=await renderLetterPdf({...input,verification:{url:'https://letters.fixture.test/letters/verify/'+'A'.repeat(43),caption:letterVerificationWords[language].caption},document:{version:1,language,blocks:[{type:'paragraph',content:[{type:'text',text:samples[language]}]},...input.document.blocks]}});expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(1);
  if(process.env.CI&&process.env.RUNNER_TEMP){const dir=join(process.env.RUNNER_TEMP,'aihr-focused','letter-pdf-fixtures');await mkdir(dir,{recursive:true});await writeFile(join(dir,`fictional-letter-${language}.pdf`),result.bytes);}
 });
 it('refuses invalid document brand colours',async()=>{await expect(renderLetterPdf({...input,accentColor:'url(https://untrusted.invalid/logo)'})).rejects.toThrow('Invalid document brand colour');});
 it('refuses unresolved values and unsupported glyphs rather than sealing fabricated or substituted text',async()=>{
  await expect(renderLetterPdf({...input,document:{...input.document,blocks:[{type:'paragraph',content:[{type:'field',key:'employeeName'}]}]}})).rejects.toThrow('Unresolved letter field');
  await expect(renderLetterPdf({...input,title:'Unsupported 🦄'})).rejects.toThrow('Unsupported letter glyph');
 });
});
