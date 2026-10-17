import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import { defaultMasterColumn, runEmployeeMasterProjection, type EmployeeMasterSpec, type MasterSubject } from '../lib/employee-master-report';
import { serializeEmployeeMaster } from '../lib/employee-master-export';
const field=(owner:string,key:string)=>PERSONNEL_FIELDS.find(field=>field.owner===owner&&field.ownerField===key)!;
const code=field('employment','employeeCode'),name=field('person','fullName'),hire=field('employment','hiredOn'),salary=field('compensation','basicSalary');
const fields=[code,name,hire,salary];
const spec:EmployeeMasterSpec={v:2,asAt:'2024-06-01',companyIds:['00000000-0000-4000-8000-000000000001'],includeDrafts:false,columns:[code,name,hire,salary].map(defaultMasterColumn),expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
const subjects:MasterSubject[]=Array.from({length:61},(_,index)=>({id:'employment-'+index,personId:'person-'+index,companyId:spec.companyIds[0],kind:'employment',owners:{employment:[{id:'employment-'+index,values:{employeeCode:{value:String(index).padStart(5,'0')},hiredOn:{value:'2024-01-02'}}}],person:[{id:'person-'+index,values:{fullName:{value:index===0?'=HYPERLINK("https://example.test")':index===1?'中文姓名':'Synthetic '+index}}}],compensation:[{id:'salary-'+index,effectiveFrom:'2024-01-01',currency:'MYR',values:{basicSalary:{value:'1200.50',currency:'MYR'}}}]}}));
const result=()=>runEmployeeMasterProjection(spec,fields,subjects,spec.asAt);
describe('Employee Master complete typed exports',()=>{
 it.each([
  ['left','center','right'],['center','right','left'],['right','left','center'],
 ] as const)('serializes selected text/date/number alignment %s/%s/%s without losing real Excel formats',async(textAlign,dateAlign,numberAlign)=>{
  const definition:EmployeeMasterSpec={...spec,columns:[{...defaultMasterColumn(name),align:'right'},{...defaultMasterColumn(code),align:textAlign,freeze:false},{...defaultMasterColumn(hire),align:dateAlign},{...defaultMasterColumn(salary),align:numberAlign,decimals:3,sum:true}],groups:[code.id]};
  const run=runEmployeeMasterProjection(definition,fields,[subjects[0]],spec.asAt),before=JSON.stringify(run);
  const output=await serializeEmployeeMaster(run,definition,fields,'Selected alignment','xlsx'),zip=await JSZip.loadAsync(output.bytes);
  const styles=await zip.file('xl/styles.xml')!.async('string'),xml=await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const xfs=styles.match(/<cellXfs\b[^>]*count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/)!;
  const formats=xfs[2].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)??[];expect(formats).toHaveLength(Number(xfs[1]));
  const cellFormat=(address:string)=>{const tag=xml.match(new RegExp('<c\\b[^>]*\\br="'+address+'"[^>]*>'))?.[0];expect(tag,address).toBeTruthy();return formats[Number(tag!.match(/\bs="(\d+)"/)?.[1]??0)];};
  // Inspect the real cell -> XF binding: SheetJS CE's reader does not expose horizontal alignment.
  for(const row of [3,5])for(const [column,alignment] of [['A','right'],['B',textAlign],['C',dateAlign],['D',numberAlign]]){
   expect(cellFormat(column+row),column+row).toContain('applyAlignment="1"');expect(cellFormat(column+row),column+row).toContain('horizontal="'+alignment+'"');
  }
  for(const address of ['D7','D9'])expect(cellFormat(address),address).toContain('horizontal="'+numberAlign+'"');
  for(const address of ['A1','A2'])expect(cellFormat(address),address).not.toContain('<alignment');
  const book=XLSX.read(output.bytes,{type:'array',cellDates:true,cellNF:true}),sheet=book.Sheets[book.SheetNames[0]];
  expect(sheet.A5).toMatchObject({t:'s',v:'=HYPERLINK("https://example.test")'});expect(sheet.A5.f).toBeUndefined();expect(sheet.B5).toMatchObject({t:'s',v:'00000'});
  expect(sheet.C5.t).toBe('d');expect((sheet.C5.v as Date).toISOString()).toBe('2024-01-02T00:00:00.000Z');expect(sheet.C5.z).toBe('dd/mm/yyyy');
  for(const address of ['D5','D7','D9'])expect(sheet[address]).toMatchObject({t:'n',v:1200.5,z:'0.000'});
  expect(JSON.stringify(run)).toBe(before);
 });
 it.each(['auto','date','text'] as const)('presents full dates consistently while preserving real Excel values and the explicit %s format',async format=>{
  const definition={...spec,columns:spec.columns.map(column=>column.field===hire.id?{...column,format}:column)};
  const run=runEmployeeMasterProjection(definition,fields,[subjects[0]],spec.asAt);
  const before=JSON.stringify(run);
  const output=await serializeEmployeeMaster(run,definition,fields,'Date presentation','xlsx');
  const book=XLSX.read(output.bytes,{type:'array',cellDates:true,cellNF:true}),sheet=book.Sheets[book.SheetNames[0]];
  const expected=format==='text'?'2024-01-02':'02/01/2024';
  if(format==='text')expect(sheet.C4).toMatchObject({t:'s',v:'2024-01-02'});
  else{expect(sheet.C4.t).toBe('d');expect((sheet.C4.v as Date).toISOString()).toBe('2024-01-02T00:00:00.000Z');expect(sheet.C4.z).toBe('dd/mm/yyyy');expect(sheet.C4.w).toBe(expected);}
  const csv=await serializeEmployeeMaster(run,definition,fields,'Date presentation','csv');
  const csvText=Buffer.from(csv.bytes).toString('utf8');expect(csvText).toContain('"'+expected+'"');
  expect(csvText).toContain('"00000"');expect(csvText).toContain('"\'=HYPERLINK');expect(sheet.B4.f).toBeUndefined();expect(sheet.D4).toMatchObject({t:'n',v:1200.5});
  const pdf=await PDFDocument.load((await serializeEmployeeMaster(run,definition,fields,'Date presentation','pdf')).bytes);
  const streams=pdf.context.enumerateIndirectObjects().flatMap(([,object])=>object instanceof PDFRawStream?[Buffer.from(decodePDFRawStream(object).decode()).toString('latin1')]:[]).join('\n');
  // These date digits use the actual Helvetica text drawing operators, not document metadata.
  expect(streams.toUpperCase()).toContain('<'+Buffer.from(expected,'latin1').toString('hex').toUpperCase()+'> TJ');
  expect(JSON.stringify(run)).toBe(before); // Rendering must never rewrite the typed owner snapshot.
 });
 it('writes every matching row as real XLSX, preserving leading-zero strings, actual dates/numbers and freeze panes',async()=>{
  const definition={...spec,columns:spec.columns.map((column,index)=>({...column,freeze:index===0}))},output=await serializeEmployeeMaster(runEmployeeMasterProjection(definition,fields,subjects,spec.asAt),definition,fields,'Master export','xlsx');
  const book=XLSX.read(output.bytes,{type:'array',cellDates:true}),sheet=book.Sheets[book.SheetNames[0]];
  expect(sheet.A4).toMatchObject({t:'s',v:'00000'});expect(sheet.B4).toMatchObject({t:'s',v:'=HYPERLINK("https://example.test")'});expect(sheet.B4.f).toBeUndefined();
  expect(sheet.C4.t).toBe('d');expect((sheet.C4.v as Date).toISOString().slice(0,10)).toBe('2024-01-02');expect(sheet.D4).toMatchObject({t:'n',v:1200.5});
  expect(XLSX.utils.decode_range(sheet['!ref']!).e.r).toBe(63);expect(sheet['!autofilter']?.ref).toBe('A3:D64');
  const zip=await JSZip.loadAsync(output.bytes),xml=await zip.file('xl/worksheets/sheet1.xml')!.async('string');expect(xml).toContain('xSplit="1" ySplit="3"');
 });
 it('preserves month-only Qualification values without manufacturing a day in Excel',async()=>{
  const month=field('qualification','fromYm'),definition={...spec,columns:[defaultMasterColumn(code),defaultMasterColumn(month)]};
  const person={...subjects[0],owners:{...subjects[0].owners,qualification:[{id:'qualification-1',values:{fromYm:{value:'2023-09'}}}]}};
  const output=await serializeEmployeeMaster(runEmployeeMasterProjection(definition,[code,month],[person],spec.asAt),definition,[code,month],'Month precision','xlsx');
  const book=XLSX.read(output.bytes,{type:'array',cellDates:true});expect(book.Sheets[book.SheetNames[0]].B4).toMatchObject({t:'s',v:'2023-09'});
  const csv=await serializeEmployeeMaster(runEmployeeMasterProjection(definition,[code,month],[person],spec.asAt),definition,[code,month],'Month precision','csv');expect(Buffer.from(csv.bytes).toString('utf8')).toContain('"2023-09"');
 });
 it('keeps instant precision in Kuala Lumpur and real Excel dates while leaving qualification months as text',async()=>{
  const stamp=field('document','createdAt'),month=field('qualification','fromYm'),selected=[code,stamp,month],definition={...spec,columns:selected.map(defaultMasterColumn)};
  const person={...subjects[0],owners:{...subjects[0].owners,document:[{id:'document',values:{createdAt:{value:'2024-01-01T18:03:00.000Z',display:'Legacy presentation must not override the chosen date format'}}}],qualification:[{id:'qualification',values:{fromYm:{value:'2023-09'}}}]}};
  const run=runEmployeeMasterProjection(definition,selected,[person],spec.asAt),output=await serializeEmployeeMaster(run,definition,selected,'Date precision','xlsx');
  const book=XLSX.read(output.bytes,{type:'array',cellDates:true,cellNF:true}),sheet=book.Sheets[book.SheetNames[0]];
  expect(sheet.B4.t).toBe('d');expect((sheet.B4.v as Date).toISOString()).toBe('2024-01-02T02:03:00.000Z');expect(sheet.B4.z).toBe('dd/mm/yyyy hh:mm');
  expect(sheet.C4).toMatchObject({t:'s',v:'2023-09'});
  const csv=await serializeEmployeeMaster(run,definition,selected,'Date precision','csv');expect(Buffer.from(csv.bytes).toString('utf8')).toContain('"02/01/2024 02:03 MYT"');
  const textDefinition={...definition,columns:definition.columns.map(column=>column.field===stamp.id?{...column,format:'text' as const}:column)};
  const text=await serializeEmployeeMaster(runEmployeeMasterProjection(textDefinition,selected,[person],spec.asAt),textDefinition,selected,'Date precision','xlsx'),textBook=XLSX.read(text.bytes,{type:'array',cellDates:true});
  expect(textBook.Sheets[textBook.SheetNames[0]].B4).toMatchObject({t:'s',v:'2024-01-01T18:03:00.000Z'});
 });
 it('carries unavailable historical-scope notices in Excel notes and a CSV companion file',async()=>{
  const incomplete={...result(),unknownScopeCount:2,historyScopeUnavailable:true};
  const workbook=XLSX.read((await serializeEmployeeMaster(incomplete,spec,fields,'Incomplete history','xlsx')).bytes,{type:'array'});expect(workbook.SheetNames).toContain('Report notes');expect(JSON.stringify(workbook.Sheets['Report notes'])).toContain('2 currently visible employments excluded');
  const output=await serializeEmployeeMaster(incomplete,spec,fields,'Incomplete history','csv');expect(output.ext).toBe('zip');const zip=await JSZip.loadAsync(output.bytes);expect(await zip.file('Report-notes.txt')!.async('string')).toContain('dated company membership');expect(Object.keys(zip.files).filter(name=>name.endsWith('.csv'))).toHaveLength(1);
 });
 it('marks scheduled Movement intentions in CSV/PDF text and XLSX comments while preserving real numeric zero',async()=>{
  const reason=field('movement','terminationReasonCode'),notice=field('movement','noticeServedDays'),selected=[reason,notice],definition={...spec,columns:selected.map(defaultMasterColumn)};
  const people:MasterSubject[]=[{...subjects[0],owners:{movement:[{id:'scheduled-exit',effectiveFrom:spec.asAt,values:{terminationReasonCode:{value:'resignation',recordedKind:'intent'},noticeServedDays:{value:0,recordedKind:'intent'}}}]}}];
  const run=runEmployeeMasterProjection(definition,selected,people,spec.asAt),xlsx=await serializeEmployeeMaster(run,definition,selected,'Recorded intent','xlsx');
  const book=XLSX.read(xlsx.bytes,{type:'array'}),sheet=book.Sheets[book.SheetNames[0]];
  expect(sheet.A4.v).toContain('recorded intent');expect(sheet.B4).toMatchObject({t:'n',v:0});expect(sheet.B4.c?.[0].t).toContain('does not prove');expect(book.SheetNames).toContain('Report notes');
  const output=await serializeEmployeeMaster(run,definition,selected,'Recorded intent','csv');expect(output.ext).toBe('zip');
  const zip=await JSZip.loadAsync(output.bytes),csvName=Object.keys(zip.files).find(name=>name.endsWith('.csv'))!;
  expect(await zip.file(csvName)!.async('string')).toContain('0 (recorded intent)');expect(await zip.file('Report-notes.txt')!.async('string')).toContain('do not prove the change was applied');
 });
 it('neutralizes formula-looking CSV strings while keeping actual numeric measures and all rows',async()=>{
  const output=await serializeEmployeeMaster(result(),spec,fields,'Master export','csv'),text=Buffer.from(output.bytes).toString('utf8');
  expect(text).toContain('"\'=HYPERLINK');expect(text).toContain('"00000"');expect(text).toContain('"1200.50"');expect(text.split('\r\n')).toHaveLength(62);
 });
 it('keeps unrelated All registers in separate workbook sheets and CSV files',async()=>{
  const dependent=field('dependent','fullName'),document=field('document','title'),definition={...spec,columns:[defaultMasterColumn(code),{...defaultMasterColumn(dependent),records:'all' as const},{...defaultMasterColumn(document),records:'all' as const}]};
  const people=[{...subjects[0],owners:{...subjects[0].owners,dependent:[{id:'child-1',values:{fullName:{value:'Child A'}}},{id:'child-2',values:{fullName:{value:'Child B'}}}],document:[{id:'doc-1',values:{title:{value:'Letter'}}}]}}];
  const scoped=[code,dependent,document],run=runEmployeeMasterProjection(definition,scoped,people,spec.asAt),output=await serializeEmployeeMaster(run,definition,scoped,'Registers','csv');
  expect(run.totalRows).toBe(3);expect(output.ext).toBe('zip');const zip=await JSZip.loadAsync(output.bytes);expect(Object.keys(zip.files)).toHaveLength(2);
  const workbook=XLSX.read((await serializeEmployeeMaster(run,definition,scoped,'Registers','xlsx')).bytes,{type:'array'});expect(workbook.SheetNames).toHaveLength(2);
 });
 it('produces a paginated PDF retaining supported Unicode names',async()=>{
  const output=await serializeEmployeeMaster(result(),spec,fields,'Master export','pdf'),pdf=await PDFDocument.load(output.bytes);expect(pdf.getPageCount()).toBeGreaterThan(1);
 });
});
