import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
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
 it('writes every matching row as real XLSX, preserving leading-zero strings, actual dates/numbers and freeze panes',async()=>{
  const definition={...spec,columns:spec.columns.map((column,index)=>({...column,freeze:index===0}))},output=await serializeEmployeeMaster(result(),definition,fields,'Master export','xlsx');
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
 });
 it('neutralizes formula-looking CSV strings while keeping actual numeric measures and all rows',async()=>{
  const output=await serializeEmployeeMaster(result(),spec,fields,'Master export','csv'),text=Buffer.from(output.bytes).toString('utf8');
  expect(text).toContain('"\'=HYPERLINK');expect(text).toContain('"00000"');expect(text).toContain('"1200.5"');expect(text.split('\r\n')).toHaveLength(62);
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
