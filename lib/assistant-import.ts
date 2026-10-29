/** Draft extraction only. Canonical importers own validation, authority and every write. */
import {z} from 'zod';
import {EMPLOYEE_TEMPLATE_COLUMNS} from './import-schema';
import {LEAVE_HISTORY_COLUMNS} from './leave-history-import-schema';
import {LEAVE_BF_COLUMNS} from './leave-bf-import-schema';
import {PAYROLL_HISTORY_COLUMNS} from './payroll-history-import-schema';
import {FIXED_TXN_COLUMNS,INDIVIDUAL_TXN_COLUMNS} from './payroll-txn-import-schema';

export const IMPORT_TARGETS = ['employee','leave_history','leave_bf','payroll_history','payroll_fixed','payroll_individual'] as const;
export type AssistantImportTarget = typeof IMPORT_TARGETS[number];
export const IMPORT_DESTINATIONS:Record<AssistantImportTarget,string> = {
 employee:'/admin/personnel/import',leave_history:'/admin/leave-config/history-import',leave_bf:'/admin/leave-config/bf-import',
 payroll_history:'/payroll/history-import',payroll_fixed:'/payroll/transactions/fixed',payroll_individual:'/payroll/transactions/individual',
};
export function assistantImportColumns(target:AssistantImportTarget):readonly string[]{
 switch(target){
  case 'employee':return [...EMPLOYEE_TEMPLATE_COLUMNS.required,...EMPLOYEE_TEMPLATE_COLUMNS.optional];
  case 'leave_history':return LEAVE_HISTORY_COLUMNS.map(c=>c.key);
  case 'leave_bf':return LEAVE_BF_COLUMNS.map(c=>c.key);
  case 'payroll_history':return PAYROLL_HISTORY_COLUMNS.required;
  case 'payroll_fixed':return FIXED_TXN_COLUMNS;
  case 'payroll_individual':return INDIVIDUAL_TXN_COLUMNS;
 }
}
export const AssistantImportRequest=z.object({target:z.enum(IMPORT_TARGETS),source:z.string().min(1).max(48000),instruction:z.string().trim().min(1).max(2000),consent:z.literal(true)}).strict();
const Span=z.object({field:z.string().max(80),from:z.enum(['source','instruction']).default('source'),start:z.number().int().min(0),end:z.number().int().min(1)}).strict();
const Extraction=z.object({rows:z.array(z.object({cells:z.array(Span).min(1).max(128)}).strict()).min(1).max(200)}).strict();
export type ImportDraft={columns:string[];rows:string[][];spans:{field:string;from?:'source'|'instruction';start:number;end:number}[][]};
/** Models select existing source spans. They cannot supply or calculate a replacement value. */
export function captureImportDraft(target:AssistantImportTarget,source:string,value:unknown,instruction=''):ImportDraft{
 const parsed=Extraction.parse(value),columns=[...assistantImportColumns(target)],allowed=new Set(columns);
 const records=new Set<string>();
 const rows=parsed.rows.map(row=>{
  const fingerprint=JSON.stringify([...row.cells].sort((a,b)=>a.field.localeCompare(b.field)));
  if(records.has(fingerprint))throw Error('Repeated source record');records.add(fingerprint);
  const seen=new Set<string>(),values=new Map<string,string>();
  for(const cell of row.cells){
   const origin=cell.from==='instruction'?instruction:source;
   if(!allowed.has(cell.field)||seen.has(cell.field)||cell.end<=cell.start||cell.end>origin.length||cell.end-cell.start>2000)throw Error('Invalid source span');
   const text=origin.slice(cell.start,cell.end).trim();if(!text)throw Error('Empty source span');
   seen.add(cell.field);values.set(cell.field,text);
  }
  return columns.map(column=>values.get(column)??'');
 });
 return {columns,rows,spans:parsed.rows.map(row=>row.cells)};
}
export function importDraftCsv(draft:Pick<ImportDraft,'columns'|'rows'>):string{
 if(!draft.rows.length||draft.rows.some(row=>row.length!==draft.columns.length))throw Error('Invalid draft');
 // Import transport, not spreadsheet export: preserve signed amounts and literal identifiers.
 const cell=(value:string)=>/[",\r\n]/.test(value)?'"'+value.replace(/"/g,'""')+'"':value;
 return [draft.columns,...draft.rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
