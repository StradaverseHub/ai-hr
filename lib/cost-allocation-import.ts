import {parseCsvRecords} from './csv';
import {ALLOCATION_COLUMNS} from './employment-cost-allocation';
export type AllocationImportRecords=Record<string,string>[];
export type AllocationImportGroup={key:string;companyId:string;employeeCode:string;effectiveDate:string;operation:'replace'|'clear';rows:{costCenterId:string;percentage:string}[];rowNums:number[];displayRows?:{code:string;percentage:string}[];errors:string[];employmentId?:string;expectedRevision:number;newEmployeeIndex?:number};
export type AllocationImportPreview={groups:AllocationImportGroup[];token:string;validCount:number};
export function parseCostAllocationCsv(text:string):AllocationImportRecords{
 if(BufferSafeBytes(text)>900000)throw new Error('Allocation file exceeds the supported size.');
 if(!text.trim())return[];const{records,headers}=parseCsvRecords(text);
 const missing=ALLOCATION_COLUMNS.filter(c=>!headers.includes(c));if(missing.length)throw new Error(`Missing allocation columns: ${missing.join(', ')}`);
 const unknown=headers.filter(c=>!(ALLOCATION_COLUMNS as readonly string[]).includes(c));if(unknown.length)throw new Error(`Unexpected allocation columns: ${unknown.join(', ')}`);
 if(records.length>5000)throw new Error('Use at most 5000 allocation rows per file.');return records;
}
function BufferSafeBytes(text:string){return new TextEncoder().encode(text).byteLength;}
export const allocationBindingKey=(companyId:string,employeeCode:string)=>`${companyId}|${employeeCode.trim()}`;
