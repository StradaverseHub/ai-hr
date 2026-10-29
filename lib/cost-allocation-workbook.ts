import {ALLOCATION_CAPTIONS,ALLOCATION_COLUMNS,ALLOCATION_INSTRUCTIONS_SHEET,ALLOCATION_REFERENCE_SHEET,ALLOCATION_SHEET} from './employment-cost-allocation';
/** Every company the actor may import for, by the Company Code the parser resolves. */
export type AllocationCompanyReference={code:string;name:string};
export type AllocationReference={companyCode:string;code:string;label:string|null};
export type AllocationWorkbookReferences={companies:AllocationCompanyReference[];costCenters:AllocationReference[]};
export const allocationHeaderRow=()=>ALLOCATION_COLUMNS.map(column=>ALLOCATION_CAPTIONS[column]);
/** One template for every company (c4055300). Codes alone are accepted; descriptions are reference text. */
export function allocationWorkbookSheets(references:AllocationWorkbookReferences,instructions:string){
 const referenceRows:string[][]=[];
 for(const company of references.companies){
  const codes=references.costCenters.filter(c=>c.companyCode===company.code);
  if(!codes.length)referenceRows.push([company.code,company.name,'','']);
  for(const code of codes)referenceRows.push([company.code,company.name,code.code,code.label??'']);
 }
 return[
  {name:ALLOCATION_SHEET,rows:[allocationHeaderRow()],textColumns:[0,1,2,3,4,5],columnWidths:[20,18,16,14,22,14],wrapText:true,validationLists:[{column:0,values:[...new Set(references.companies.map(c=>c.code))]},{column:3,values:['Replace','Clear']},{column:4,values:[...new Set(references.costCenters.map(r=>r.code))]}]},
  {name:ALLOCATION_REFERENCE_SHEET,rows:[['Company Code','Company','Cost Center Code','Cost Center Description'],...referenceRows],textColumns:[0,1,2,3],columnWidths:[20,40,22,45],wrapText:true},
  {name:ALLOCATION_INSTRUCTIONS_SHEET,rows:[[instructions]],columnWidths:[110],wrapText:true},
 ];
}
