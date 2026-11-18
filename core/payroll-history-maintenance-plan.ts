/** Canonical preprocessing for versioned maintenance. Originals and contribution chains stay immutable. */
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {payrollHistoryImportRecord as record,payrollHistoryImportRevision as revision,payrollHistoryImportSnapshot as snapshot,payrollBatch,payslip} from '../db/schema';
import {readHistoryField,type ImportCodeEntry,type PayrollHistoryRecord} from '../lib/payroll-history-import-schema';
import type {HistoryRevisionPlan,HistoryRevisionRow,ImportedPayrollValues} from '../lib/payroll-history-revisions';
import {appendHistoryContribution,effectiveHistoryItems,historyContributionChanges,historyMoney,historyMoneyCents,removeHistoryAttempt,removeHistoryItems,type HistoryContributionState,type HistoryOwnedItem} from '../lib/payroll-history-maintenance-lineage';
import {historyMaintenanceStatesTx,maintenanceNativeItems,maintenanceSourceItems} from './payroll-history-maintenance-state';
import {toIsoPeriod,type HistoryAnalyzeBatchContext,type HistoryMaintenanceSubject} from './payroll-history-import';
export type MaintenanceOptions=NonNullable<HistoryRevisionPlan['maintenance']>;
export type MaintenanceGroup={company:{id:string;name:string;label:string|null};cycle:{id:string;name:string;code:string|null};records:PayrollHistoryRecord[];indices:number[]};
export type MaintenanceRecordPreparation={before:HistoryContributionState;after:HistoryContributionState;beforeValues:ImportedPayrollValues|null;withdrawal:boolean;restoreSnapshotId:string|null;restoreValues:ImportedPayrollValues|null;itemChanges:NonNullable<HistoryRevisionRow['itemChanges']>};
const fail=(message:string):never=>{throw new Error(message);};
const up=(s:string)=>s.trim().toUpperCase();
export const maintenanceIdentity=(value:{companyId:string;employmentId:string;period:string;cycleId:string})=>[value.companyId,value.employmentId,value.period,value.cycleId].join(':');
export async function maintenanceSubjectsTx(tx:Tx,groups:readonly MaintenanceGroup[]):Promise<HistoryMaintenanceSubject[]>{
 const companies=[...new Set(groups.map(group=>group.company.id))],codes=[...new Set(groups.flatMap(group=>group.records.map(row=>readHistoryField(row,'employee_no'))))],periods=[...new Set(groups.flatMap(group=>group.records.map(row=>toIsoPeriod(readHistoryField(row,'payroll_period'))).filter((period):period is string=>!!period)))];
 if(!companies.length||!codes.length||!periods.length)return[];
 const array=(values:string[],type:'uuid'|'text')=>sql`ARRAY[${sql.join(values.map(value=>type==='uuid'?sql`${value}::uuid`:sql`${value}::text`),sql`, `)}]${type==='uuid'?sql`::uuid[]`:sql`::text[]`}`;
 const result:HistoryMaintenanceSubject[]=[];for(let offset=0;;offset+=500){const page=await tx.execute<HistoryMaintenanceSubject>(sql`select * from app.payroll_history_maintenance_subjects(${array(companies,'uuid')},${array(codes,'text')},${array(periods,'text')},${offset},500)`);result.push(...page);if(page.length<500)break;if(result.length>50000)fail('Select fewer original history records.');}return result;
}
function baselineState(id:string|null,items:HistoryOwnedItem[]):HistoryContributionState{return{version:1,baselineSnapshotId:id,chains:Object.fromEntries(items.map(item=>[item.key,[{attemptId:null,item}]]))};}
function valuesOf(row:typeof payslip.$inferSelect):ImportedPayrollValues{return{basicSalary:row.basicSalary,allowance:row.allowance,overtimePay:row.overtimePay,bonus:row.bonus,grossPay:row.grossPay,statutory:row.statutory as Record<string,unknown>,otherDeductions:row.otherDeductions,totalDeductions:row.totalDeductions,netPay:row.netPay,employerCost:row.employerCost};}
export async function preprocessHistoryMaintenanceTx(tx:Tx,ctx:SessionContext,groups:MaintenanceGroup[],options:MaintenanceOptions,attemptId:string,batch:HistoryAnalyzeBatchContext){
 const subjects=await maintenanceSubjectsTx(tx,groups),keys:{companyId:string;employmentId:string;period:string;cycleId:string;employeeNo:string}[]=[];
 const months=new Map<string,{group:MaintenanceGroup;subject:HistoryMaintenanceSubject|null;records:{record:PayrollHistoryRecord;row:number}[]}>();
 for(const group of groups){for(let index=0;index<group.records.length;index++){
  const input=group.records[index],employeeNo=readHistoryField(input,'employee_no'),period=toIsoPeriod(readHistoryField(input,'payroll_period'));if(!period)continue;
  const historical=subjects.filter(row=>row.companyId===group.company.id&&row.period===period&&row.cycleId===group.cycle.id&&up(row.employeeNo)===up(employeeNo));
  const live=batch.inputs.get(group.company.id)?.employees.filter(row=>up(row.code??'')===up(employeeNo))??[];
  if(historical.length>1||live.length>1||historical.length===1&&live.some(row=>row.employmentId!==historical[0].employmentId))fail('The original employee identity is ambiguous.');
  const employmentId=historical[0]?.employmentId??live[0]?.employmentId;if(!employmentId)continue;
  const identity={companyId:group.company.id,employmentId,period,cycleId:group.cycle.id,employeeNo},key=maintenanceIdentity(identity),month=months.get(key)??{group,subject:historical[0]??null,records:[]};month.records.push({record:input,row:group.indices[index]});months.set(key,month);if(!keys.some(row=>maintenanceIdentity(row)===key))keys.push(identity);
 }}
 const employmentIds=[...new Set(keys.map(row=>row.employmentId))],companyIds=[...new Set(keys.map(row=>row.companyId))],periods=[...new Set(keys.map(row=>row.period))],wanted=new Set(keys.map(maintenanceIdentity));
 const identities=keys.length?(await tx.select().from(record).where(and(inArray(record.employmentId,employmentIds),inArray(record.companyId,companyIds),inArray(record.period,periods)))).filter(row=>wanted.has(maintenanceIdentity(row))):[];
 const latest=identities.length?await tx.selectDistinctOn([revision.recordId]).from(revision).where(inArray(revision.recordId,identities.map(row=>row.id))).orderBy(revision.recordId,desc(revision.ordinal)):[];
 const states=await historyMaintenanceStatesTx(tx,ctx,identities.map(row=>row.id));
 const collisions=keys.length?await tx.select({slip:payslip,batch:payrollBatch}).from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).where(and(inArray(payslip.employmentId,employmentIds),inArray(payrollBatch.companyId,companyIds),inArray(payrollBatch.payPeriod,periods))):[];
 const baselineIds=[...new Set([...states.values()].map(value=>value.state.baselineSnapshotId).filter((id):id is string=>!!id))];
 const baselines=new Map((baselineIds.length?await tx.select().from(snapshot).where(inArray(snapshot.id,baselineIds)):[]).map(row=>[row.id,row.values]));
 const metadata=new Map<string,MaintenanceRecordPreparation>(),retained=new Map<MaintenanceGroup,ImportCodeEntry[]>(),historical=new Map<MaintenanceGroup,HistoryMaintenanceSubject[]>();
 const output=new Map<MaintenanceGroup,{records:PayrollHistoryRecord[];indices:number[]}>();for(const group of groups)output.set(group,{records:[],indices:[]});
 for(const identity of keys){const key=maintenanceIdentity(identity),month=months.get(key)!,group=month.group,existing=identities.find(row=>maintenanceIdentity(row)===key),current=existing?latest.find(row=>row.recordId===existing.id):null,loaded=existing?states.get(existing.id):null;
  if(loaded?.unavailableReason)fail(loaded.unavailableReason);
  let before=loaded?.state??baselineState(null,[]),beforeValues=loaded?.values??null;
  if(!existing){const candidates=collisions.filter(row=>row.slip.employmentId===identity.employmentId&&row.batch.companyId===identity.companyId&&row.batch.payPeriod===identity.period&&(row.batch.payrollCycleId===null||row.batch.payrollCycleId===identity.cycleId));if(candidates.length>1)fail('More than one original payroll result matches this identity.');if(candidates.length===1){const original=candidates[0];if(original.batch.historyImportAttemptId)fail('The original import record identity is unavailable.');beforeValues=valuesOf(original.slip);before=baselineState(original.slip.id,maintenanceNativeItems(beforeValues,batch.codes));baselines.set(original.slip.id,beforeValues);}}
  const request=options.request;if(request&&request.operation!=='remove_batch'&&(!existing||request.recordId!==existing.id||request.expectedRevisionId!==current?.id))fail('The history revision changed. Review the current record.');
  const incoming=request?[]:maintenanceSourceItems(month.records.map(({record,row})=>({rowNum:row,code:readHistoryField(record,'doe_code'),amount:readHistoryField(record,'amount').replace(/[,_\s]/g,'')})),batch.codes);
  let after:HistoryContributionState;
  if(request?.operation==='edit'){const old=new Map(effectiveHistoryItems(before).map(item=>[item.key,item]));const edited=request.items.map(change=>{const item=old.get(change.key);if(!item)fail('A selected Pay Item is no longer effective.');return{...item,amount:historyMoney(historyMoneyCents(change.amount))};});if(new Set(edited.map(item=>item.key)).size!==edited.length)fail('Choose each Pay Item once.');const verified=maintenanceSourceItems(edited.map(item=>({rowNum:item.sourceRows[0]??1,code:item.code,amount:item.amount})),batch.codes);if(verified.some(item=>!edited.some(old=>old.key===item.key&&old.destination===item.destination)))fail('A selected Pay Item changed its configured identity or monetary kind.');after=appendHistoryContribution(before,attemptId,edited,'update_listed');}
  else if(request?.operation==='remove_items')after=removeHistoryItems(before,attemptId,request.itemKeys);
  else if(request?.operation==='remove_batch')after=removeHistoryAttempt(before,request.attemptId);
  else after=appendHistoryContribution(before,attemptId,incoming,options.mode==='update_listed'?'update_listed':'replace');
  if(!request||request.operation==='edit'){const signature=(state:HistoryContributionState)=>JSON.stringify(effectiveHistoryItems(state).map(item=>[item.key,item.code,item.destination,item.direction,item.amount]));if(signature(before)===signature(after))after=structuredClone(before);}
  let items=effectiveHistoryItems(after),restoreSnapshotId:string|null=null,restoreValues:ImportedPayrollValues|null=null;
  const withdrawal=!Object.values(after.chains).some(entries=>entries[0]?.item&&entries[0].attemptId!==null);
  if(withdrawal){restoreSnapshotId=after.baselineSnapshotId;restoreValues=restoreSnapshotId?baselines.get(restoreSnapshotId)??fail('The adopted native baseline is unavailable.'):null;after=restoreValues?baselineState(restoreSnapshotId,maintenanceNativeItems(restoreValues,batch.codes)):baselineState(null,[]);items=effectiveHistoryItems(after);}
  const changes=historyContributionChanges(before,after,request?.operation==='remove_batch'?request.attemptId:undefined);
  metadata.set(key,{before,after,beforeValues,withdrawal,restoreSnapshotId,restoreValues,itemChanges:changes});
  if(month.subject){const list=historical.get(group)??[];list.push({...month.subject});historical.set(group,list);}
  const canonicalCodes=new Map<string,string>();for(const item of items){const collision=canonicalCodes.get(up(item.code));if(collision&&collision!==item.key)fail(`Pay Item ${item.code} now identifies a different original owner.`);canonicalCodes.set(up(item.code),item.key);}
  const rows=items.length?items:[{key:'destination:basic',code:'BASIC',label:'Basic salary',originalCodes:['BASIC'],amount:'0.00',destination:'basic' as const,direction:'earning' as const,sourceRows:[]}];
  const target=output.get(group)!;for(const item of rows){target.records.push({employee_no:identity.employeeNo,payroll_period:identity.period,payroll_cycle:group.cycle.id,doe_code:item.code,company_code:group.company.id,amount:item.amount});target.indices.push(month.records[0].row);}
  // Only immutable retained, unlisted owners may extend analysis. Incoming listed mappings already passed the live resolver.
  const entries=retained.get(group)??[];for(const item of items){const live=batch.codes.get(up(item.code));if(!live||live.destination!==item.destination||live.ownerId&&item.key.startsWith('component:')&&item.key!=='component:'+live.ownerId)entries.push({code:item.code,targetCode:item.code,label:item.label,destination:item.destination,direction:item.direction==='statutory'?(live?.direction??'deduction'):item.direction==='deduction'?'deduction':'earning',source:'catalog',ownerId:item.key.startsWith('component:')?item.key.slice(10):undefined,basicSalaryOwner:item.destination==='basic'});}retained.set(group,entries);
 }
 const consumed=new Set([...months.values()].flatMap(month=>month.records.map(row=>row.row)));
 for(const group of groups){const rows=output.get(group)!;for(let index=0;index<group.records.length;index++)if(!consumed.has(group.indices[index])){rows.records.push(group.records[index]);rows.indices.push(group.indices[index]);}if(rows.records.length){group.records=rows.records;group.indices=rows.indices;}}
 return{metadata,retained,historical,keys};
}
