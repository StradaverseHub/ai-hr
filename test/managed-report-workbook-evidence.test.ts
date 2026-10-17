/** Actual registry -> projection -> XLSX exporter -> acceptance contract; no database/runtime. */
import {describe,it,expect} from 'vitest';
import * as XLSX from 'xlsx';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {defaultMasterColumn,runEmployeeMasterProjection,type EmployeeMasterSpec,type MasterSubject} from '../lib/employee-master-report';
import {serializeEmployeeMaster} from '../lib/employee-master-export';
import {assertManagedReportWorkbook,type ManagedReportWorkbookExpectation} from '../scripts/managed-report-workbook-evidence';
const code=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!,name=PERSONNEL_FIELDS.find(field=>field.owner==='person'&&field.ownerField==='fullName')!;
const expected:ManagedReportWorkbookExpectation={title:'Managed receipt',asAt:'2026-10-17',columns:[code,name].map(defaultMasterColumn),fields:PERSONNEL_FIELDS,rows:[{code:'REPORT-OWNER',fullName:'Fictional owner'},{code:'REPORT-RECIPIENT',fullName:'Fictional recipient'}]};
async function workbook(){
 const spec:EmployeeMasterSpec={v:2,asAt:expected.asAt,companyIds:['00000000-0000-4000-8000-000000000001'],includeDrafts:false,columns:[...expected.columns],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}};
 const subjects:MasterSubject[]=expected.rows.map((row,index)=>({id:'employment-'+index,personId:'person-'+index,companyId:spec.companyIds[0],kind:'employment',owners:{employment:[{id:'employment-'+index,values:{employeeCode:{value:row.code}}}],person:[{id:'person-'+index,values:{fullName:{value:row.fullName}}}]}}));
 const result=runEmployeeMasterProjection(spec,PERSONNEL_FIELDS,subjects,spec.asAt),output=await serializeEmployeeMaster(result,spec,PERSONNEL_FIELDS,expected.title,'xlsx');
 return XLSX.read(output.bytes,{type:'array'});
}
describe('managed report exact selected workbook evidence',()=>{
 it('accepts the real exported canonical name caption containing passport without accepting an extra identity field',async()=>{
  const book=await workbook();expect(name.label).toBe('Full name (as per IC/passport)');expect(book.Sheets[book.SheetNames[0]].B3.v).toBe(name.label);expect(()=>assertManagedReportWorkbook(book,expected)).not.toThrow();
 });
 it('accepts both exact fictional rows in either order',async()=>{
  const book=await workbook(),sheet=book.Sheets[book.SheetNames[0]];[sheet.A4,sheet.A5]=[sheet.A5,sheet.A4];[sheet.B4,sheet.B5]=[sheet.B5,sheet.B4];expect(()=>assertManagedReportWorkbook(book,expected)).not.toThrow();
 });
 it.each(['Salary','Passport number','Bank account'])('refuses an extra unselected %s column',async label=>{
  const book=await workbook(),sheet=book.Sheets[book.SheetNames[0]];sheet.C3={t:'s',v:label};sheet.C4={t:'s',v:'1234567'};sheet['!ref']='A1:C5';expect(()=>assertManagedReportWorkbook(book,expected)).toThrow();
 });
 it.each(['3500.00','P1234567','000123456789'])('refuses an unexpected data value %s even without a sensitive keyword',async value=>{
  const book=await workbook();book.Sheets[book.SheetNames[0]].B4={t:'s',v:value};expect(()=>assertManagedReportWorkbook(book,expected)).toThrow();
 });
 it('refuses unexpected hidden sheets or cells outside the declared report range',async()=>{
  const extraSheet=await workbook();XLSX.utils.book_append_sheet(extraSheet,XLSX.utils.aoa_to_sheet([['000123456789']]),'Extra');extraSheet.Workbook={Sheets:extraSheet.SheetNames.map((_,index)=>({Hidden:(index?2:0) as 0|2}))};expect(()=>assertManagedReportWorkbook(extraSheet,expected)).toThrow();
  const extraCell=await workbook();extraCell.Sheets[extraCell.SheetNames[0]].Z99={t:'s',v:'000123456789'};expect(()=>assertManagedReportWorkbook(extraCell,expected)).toThrow();
 });
 it('refuses a formula, duplicate subject, wrong header or unreviewed metadata',async()=>{
  for(const mutate of [(sheet:XLSX.WorkSheet)=>{sheet.B4.f='1+1';},(sheet:XLSX.WorkSheet)=>{sheet.A5={t:'s',v:'REPORT-OWNER'};},(sheet:XLSX.WorkSheet)=>{sheet.B3={t:'s',v:'Other'};},(sheet:XLSX.WorkSheet)=>{sheet.A1={t:'s',v:'Other title'};}]){const book=await workbook();mutate(book.Sheets[book.SheetNames[0]]);expect(()=>assertManagedReportWorkbook(book,expected)).toThrow();}
 });
});
