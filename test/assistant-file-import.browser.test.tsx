import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import en from '../messages/en.json';
import '../app/globals.css';
import '../app/atelier.css';
vi.mock('@/app/assistant/file-import-actions',()=>({prepareAssistantImportAction:async()=>({ok:true,draft:{columns:['employee_no','amount'],rows:[['E001','-25.50']],spans:[]}})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:()=>{}})}));
const fileReads=vi.hoisted(()=>({pending:undefined as Promise<{name:string;parts:{text:string}[]}>|undefined}));
vi.mock('../lib/assistant-import-file',async importOriginal=>{
 const actual=await importOriginal<typeof import('../lib/assistant-import-file')>();
 return {...actual,readAssistantImportFile:(file:File)=>{
  // Observe the actual parser's completion; do not replace its extraction or race a one-second DOM wait.
  const pending=actual.readAssistantImportFile(file);fileReads.pending=pending;return pending;
 }};
});
const {AssistantFileImport}=await import('../components/assistant/file-import');
const {AssistantImportHandoffProvider}=await import('../components/assistant/import-handoff');
const {readAssistantImportFile}=await import('../lib/assistant-import-file');
const copy=en.assistant.fileImport;
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
async function textPdf(text?:string){
 const pdf=await PDFDocument.create();const sheet=pdf.addPage();if(text)sheet.drawText(text,{font:await pdf.embedFont(StandardFonts.Helvetica),x:20,y:700,size:12});
 return new File([await pdf.save() as BlobPart],'payroll.pdf',{type:'application/pdf'});
}
describe('real file extraction',()=>{
 it('extracts PDF text locally and refuses an image-only/blank document',async()=>{
  const source=await readAssistantImportFile(await textPdf('Employee E001 amount -25.50'));
  expect(source.parts[0].text).toContain('E001');expect(source.parts[0].text).toContain('-25.50');
  await expect(readAssistantImportFile(await textPdf())).rejects.toThrow('scan');
 });
 it('keeps every nonempty Excel worksheet available for explicit selection',async()=>{
  const xlsx=await import('xlsx'),workbook=xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet([['Employee ID','Full Name'],['0007','Alice']]),'Employees');
  xlsx.utils.book_append_sheet(workbook,xlsx.utils.aoa_to_sheet([['Employee ID','B/F Days'],['0007',5]]),'Leave');
  const source=await readAssistantImportFile(new File([xlsx.write(workbook,{type:'array',bookType:'xlsx'})],'records.xlsx'));
  expect(source.parts.map(part=>part.label)).toEqual(['Employees','Leave']);expect(source.parts[0].text).toContain('0007');
 });
});
for(const [width,height] of [[1280,900],[390,844]]){
 it(`shows a reviewable PDF draft without page overflow at ${width}px`,async()=>{
  await page.viewport(width,height);document.documentElement.setAttribute('data-ui-theme','atelier');
  render(<NextIntlClientProvider locale="en" messages={en}><main style={{maxWidth:768,margin:'auto',padding:16}}><AssistantImportHandoffProvider><AssistantFileImport/></AssistantImportHandoffProvider></main></NextIntlClientProvider>);
  const file=await textPdf('Employee E001 amount -25.50');fileReads.pending=undefined;
  await act(async()=>{
   fireEvent.change(screen.getByLabelText(copy.attach,{selector:'input'}),{target:{files:[file]}});
   expect(fileReads.pending).toBeDefined();const parsed=await fileReads.pending!;
   expect(parsed.name).toBe('payroll.pdf');expect(parsed.parts[0].text).toContain('E001');
  });
  await screen.findByText('payroll.pdf');
  fireEvent.change(screen.getByLabelText(copy.target),{target:{value:'payroll_history'}});
  fireEvent.change(screen.getByLabelText(copy.request),{target:{value:'Prepare these payroll history records'}});
  fireEvent.click(screen.getByLabelText(copy.consent));fireEvent.click(screen.getByRole('button',{name:copy.prepare}));
  await screen.findByText('Draft: 1 record');
  expect(screen.getByRole('button',{name:copy.review})).toBeDisabled();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const main=document.querySelector('main')!;
  async function capture(suffix=''){
  await page.viewport(width,Math.ceil(main.scrollHeight+32));window.scrollTo(0,0);await document.fonts.ready;
  await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  const wrapper=window.frameElement?.parentElement;
  const originalStyle=wrapper?.getAttribute('style'),originalScale=wrapper?.getAttribute('data-scale');
  wrapper?.style.setProperty('transform','none','important');wrapper?.setAttribute('data-scale','1');
  try{
   const screenshot=await page.screenshot({element:main,path:`../.vitest-attachments/assistant-file-import-${width}${suffix}.png`,animations:'disabled',scale:'css',base64:true,
    style:'#vitest-tester [data-scale], #tester-ui [data-scale] { transform: none !important; }'});
   const bytes=Uint8Array.from(atob(screenshot.base64),char=>char.charCodeAt(0)),header=new DataView(bytes.buffer);
   expect(header.getUint32(16)).toBe(Math.min(width,768));
   expect(header.getUint32(20)).toBeGreaterThanOrEqual(Math.floor(main.getBoundingClientRect().height)-1);
  }finally{
   if(wrapper){if(originalStyle==null)wrapper.removeAttribute('style');else wrapper.setAttribute('style',originalStyle);if(originalScale==null)wrapper.removeAttribute('data-scale');else wrapper.setAttribute('data-scale',originalScale);}
  }
  }
  await capture();
  fireEvent.click(screen.getByLabelText(copy.reviewed));
  fireEvent.click(screen.getByText(copy.source));
  expect(screen.getByRole('button',{name:copy.review})).toBeEnabled();
  await capture('-ready');
 });
}
