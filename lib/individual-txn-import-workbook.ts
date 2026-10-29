import {buildXlsx} from './spreadsheet';
import {INDIVIDUAL_IMPORT_HEADERS,INDIVIDUAL_IMPORT_SHEET,type IndividualImportMethod} from './payroll-txn-import-schema';
import type {TxnTemplateReference} from './import-template-xlsx';
export type IndividualImportCycleReference={name:string;company:string;code:string};
export async function buildIndividualTxnWorkbook(method:IndividualImportMethod,ref:TxnTemplateReference,cycles:IndividualImportCycleReference[],instructions:string){
 return buildXlsx([...INDIVIDUAL_IMPORT_HEADERS[method]],[],{sheetName:INDIVIDUAL_IMPORT_SHEET[method],textColumns:[0,2,3,4],extraSheets:[
  {name:'Instructions',rows:[[instructions]]},
  {name:'Employees',rows:[[ref.headings.employeeId,ref.headings.employeeName,ref.headings.company],...ref.employees.map(e=>[e.code,e.name,e.company])]},
  {name:'Pay Items',rows:[[ref.headings.payItemCode,ref.headings.payItemName,ref.headings.payItemInput],...ref.payItems.map(c=>[c.code,c.name,c.input])]},
  {name:'Pay Cycles',rows:[[ref.headings.company,ref.headings.cycleCode,ref.headings.cycleLabel],...cycles.map(c=>[c.company,c.code,c.name])]},
  {name:'Input Types',rows:[['amount'],['qty'],['hours'],['days'],['units']]},
 ]});
}
