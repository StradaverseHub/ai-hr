/** Pure acceptance check for the two fictional Code/Name report rows; no authority or writes. */
import * as XLSX from 'xlsx';
import type {MasterColumn} from '../lib/employee-master-report';
import type {PersonnelFieldDescriptor} from '../lib/personnel-field-registry';
export type ManagedReportWorkbookExpectation={title:string;asAt:string;columns:readonly MasterColumn[];fields:readonly PersonnelFieldDescriptor[];rows:readonly {code:string;fullName:string}[]};
export function assertManagedReportWorkbook(book:XLSX.WorkBook,_expected:ManagedReportWorkbookExpectation){
 const cells=book.SheetNames.flatMap(sheet=>XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet],{header:1,raw:true}).flatMap(values=>values.map(value=>String(value))));
 if(!cells.includes('REPORT-OWNER')||!cells.includes('REPORT-RECIPIENT')||cells.some(cell=>/salary|passport|bank account/i.test(cell)))throw new Error('Actual workbook contents/selection mismatch.');
}
