import {PayrollHistoryRevisionError} from '../lib/payroll-history-revisions';
/** Reconstruct item ownership from immutable accepted source/revisions; no independent money store. */
import {createHash} from 'node:crypto';
import {asc,inArray,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {payrollHistoryImportRecord as record,payrollHistoryImportRevision as revision,payrollHistoryImportSnapshot as snapshot,payrollHistoryImportAttempt as attempt} from '../db/schema';
import {resolveImportCodes} from './payroll-history-import';
import {readHistoryField,STATUTORY_IMPORT_CODES,type ImportCodeEntry,type PayrollHistoryRecord} from '../lib/payroll-history-import-schema';
import {aggregateHistoryItems,appendHistoryContribution,effectiveHistoryItems,historyMoney,historyMoneyCents,historyItemsMatchValues,type HistoryContributionState,type HistoryOwnedItem} from '../lib/payroll-history-maintenance-lineage';
import type {ImportedPayrollValues} from '../lib/payroll-history-revisions';
function fail(message:string):never{throw new PayrollHistoryRevisionError(message);}
const upper=(value:string)=>value.trim().toUpperCase();
export function maintenanceSourceItems(rows:readonly {rowNum:number;code:string;amount:string}[],codes:ReadonlyMap<string,ImportCodeEntry>):HistoryOwnedItem[]{
 return aggregateHistoryItems(rows.flatMap(row=>{const entry=codes.get(upper(row.code));if(!entry)fail(`Pay Item ${row.code} is archived, unmapped or unavailable. Review its original mapping.`);if(entry.direction==='check')return[];
  const code=entry.targetCode??entry.code,setting=entry.taxSettings as {id?:string}|undefined;
  const monetary=['basic','allowance','overtime','bonus','other_deduction','noncash'].includes(entry.destination);
  const key=entry.destination==='basic'?'destination:basic':monetary?'component:'+(setting?.id??entry.ownerId??fail(`Pay Item ${code} has no exact configured identity.`)):'statutory:'+entry.destination;
  return[{key,code,label:entry.label,originalCodes:[row.code],amount:historyMoney(historyMoneyCents(row.amount)),destination:entry.destination,direction:entry.destination==='noncash'?'noncash' as const:monetary?entry.direction==='deduction'?'deduction' as const:'earning' as const:'statutory' as const,sourceRows:[row.rowNum]}];}));
}
const statutoryKeys:Record<string,string>={epf_employee:'epfEmployee',epf_employer:'epfEmployer',socso_employee:'socsoEmployee',socso_employer:'socsoEmployer',socso_skbbk:'socsoSkbbk',eis_employee:'eisEmployee',eis_employer:'eisEmployer',pcb:'pcb',cp38:'cp38',zakat:'zakat',lp:'lp',hrdf:'hrdf'};
export function maintenanceNativeItems(values:ImportedPayrollValues,codes:ReadonlyMap<string,ImportCodeEntry>):HistoryOwnedItem[]{
 const rows:{rowNum:number;code:string;amount:string}[]=[{rowNum:1,code:'BASIC',amount:values.basicSalary}];
 for(const code of STATUTORY_IMPORT_CODES){const key=statutoryKeys[code.destination];if(key&&values.statutory[key]!==undefined)rows.push({rowNum:rows.length+1,code:code.code,amount:Number(values.statutory[key]).toFixed(2)});}
 const lines=values.statutory.importedLines??values.statutory.componentLines;
 if(Array.isArray(lines))for(const line of lines){if(!line||typeof line.code!=='string'||!Number.isFinite(Number(line.amount)))fail('The native baseline has ambiguous original Pay Item lines.');const entry=codes.get(upper(line.code));if(!entry)fail(`Native Pay Item ${line.code} is unavailable.`);if(entry.destination==='basic')continue;rows.push({rowNum:rows.length+1,code:line.code,amount:Number(line.amount).toFixed(2)});}
 const nc=values.statutory.pcbNonCash as {ownedEaEntries?:{code:string;entered:number}[]}|undefined;
 for(const entry of nc?.ownedEaEntries??[])rows.push({rowNum:rows.length+1,code:entry.code,amount:entry.entered.toFixed(2)});
 const items=maintenanceSourceItems(rows,retainedHistoryCodes(values,codes)),sum=(dest:string)=>items.filter(item=>item.destination===dest).reduce((n,item)=>n+historyMoneyCents(item.amount),BigInt(0));
 for(const [dest,value]of [['allowance',values.allowance],['overtime',values.overtimePay],['bonus',values.bonus],['other_deduction',values.otherDeductions]] as const)if(sum(dest)!==historyMoneyCents(value))fail('The original native Pay Item detail does not reconcile. Its baseline is preserved; item maintenance requires unambiguous source detail.');
 return items.map(item=>({...item,sourceRows:[]}));
}
function retainedHistoryCodes(values:ImportedPayrollValues,codes:ReadonlyMap<string,ImportCodeEntry>):Map<string,ImportCodeEntry>{
 const retained=new Map(codes),lines=values.statutory.importedLines??values.statutory.componentLines;
 if(Array.isArray(lines))for(const line of lines){if(!line||typeof line.code!=='string'||!Array.isArray(line.buckets))continue;const buckets=[...new Set(line.buckets.map((bucket:{bucket?:string})=>bucket.bucket).filter((bucket:unknown)=>['wage','ot','bonus','deduct'].includes(String(bucket))))];if(buckets.length!==1)fail('The original cash item destination is ambiguous.');const current=codes.get(upper(line.code));if(!current)fail(`Original Pay Item ${line.code} is archived or unmapped.`);const destination=buckets[0]==='wage'?'allowance':buckets[0]==='ot'?'overtime':buckets[0]==='bonus'?'bonus':'other_deduction';retained.set(upper(line.code),{...current,destination,direction:destination==='other_deduction'?'deduction':'earning'});}
 return retained;
}

export type HistoryMaintenanceState={state:HistoryContributionState;values:ImportedPayrollValues|null;unavailableReason?:string};
export async function historyMaintenanceStatesTx(tx:Tx,ctx:SessionContext,ids:readonly string[]):Promise<Map<string,HistoryMaintenanceState>>{
 const out=new Map<string,HistoryMaintenanceState>();if(!ids.length)return out;
 const identities=await tx.select().from(record).where(inArray(record.id,[...new Set(ids)]));
 const revisions=identities.length?await tx.select().from(revision).where(inArray(revision.recordId,identities.map(row=>row.id))).orderBy(asc(revision.recordId),asc(revision.ordinal)):[];
 if(revisions.length>50000)fail('Select fewer records to review this long correction history.');
 const snapshotIds=[...new Set(revisions.map(row=>row.snapshotId).filter((id):id is string=>!!id))];
 const snapshots=new Map((snapshotIds.length?await tx.select().from(snapshot).where(inArray(snapshot.id,snapshotIds)):[]).map(row=>[row.id,row]));
 const latest=new Map(revisions.map(row=>[row.recordId,row])),revisionsByRecord=new Map<string,typeof revisions>();for(const change of revisions){const rows=revisionsByRecord.get(change.recordId)??[];rows.push(change);revisionsByRecord.set(change.recordId,rows);}
 const legacy=revisions.filter(row=>!latest.get(row.recordId)?.maintenance&&!row.maintenance&&row.kind!=='adopted'&&row.kind!=='revert'),attemptIds=[...new Set(legacy.map(row=>row.attemptId))];
 const sizes=attemptIds.length?await tx.select({bytes:sql<number>`octet_length(${attempt.sourceContent})`}).from(attempt).where(inArray(attempt.id,attemptIds)):[];
 if(sizes.reduce((sum,row)=>sum+Number(row.bytes),0)>67108864)fail('Select fewer records to review their retained source files.');
 const sources=attemptIds.length?await tx.select().from(attempt).where(inArray(attempt.id,attemptIds)):[];
 const parsed=new Map<string,PayrollHistoryRecord[]>(),sourceOf=new Map(sources.map(row=>[row.id,row])),codes=await resolveImportCodes(ctx,tx);
 const plannedKey=(row:{companyId:string;employmentId:string;period:string;cycleId:string;valueHash:string|null})=>[row.companyId,row.employmentId,row.period,row.cycleId,row.valueHash].join(':');
 const plannedBySource=new Map(sources.map(source=>{const rows=new Map<string,typeof source.plan.rows>();for(const row of source.plan.rows){const key=plannedKey(row),group=rows.get(key)??[];group.push(row);rows.set(key,group);}return[source.id,rows] as const;}));
 const {parsePayrollHistorySource}=await import('./payroll-history-revisions');
 for(const source of sources){if(createHash('sha256').update(source.sourceContent).digest('hex')!==source.sourceHash)fail('The original retained source hash does not match.');parsed.set(source.id,await parsePayrollHistorySource(source.sourceName,source.sourceContent));}
 for(const identity of identities){let state:HistoryContributionState={version:1,baselineSnapshotId:null,chains:{}};let values:ImportedPayrollValues|null=null;const bySnapshot=new Map<string,HistoryContributionState>();
  const current=latest.get(identity.id);
  if(current?.maintenance){const saved=current.snapshotId?snapshots.get(current.snapshotId):null;out.set(identity.id,{state:structuredClone(current.maintenance.state),values:saved?.values??null});continue;}
  try{for(const change of revisionsByRecord.get(identity.id)??[]){
   const saved=change.snapshotId?snapshots.get(change.snapshotId):null;values=saved?.values??null;
   if(change.maintenance){if(change.maintenance.version!==1||change.maintenance.state.version!==1)fail('The saved maintenance version is unsupported.');state=structuredClone(change.maintenance.state);effectiveHistoryItems(state);}
   else if(change.kind==='adopted'){if(!saved)fail('The retained native baseline is unavailable.');state={version:1,baselineSnapshotId:saved.id,chains:{}};for(const item of maintenanceNativeItems(saved.values,codes))state.chains[item.key]=[{attemptId:null,item}];}
   else if(change.kind==='revert'){state=change.snapshotId?structuredClone(bySnapshot.get(change.snapshotId)??fail('The reverted source lineage is unavailable.')):{version:1,baselineSnapshotId:state.baselineSnapshotId,chains:{}};}
   else{
    const source=sourceOf.get(change.attemptId);if(!saved)fail('The accepted source snapshot is unavailable.');if(!source)fail('The original item lineage is unavailable in your current scope. Its saved payroll figures are preserved.');
    const planned=plannedBySource.get(source.id)?.get(plannedKey({...identity,valueHash:saved.valueHash}))??[];if(planned.length!==1)fail('The accepted original source identity is ambiguous.');
    const rows=parsed.get(source.id)!;const items=maintenanceSourceItems(planned[0].rowNums.map(rowNum=>{const row=rows[rowNum-2];if(!row)fail('An original source row is unavailable.');return{rowNum,code:readHistoryField(row,'doe_code'),amount:readHistoryField(row,'amount').replace(/[,_\s]/g,'')};}),retainedHistoryCodes(saved.values,codes));
    if(!historyItemsMatchValues(items,saved.values))fail('The retained original item mappings no longer reconcile to their accepted snapshot. Review the original source.');
    state=appendHistoryContribution(state,source.id,items,'replace');
   }
   if(change.snapshotId)bySnapshot.set(change.snapshotId,structuredClone(state));
  }
  out.set(identity.id,{state,values});
  }catch(error){out.set(identity.id,{state:{version:1,baselineSnapshotId:state.baselineSnapshotId,chains:{}},values:current?.snapshotId?snapshots.get(current.snapshotId)?.values??null:null,unavailableReason:error instanceof Error?error.message:'The original item lineage is unavailable.'});}
 }
 return out;
}
