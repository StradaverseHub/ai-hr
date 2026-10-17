/** Pure acceptance check for the two fictional Code/Name report rows; no authority or writes. */
import * as XLSX from 'xlsx';
import type {MasterColumn} from '../lib/employee-master-report';
import type {PersonnelFieldDescriptor} from '../lib/personnel-field-registry';
export type ManagedReportWorkbookExpectation={title:string;asAt:string;columns:readonly MasterColumn[];fields:readonly PersonnelFieldDescriptor[];rows:readonly {code:string;fullName:string}[]};
function requireEvidence(value:unknown):asserts value{if(!value)throw new Error('Actual workbook contents/selection mismatch.');}
export function assertManagedReportWorkbook(book:XLSX.WorkBook,expected:ManagedReportWorkbookExpectation){
 requireEvidence(expected.columns.length===2&&expected.rows.length===2&&book.SheetNames.length===1);
 const selected=expected.columns.map(column=>expected.fields.find(field=>field.id===column.field));
 const codeIndex=selected.findIndex(field=>field?.owner==='employment'&&field.ownerField==='employeeCode'),nameIndex=selected.findIndex(field=>field?.owner==='person'&&field.ownerField==='fullName');
 requireEvidence(codeIndex>=0&&nameIndex>=0&&codeIndex!==nameIndex);
 const names=new Map(expected.rows.map(row=>[row.code,row.fullName]));
 requireEvidence(names.size===2&&names.has('REPORT-OWNER')&&names.has('REPORT-RECIPIENT')&&[...names.values()].every(value=>typeof value==='string'&&value.length>0));
 const sheet=book.Sheets[book.SheetNames[0]];requireEvidence(sheet&&sheet['!ref']==='A1:B5');
 requireEvidence(!book.Workbook?.Sheets?.some(sheet=>Boolean(sheet.Hidden)));
 const headers=expected.columns.map((column,index)=>column.header?.trim()||(column.side==='before'?'Before: ':'')+selected[index]!.label);
 const fixed:Record<string,string>={A1:expected.title,A2:'As at '+expected.asAt+' · 2 employments · 2 people · 0 drafts · 2 rows',A3:headers[0],B3:headers[1]};
 const allowed=new Set([...Object.keys(fixed),'A4','B4','A5','B5']);
 for(const [address,cell]of Object.entries(sheet)){
  if(address.startsWith('!'))continue;
  requireEvidence(allowed.has(address)&&cell&&cell.t==='s'&&typeof cell.v==='string'&&!cell.f&&!cell.l&&!cell.c?.length);
 }
 for(const [address,value]of Object.entries(fixed))requireEvidence(sheet[address]?.v===value);
 const seen=new Set<string>();
 for(const row of [4,5]){
  const values=[sheet['A'+row]?.v,sheet['B'+row]?.v],code=values[codeIndex],fullName=values[nameIndex];
  requireEvidence(typeof code==='string'&&!seen.has(code)&&names.has(code)&&fullName===names.get(code));seen.add(code);
 }
 requireEvidence(seen.size===2);
}
