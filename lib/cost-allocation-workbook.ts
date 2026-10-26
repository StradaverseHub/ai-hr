import {ALLOCATION_COLUMNS,ALLOCATION_SHEET} from './employment-cost-allocation';
import {toCsv} from './csv';
export type AllocationReference={companyId:string;id:string;code:string;label:string|null};
export const allocationCsvTemplate=()=>toCsv([[...ALLOCATION_COLUMNS]]);
/** Codes alone are accepted as references; descriptions never serve as an unverified foreign key. */
export function allocationWorkbookSheets(reference:AllocationReference[],instructions:string){return[
 {name:ALLOCATION_SHEET,rows:[[...ALLOCATION_COLUMNS]],textColumns:[0,1,2,3,4,5],columnWidths:[38,22,18,18,25,18],wrapText:true,validationLists:[{column:3,values:['replace','clear']},{column:4,values:[...new Set(reference.map(r=>r.code))]}]},
 {name:'Allocation Codes',rows:[['company_id','cost_center_code','description'],...reference.map(r=>[r.companyId,r.code,r.label??''])],textColumns:[0,1,2],columnWidths:[38,25,45],wrapText:true},
 {name:'Allocation Instructions',rows:[[instructions]],columnWidths:[110],wrapText:true},
];}
