import {normalizeEmployeeCode} from './employee-code';
import {parseCsvRecords} from './csv';
import {ALLOCATION_COLUMNS,type AllocationColumn} from './employment-cost-allocation';
import type {ImportPlanBase} from './import-history';
export type AllocationImportRecords=Record<string,string>[];
export type AllocationImportGroup={key:string;companyCode:string;companyId:string;companyName?:string;employeeCode:string;effectiveDate:string;operation:'replace'|'clear';rows:{costCenterId:string;percentage:string}[];rowNums:number[];displayRows?:{code:string;percentage:string}[];errors:string[];employmentId?:string;expectedRevision:number;newEmployeeIndex?:number};
export type AllocationImportPreview={groups:AllocationImportGroup[];token:string;validCount:number};
/** The stored plan of a Cost Center Allocation import attempt (import history kind cost_allocations). */
export type CostAllocationImportPlan=ImportPlanBase&{kind:'cost_allocations';token:string;groups:AllocationImportGroup[]};
export class AllocationFileError extends Error{constructor(message:string){super(message);this.name='AllocationFileError';}}
export const LEGACY_ALLOCATION_LAYOUT_MESSAGE='This file uses the old layout with an internal company identifier (company_id). Download the new template and fill in the Company Code column instead.';
/** Header aliases after parseCsvRecords normalisation (lower case, spaces to underscores). */
const HEADER_ALIASES:Record<string,AllocationColumn>={company_code:'company_code',employee_code:'employee_code',employee_id:'employee_code',effective_date:'effective_date',operation:'operation',cost_center_code:'cost_center_code',cost_centre_code:'cost_center_code',percentage:'percentage'};
const canonicalHeader=(header:string)=>HEADER_ALIASES[header.replace(/[-_]+/g,'_').replace(/^_|_$/g,'')]??header;
export function parseCostAllocationCsv(text:string):AllocationImportRecords{
 if(BufferSafeBytes(text)>900000)throw new AllocationFileError('Allocation file exceeds the supported size.');
 if(!text.trim())return[];const{records,headers:raw}=parseCsvRecords(text);
 if(raw.some(h=>h==='company_id'||h==='companyid'))throw new AllocationFileError(LEGACY_ALLOCATION_LAYOUT_MESSAGE);
 const headers=raw.map(canonicalHeader);
 if(new Set(headers).size!==headers.length)throw new AllocationFileError('Duplicate allocation column headers are not allowed.');
 const missing=ALLOCATION_COLUMNS.filter(c=>!headers.includes(c));if(missing.length)throw new AllocationFileError(`Missing allocation columns: ${missing.join(', ')}`);
 const unknown=raw.filter((_,i)=>!(ALLOCATION_COLUMNS as readonly string[]).includes(headers[i]));if(unknown.length)throw new AllocationFileError(`Unexpected allocation columns: ${unknown.join(', ')}`);
 if(records.length>5000)throw new AllocationFileError('Use at most 5000 allocation rows per file.');
 return records.map(record=>{const out:Record<string,string>={};raw.forEach((h,i)=>{out[headers[i]]=record[h]??'';});out.employee_code=normalizeEmployeeCode(out.employee_code);out.operation=(out.operation??'').trim().toLowerCase();return out;});
}
function BufferSafeBytes(text:string){return new TextEncoder().encode(text).byteLength;}
export const allocationBindingKey=(companyId:string,employeeCode:string)=>`${companyId.trim()}|${normalizeEmployeeCode(employeeCode)}`;
/** Company Code matching key: case and surrounding space insensitive. */
export const companyCodeKey=(value:string|null|undefined)=>(value??'').trim().toUpperCase();
