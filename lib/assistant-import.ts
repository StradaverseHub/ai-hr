/** Draft extraction only. Canonical importers own validation, authority and every write. */
import {z} from 'zod';
import {EMPLOYEE_TEMPLATE_COLUMNS} from './import-schema';
import {LEAVE_HISTORY_COLUMNS} from './leave-history-import-schema';
import {LEAVE_BF_COLUMNS} from './leave-bf-import-schema';
import {PAYROLL_HISTORY_COLUMNS} from './payroll-history-import-schema';
import {FIXED_TXN_COLUMNS,INDIVIDUAL_TXN_COLUMNS} from './payroll-txn-import-schema';
import {parseCsv} from './csv';

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
export const AssistantImportRequest=z.object({target:z.enum(IMPORT_TARGETS),source:z.string().min(1).max(48000),sourceKind:z.enum(['text','table']).default('text'),instruction:z.string().trim().min(1).max(2000),consent:z.literal(true)}).strict();
const Span=z.object({field:z.string().max(80),from:z.enum(['source','instruction']).default('source'),start:z.number().int().min(0),end:z.number().int().min(1)}).strict();
const Cell=z.object({field:z.string().max(80),cellId:z.string().regex(/^r[1-9]\d{0,4}c[1-9]\d{0,3}$/)}).strict();
const Quote=z.object({field:z.string().max(80),from:z.enum(['source','instruction']).default('source'),quote:z.string().min(1).max(2000),occurrence:z.number().int().min(1).max(200).default(1)}).strict();
const Selection=z.union([Cell,Quote,Span]);
const Extraction=z.object({rows:z.array(z.object({cells:z.array(Selection).min(1).max(128)}).strict()).min(1).max(200)}).strict();
export type ImportDraft={columns:string[];rows:string[][];spans:z.infer<typeof Selection>[][]};
export function assistantImportSourceRows(source:string){return parseCsv(source).map((cells,index)=>({row:index+1,cells}));}
/** Models select whole spreadsheet cells or exact source/request quotes. Never replacement values. */
export function captureImportDraft(target:AssistantImportTarget,source:string,value:unknown,instruction='',sourceKind:'text'|'table'='text'):ImportDraft{
 const parsed=Extraction.parse(value),columns=[...assistantImportColumns(target)],allowed=new Set(columns);
 const matrix=sourceKind==='table'?parseCsv(source):null;
 const records=new Set<string>();
 const rows=parsed.rows.map(row=>{
  const fingerprint=JSON.stringify([...row.cells].sort((a,b)=>a.field.localeCompare(b.field)));
  if(records.has(fingerprint))throw Error('Repeated source record');records.add(fingerprint);
  const seen=new Set<string>(),values=new Map<string,string>();
  for(const cell of row.cells){
   if(!allowed.has(cell.field)||seen.has(cell.field))throw Error('Invalid field');
   let text:string;
   if('cellId' in cell){
    if(!matrix)throw Error('Unexpected cell selector');
    const indexes=/^r(\d+)c(\d+)$/.exec(cell.cellId)!;
    text=matrix[Number(indexes[1])-1]?.[Number(indexes[2])-1]??'';
   }else{
    if(sourceKind==='table'&&cell.from==='source')throw Error('A table needs whole-cell evidence');
    const origin=cell.from==='instruction'?instruction:source;
    if('quote' in cell){
     let offset=-1;
     for(let n=0;n<cell.occurrence;n++){offset=origin.indexOf(cell.quote,offset+1);if(offset<0)throw Error('Quote absent from source');}
     text=origin.slice(offset,offset+cell.quote.length);
    }else{
     if(cell.end<=cell.start||cell.end>origin.length||cell.end-cell.start>2000)throw Error('Invalid source span');
     text=origin.slice(cell.start,cell.end);
    }
   }
   text=text.trim();if(!text||text.length>2000)throw Error('Empty or oversized source value');
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
