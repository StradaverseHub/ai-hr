import {createHash,randomUUID} from 'node:crypto';
import {and,asc,desc,eq,gte,inArray,isNull,like,ne,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {company,employment,payrollCycle,payrollBatch,payPeriod,payslip,statutoryReport,
 payrollHistoryImportAttempt as attempt,payrollHistoryImportRecord as record,payrollHistoryImportSnapshot as snapshot,
 payrollHistoryImportRevision as revision,payrollHistoryImportEvent as historyEvent} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {assertModuleGate} from './module-gate';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {lockPayrollHistoryReadTx,lockPayrollHistoryWriteTx} from './payroll-history-lock';
import {resolvePayrollPermission,batchDownstreamWarnings} from './payroll';
import {preparePayrollHistoryRevisionTx,toIsoPeriod} from './payroll-history-import';
import {todayInKualaLumpur} from '../lib/hr-date';
import {parseCsvRecords} from '../lib/csv';
import {readHistoryField,type PayrollHistoryRecord} from '../lib/payroll-history-import-schema';
import type {HistoryRevisionPlan,HistoryRevisionRow,ImportedPayrollValues,HistoryRevisionChange} from '../lib/payroll-history-revisions';

export class PayrollHistoryRevisionError extends Error{constructor(message:string){super(message);this.name='PayrollHistoryRevisionError';}}
function fail(message:string):never{throw new PayrollHistoryRevisionError(message);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const key=(value:string|null|undefined)=>(value??'').trim().toUpperCase();
const emptyPlan=(sourceHash:string):HistoryRevisionPlan=>({version:1,rows:[],issues:[],counts:{created:0,replaced:0,unchanged:0,invalid:0},companyIds:[],sourceHash,previewHash:''});
function seal(plan:HistoryRevisionPlan){plan.previewHash=hash(canonical({...plan,previewHash:''}));return plan;}
async function principal(tx:Tx,ctx:SessionContext){
 if(!ctx.userId)fail('Sign in again before importing payroll history.');
 const [row]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() AND exists(select 1 from company c where c.tenant_id=app.current_tenant_id() and app.can_admin_payroll_for(c.id)) as ok`);
 if(!row?.ok)fail('Access changed. Sign in again before continuing.');
}
async function permission(tx:Tx,ctx:SessionContext,companyId:string,kind:'import'|'revert'){
 const [row]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`);
 const roles=[...new Set([...(ctx.roles??[]),...(ctx.grants??[]).map(grant=>grant.role)])];
 const scoped=await tx.execute<{role:string}>(sql`select role from unnest(ARRAY[${sql.join(roles.map(role=>sql`${role}::text`),sql`, `)}]::text[]) scoped_role(role) where app.has_role_for(role,${companyId}::uuid)`);
 if(!row?.ok||!await resolvePayrollPermission(tx,{...ctx,roles:scoped.map(item=>item.role),grants:[]},kind==='import'?'payroll.history.import':'payroll.history.revert',companyId))fail('Payroll history access is unavailable for a company in this file.');
}
/** Bound ZIP expansion before a workbook parser allocates worksheet strings. No archive is extracted. */
function checkWorkbook(bytes:Buffer){
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0)fail('Choose a valid .xlsx workbook.');
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 if(count>200||offset+size>end||count===65535)fail('The workbook exceeds the supported archive size.');
 let position=offset,total=0;
 for(let i=0;i<count;i++){
  if(position+46>bytes.length||bytes.readUInt32LE(position)!==0x02014b50)fail('The workbook archive is invalid.');
  const inflated=bytes.readUInt32LE(position+24);total+=inflated;
  if(inflated>33554432||total>67108864)fail('The expanded workbook exceeds 64 MB.');
  position+=46+bytes.readUInt16LE(position+28)+bytes.readUInt16LE(position+30)+bytes.readUInt16LE(position+32);
 }
 if(position!==offset+size)fail('The workbook archive directory is invalid.');
}
async function parseSource(name:string,bytes:Buffer):Promise<PayrollHistoryRecord[]>{
 if(bytes.length>10485760)fail('Choose a file no larger than 10 MB.');
 let text:string;
 if(/\.xlsx?$/i.test(name)){
  if(name.toLowerCase().endsWith('.xlsx'))checkWorkbook(bytes);
  else if(bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')fail('Choose a valid XLS workbook.');
  const XLSX=await import('xlsx');
  const workbook=XLSX.read(bytes,{type:'buffer',sheetRows:50002,cellFormula:false,cellHTML:false,bookVBA:false});
  if(!workbook.SheetNames.length)fail('The workbook has no worksheet.');
  text=XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
 }else if(name.toLowerCase().endsWith('.csv')){
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('Save the CSV file as UTF-8.');}
 }else fail('Choose a CSV, XLS or XLSX payroll history file.');
 const source=parseCsvRecords(text!);
 if(new Set(source.headers).size!==source.headers.length)fail('Remove repeated column headings before validating this file.');
 const parsed=source.records;
 if(parsed.length>50000)fail('Split this file into uploads of at most 50,000 rows.');
 return parsed;
}
function invalidRow(rowNum:number,input:PayrollHistoryRecord,reason:string):HistoryRevisionRow{
 return {companyId:'',companyName:readHistoryField(input,'company_code'),currency:null,employmentId:'',employeeNo:readHistoryField(input,'employee_no'),period:toIsoPeriod(readHistoryField(input,'payroll_period'))??readHistoryField(input,'payroll_period'),
  cycleId:'',cycleName:readHistoryField(input,'payroll_cycle'),rowNums:[rowNum],operation:'invalid',reasons:[reason],recordId:null,expectedRevisionId:null,expectedSnapshotId:null,values:null,beforeValues:null,valueHash:null,overwrite:false};
}
async function dependencies(tx:Tx,row:Pick<HistoryRevisionRow,'companyId'|'employmentId'|'period'|'expectedSnapshotId'>):Promise<string[]>{
 const reasons:string[]=[];
 const later=await tx.select({id:payrollBatch.id}).from(payrollBatch)
  .where(and(eq(payrollBatch.companyId,row.companyId),gte(payrollBatch.payPeriod,row.period),like(payrollBatch.payPeriod,row.period.slice(0,4)+'-%'),ne(payrollBatch.status,'draft'),isNull(payrollBatch.historyImportAttemptId))).limit(1);
 if(later.length)reasons.push('Normally processed payroll already depends on this period or a later period in the same year.');
 const reports=await tx.select({id:statutoryReport.id}).from(statutoryReport)
  .where(and(eq(statutoryReport.companyId,row.companyId),or(eq(statutoryReport.periodKey,row.period.slice(0,4)),and(gte(statutoryReport.periodKey,row.period),like(statutoryReport.periodKey,row.period.slice(0,4)+'-%'))))).limit(1);
 if(reports.length)reasons.push('A statutory report has already been generated for an affected period. Resolve that dependency before changing its basis.');
 if(row.expectedSnapshotId){
  const [batch]=await tx.select({id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,releasedAt:payrollBatch.releasedAt,history:payrollBatch.historyImportAttemptId})
   .from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).where(eq(payslip.id,row.expectedSnapshotId));
  if(!batch)reasons.push('The current imported snapshot is unavailable.');
  else{
   const downstream=await batchDownstreamWarnings(tx,{batchId:batch.id,companyId:batch.companyId,payPeriod:batch.payPeriod});
   if(downstream.paymentDisbursed)reasons.push('A payment export already references this history.');
   if(downstream.statutoryReportCount)reasons.push('A statutory artifact already references this history.');
   if(!batch.history||batch.releasedAt)reasons.push('An issued or legacy payroll result cannot be replaced by this import.');
  }
 }
 return reasons;
}
async function planRows(tx:Tx,ctx:SessionContext,records:PayrollHistoryRecord[],sourceHash:string):Promise<HistoryRevisionPlan>{
 const plan=emptyPlan(sourceHash);
 if(!records.length){plan.issues.push({rowNum:1,reason:'The source file has no data rows.'});plan.counts.invalid=1;return seal(plan);}
 const companies=await tx.select({id:company.id,name:company.legalName,label:company.companyLabel,registration:company.registrationNo,currency:company.currency}).from(company)
  .where(and(isNull(company.archivedAt),sql`app.can_admin_payroll_for(${company.id})`));
 const cycleRows=await tx.select({id:payrollCycle.id,companyId:payrollCycle.companyId,name:payrollCycle.name,code:payrollCycle.code}).from(payrollCycle).where(isNull(payrollCycle.archivedAt));
 const permissionCache=new Map<string,boolean>();
 const groups=new Map<string,{company:typeof companies[number];cycle:typeof cycleRows[number];records:PayrollHistoryRecord[];indices:number[]}>();
 for(let index=0;index<records.length;index++){
  const input=records[index],companyCode=key(readHistoryField(input,'company_code')),cycleCode=key(readHistoryField(input,'payroll_cycle'));
  if(Object.values(input).every(value=>!String(value??'').trim()))continue;
  const candidates=companies.filter(c=>[c.id,c.name,c.label,c.registration].some(v=>key(v)===companyCode&&companyCode!==''));
  if(candidates.length!==1){plan.rows.push(invalidRow(index+2,input,'The company code is unknown, ambiguous or outside your payroll scope.'));continue;}
  const co=candidates[0];
  const cycles=cycleRows.filter(c=>c.companyId===co.id&&[c.id,c.name,c.code].some(v=>key(v)===cycleCode&&cycleCode!==''));
  if(cycles.length!==1){plan.rows.push(invalidRow(index+2,input,'The Pay Cycle code or name is unknown or ambiguous for this company.'));continue;}
  if(!permissionCache.has(co.id)){try{await permission(tx,ctx,co.id,'import');permissionCache.set(co.id,true);}catch(error){if(!(error instanceof PayrollHistoryRevisionError))throw error;permissionCache.set(co.id,false);}}
  if(!permissionCache.get(co.id)){plan.rows.push(invalidRow(index+2,input,'Payroll history import permission is unavailable for this company.'));continue;}
  const amount=readHistoryField(input,'amount').replace(/[,_\s]/g,'');
  const numeric=/^\d+(?:\.\d{1,2})?$/.test(amount);
  const [whole,fraction='']=amount.split('.');
  if(!numeric||(numeric&&BigInt(whole+fraction.padEnd(2,'0'))>BigInt(999999999999))){plan.rows.push(invalidRow(index+2,input,'Enter a non-negative amount with at most two decimal places within the supported payroll range.'));continue;}
  const cycle=cycles[0],groupKey=co.id+':'+cycle.id;
  const group=groups.get(groupKey)??{company:co,cycle,records:[],indices:[]};
  group.records.push(input);group.indices.push(index+2);groups.set(groupKey,group);
 }
 for(const group of groups.values()){
  const prepared=await preparePayrollHistoryRevisionTx(ctx,tx,group.company.id,group.records);
  const rowNumber=(number:number)=>group.indices[number-2]??number;
  for(const problem of prepared.preview.issues)if(problem.status!=='Warning')plan.issues.push({rowNum:rowNumber(problem.rowNum),reason:problem.description});
  for(const missing of prepared.preview.missingColumns)plan.issues.push({rowNum:1,reason:'Missing required column: '+missing});
  for(const month of prepared.preview.months){
   const resolved=prepared.months.find(m=>m.month.key===month.key),rowNums=month.rowNums.map(rowNumber);
   const reasons=prepared.preview.issues.filter(issue=>issue.status!=='Warning'&&month.rowNums.includes(issue.rowNum)).map(issue=>issue.description);
   const values:ImportedPayrollValues|null=resolved?{basicSalary:resolved.basicSalary.toFixed(2),allowance:resolved.allowance.toFixed(2),overtimePay:resolved.overtimePay.toFixed(2),bonus:resolved.bonus.toFixed(2),grossPay:resolved.grossPay.toFixed(2),statutory:resolved.statutory,
    otherDeductions:resolved.otherDeductions.toFixed(2),totalDeductions:resolved.totalDeductions.toFixed(2),netPay:resolved.netPay.toFixed(2),employerCost:resolved.employerCost.toFixed(2)}:null;
   if(values&&Object.entries(values).some(([name,value])=>name!=='statutory'&&(!Number.isFinite(Number(value))||Math.abs(Number(value))>9999999999.99)))reasons.push('An accumulated payroll amount exceeds the supported range.');
   const row:HistoryRevisionRow={companyId:group.company.id,companyName:group.company.name,currency:group.company.currency,employmentId:resolved?.employmentId??'',employeeNo:month.employeeNo,period:month.period,cycleId:group.cycle.id,cycleName:group.cycle.name,rowNums,
    operation:resolved&&!reasons.length?'create':'invalid',reasons,recordId:null,expectedRevisionId:null,expectedSnapshotId:null,values,beforeValues:null,valueHash:values?hash(canonical(values)):null,
    overwrite:month.rowNums.every(number=>readHistoryField(group.records[number-2],'override?')!=='0')};
   if(resolved){
    const [existing]=await tx.select().from(record).where(and(eq(record.companyId,row.companyId),eq(record.employmentId,row.employmentId),eq(record.period,row.period),eq(record.cycleId,row.cycleId)));
    const [latest]=existing?await tx.select().from(revision).where(eq(revision.recordId,existing.id)).orderBy(desc(revision.ordinal)).limit(1):[];
    row.recordId=existing?.id??null;row.expectedRevisionId=latest?.id??null;row.expectedSnapshotId=latest?.snapshotId??null;
    if(row.expectedSnapshotId){
     const [current]=await tx.select({valueHash:snapshot.valueHash,values:snapshot.values}).from(snapshot).where(eq(snapshot.id,row.expectedSnapshotId));
     row.beforeValues=current?.values??null;
     row.operation=current?.valueHash===row.valueHash?'unchanged':'replace';
     if(row.operation==='replace'&&!row.overwrite)row.reasons.push('Replacement is disabled by Override? = 0.');
    }
    const collisions=await tx.select({id:payslip.id}).from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId))
     .where(and(eq(payslip.employmentId,row.employmentId),eq(payrollBatch.companyId,row.companyId),eq(payrollBatch.payPeriod,row.period),or(isNull(payrollBatch.payrollCycleId),eq(payrollBatch.payrollCycleId,row.cycleId))));
    if(collisions.some(p=>p.id!==row.expectedSnapshotId))row.reasons.push('An ordinary, legacy or competing payroll result already occupies this identity.');
    const ordinary=await tx.select({id:payrollBatch.id}).from(payrollBatch).where(and(eq(payrollBatch.companyId,row.companyId),eq(payrollBatch.payPeriod,row.period),isNull(payrollBatch.historyImportAttemptId),or(isNull(payrollBatch.payrollCycleId),eq(payrollBatch.payrollCycleId,row.cycleId)))).limit(1);
    if(ordinary.length)row.reasons.push('An ordinary payroll run already occupies this Pay Cycle and period.');
    if(row.operation!=='unchanged')row.reasons.push(...await dependencies(tx,row));
   }
   if(row.reasons.length||!values)row.operation='invalid';
   plan.rows.push(row);
  }
 }
 plan.rows.sort((a,b)=>(a.rowNums[0]??0)-(b.rowNums[0]??0));
 plan.companyIds=[...new Set(plan.rows.filter(row=>row.companyId).map(row=>row.companyId))].sort();
 for(const row of plan.rows)plan.counts[row.operation==='create'?'created':row.operation==='replace'?'replaced':row.operation]++;
 if(plan.issues.length&&!plan.counts.invalid)plan.counts.invalid=1;
 return seal(plan);
}

export async function previewPayrollHistoryUpload(ctx:SessionContext,input:{name:string;mimeType?:string;content:Buffer;operationKey?:string}){
 assertModuleGate(ctx,'payroll');
 const name=(input.name.split(/[\\/]/).pop()??'payroll-history.csv').slice(0,255)||'payroll-history.csv';
 if(input.content.length>10485760)fail('Choose a file no larger than 10 MB.');
 const sourceHash=hash(input.content),operationKey=input.operationKey&&uuid.test(input.operationKey)?input.operationKey:randomUUID();
 let records:PayrollHistoryRecord[]=[],parseError:string|undefined;
 try{records=await parseSource(name,input.content);}catch(error){parseError=error instanceof PayrollHistoryRevisionError?error.message:'This source file could not be read.';}
 return withTenant(ctx,async tx=>{
  await lockPayrollHistoryReadTx(tx,ctx.tenantId);await principal(tx,ctx);
  const [prior]=await tx.select({id:attempt.id,sourceHash:attempt.sourceHash,plan:attempt.plan}).from(attempt).where(and(eq(attempt.createdBy,ctx.userId!),eq(attempt.operationKey,operationKey)));
  if(prior){if(prior.sourceHash!==sourceHash)fail('This upload operation already identifies a different file.');return {attemptId:prior.id,plan:prior.plan};}
  const plan=parseError?seal({...emptyPlan(sourceHash),issues:[{rowNum:1,reason:parseError}],counts:{created:0,replaced:0,unchanged:0,invalid:1}}):await planRows(tx,ctx,records,sourceHash);
  const [created]=await tx.insert(attempt).values({tenantId:ctx.tenantId,createdBy:ctx.userId!,operationKey,sourceName:name,mimeType:name.toLowerCase().endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':name.toLowerCase().endsWith('.xls')?'application/vnd.ms-excel':'text/csv',sourceHash,sourceContent:input.content,companyIds:plan.companyIds,plan}).returning({id:attempt.id});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:created.id,eventType:'payroll-history-import.validated',actor:actorOf(ctx),payload:{sourceHash,counts:plan.counts,companyIds:plan.companyIds}});
  return {attemptId:created.id,plan};
 });
}
async function failureEvent(ctx:SessionContext,id:string,kind:'failed'|'revert_failed',error:unknown){
 try{await withTenant(ctx,async tx=>{
  const [found]=await tx.select({id:attempt.id}).from(attempt).where(eq(attempt.id,id));if(!found||!ctx.userId)return;
  const reason=error instanceof PayrollHistoryRevisionError?error.message:'The operation failed; no payroll changes were committed.';
  await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:id,kind,actorId:ctx.userId,changes:[],detail:{reason}});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:id,eventType:'payroll-history-import.'+kind,actor:actorOf(ctx),payload:{reason}});
 });}catch(recordError){console.error('[payroll history failure audit]',recordError);}
}
export async function confirmPayrollHistoryUpload(ctx:SessionContext,input:{attemptId:string;previewHash:string;confirmReplacement:boolean;expectedCompanyId?:string}){
 assertModuleGate(ctx,'payroll');if(!uuid.test(input.attemptId))fail('Import attempt unavailable.');
 try{return await withTenant(ctx,async tx=>{
  await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await principal(tx,ctx);
  const [source]=await tx.select().from(attempt).where(eq(attempt.id,input.attemptId)).for('update');if(!source)fail('Import attempt unavailable.');
  for(const id of source.companyIds)await permission(tx,ctx,id,'import');
  if(input.expectedCompanyId&&(!uuid.test(input.expectedCompanyId)||source.companyIds.some(id=>id!==input.expectedCompanyId)))fail('This record-based import is restricted to its selected company. Use the original-file workflow for a multi-company import.');
  const events=await tx.select().from(historyEvent).where(eq(historyEvent.attemptId,source.id));
  if(events.some(event=>event.kind==='reverted'))fail('This import was reverted. Validate a new upload to import again.');
  const confirmed=events.find(event=>event.kind==='confirmed');if(confirmed)return {attemptId:source.id,counts:source.plan.counts,changes:confirmed.changes,alreadyCommitted:true};
  if(input.previewHash!==source.plan.previewHash||source.plan.counts.invalid||source.plan.issues.length)fail('Correct the file and validate a new attempt before confirming.');
  if(source.plan.counts.replaced&&!input.confirmReplacement)fail('Confirm replacement of the existing imported history before continuing.');
  if(source.companyIds.length)await tx.select({id:company.id}).from(company).where(inArray(company.id,source.companyIds)).orderBy(asc(company.id)).for('share');
  const employmentIds=[...new Set(source.plan.rows.map(row=>row.employmentId).filter(Boolean))].sort(),cycleIds=[...new Set(source.plan.rows.map(row=>row.cycleId).filter(Boolean))].sort();
  if(employmentIds.length)await tx.select({id:employment.id}).from(employment).where(inArray(employment.id,employmentIds)).orderBy(asc(employment.id)).for('share');
  if(cycleIds.length)await tx.select({id:payrollCycle.id}).from(payrollCycle).where(inArray(payrollCycle.id,cycleIds)).orderBy(asc(payrollCycle.id)).for('share');
  const fresh=await planRows(tx,ctx,await parseSource(source.sourceName,source.sourceContent),source.sourceHash);
  if(fresh.previewHash!==source.plan.previewHash||fresh.counts.invalid)fail('The source, master data, permissions or target revisions changed. Validate a new attempt.');
  const changes:HistoryRevisionChange[]=[];
  const groups=new Map<string,HistoryRevisionRow[]>();
  for(const row of fresh.rows)if(row.operation!=='unchanged'){
   const groupKey=[row.companyId,row.period,row.cycleId].join(':');
   const group=groups.get(groupKey)??[];group.push(row);groups.set(groupKey,group);
  }
  for(const rows of groups.values()){
   const first=rows[0];
   const [parent]=await tx.select().from(payPeriod).where(and(eq(payPeriod.companyId,first.companyId),eq(payPeriod.period,first.period)));
   let parentId=parent?.id;
   if(!parentId){const [created]=await tx.insert(payPeriod).values({tenantId:ctx.tenantId,companyId:first.companyId,period:first.period,status:'open',statutoryVersion:String(first.values?.statutory.version??'')}).returning({id:payPeriod.id});parentId=created.id;}
   const [max]=await tx.select({seq:sql<number>`coalesce(max(${payrollBatch.runSeq}),0)::integer`}).from(payrollBatch).where(eq(payrollBatch.payPeriodId,parentId));
   const [batch]=await tx.insert(payrollBatch).values({tenantId:ctx.tenantId,companyId:first.companyId,payPeriodId:parentId,payPeriod:first.period,runType:'adjustment',runSeq:Number(max?.seq??0)+1,status:'draft',batchDate:todayInKualaLumpur(),payrollCycleId:first.cycleId,remarks:'Imported payroll history',historyImportAttemptId:source.id,historyImportCycleName:first.cycleName}).returning({id:payrollBatch.id});
   const pending:{row:HistoryRevisionRow;recordId:string;slipId:string;previous:typeof revision.$inferSelect|undefined}[]=[];
   const totals:Record<string,bigint>={gross:BigInt(0),net:BigInt(0),epfEmployee:BigInt(0),epfEmployer:BigInt(0),socsoEmployee:BigInt(0),socsoEmployer:BigInt(0),eisEmployee:BigInt(0),eisEmployer:BigInt(0),pcb:BigInt(0)};
   const cents=(amount:string|unknown)=>BigInt(Number(amount).toFixed(2).replace('.',''));
   for(const row of rows){
    if(!row.values||!row.valueHash||row.operation==='invalid')fail('The file contains an invalid record.');
    let recordId=row.recordId;
    if(!recordId){const [created]=await tx.insert(record).values({tenantId:ctx.tenantId,companyId:row.companyId,employmentId:row.employmentId,period:row.period,cycleId:row.cycleId}).returning({id:record.id});recordId=created.id;}
    const [current]=await tx.select().from(revision).where(eq(revision.recordId,recordId)).orderBy(desc(revision.ordinal)).limit(1);
    if((current?.id??null)!==row.expectedRevisionId)fail('A target revision changed. Validate a new attempt.');
    const [slip]=await tx.insert(payslip).values({tenantId:ctx.tenantId,batchId:batch.id,employmentId:row.employmentId,...row.values}).returning({id:payslip.id});
    totals.gross+=cents(row.values.grossPay);totals.net+=cents(row.values.netPay);
    for(const name of Object.keys(totals).filter(name=>name!=='gross'&&name!=='net'))totals[name]+=cents(row.values.statutory[name]??0);
    if(Object.values(totals).some(value=>value>BigInt(999999999999)||value< -BigInt(999999999999)))fail('An accumulated batch total exceeds the supported range. Split the source file.');
    pending.push({row,recordId,slipId:slip.id,previous:current});
   }
   await tx.update(payrollBatch).set({employeeCount:rows.length,totals:Object.fromEntries(Object.entries(totals).map(([name,value])=>[name,Number(value)/100])),status:'closed'}).where(eq(payrollBatch.id,batch.id));
   if(!parent||parent.status!=='closed')await tx.update(payPeriod).set({status:'closed'}).where(eq(payPeriod.id,parentId));
   for(const item of pending){
    const {row,recordId,slipId,previous}=item;
    await tx.insert(snapshot).values({id:slipId,tenantId:ctx.tenantId,recordId,valueHash:row.valueHash!,values:row.values!});
    const [createdRevision]=await tx.insert(revision).values({tenantId:ctx.tenantId,recordId,ordinal:(previous?.ordinal??0)+1,attemptId:source.id,snapshotId:slipId,previousRevisionId:previous?.id??null,kind:row.expectedSnapshotId?'correction':'import',cycleName:row.cycleName}).returning({id:revision.id});
    changes.push({recordId,revisionId:createdRevision.id,previousRevisionId:previous?.id??null,snapshotId:slipId});
   }
  }
  await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:source.id,kind:'confirmed',actorId:ctx.userId!,changes,detail:{counts:fresh.counts}});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:source.id,eventType:'payroll-history-import.committed',actor:actorOf(ctx),payload:{counts:fresh.counts,changes}});
  return {attemptId:source.id,counts:fresh.counts,changes,alreadyCommitted:false};
 });}catch(error){await failureEvent(ctx,input.attemptId,'failed',error);throw error;}
}

export async function revertPayrollHistoryUpload(ctx:SessionContext,id:string){
 assertModuleGate(ctx,'payroll');if(!uuid.test(id))fail('Import attempt unavailable.');
 try{return await withTenant(ctx,async tx=>{
  await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await principal(tx,ctx);
  const [source]=await tx.select().from(attempt).where(eq(attempt.id,id)).for('update');if(!source)fail('Import attempt unavailable.');
  for(const companyId of source.companyIds)await permission(tx,ctx,companyId,'revert');
  const events=await tx.select().from(historyEvent).where(eq(historyEvent.attemptId,id));
  if(events.some(event=>event.kind==='reverted'))fail('This import has already been reverted.');
  const confirmed=events.find(event=>event.kind==='confirmed');if(!confirmed?.changes.length)fail('This attempt has no imported changes to revert.');
  const changes:HistoryRevisionChange[]=[];
  for(const change of confirmed.changes){
   const [identity]=await tx.select().from(record).where(eq(record.id,change.recordId)).for('update');if(!identity)fail('An imported record is unavailable.');
   const [current]=await tx.select().from(revision).where(eq(revision.recordId,identity.id)).orderBy(desc(revision.ordinal)).limit(1);
   if(current?.id!==change.revisionId)fail('A later correction or revert changed this record. Revert is no longer safe.');
   const blocked=await dependencies(tx,{companyId:identity.companyId,employmentId:identity.employmentId,period:identity.period,expectedSnapshotId:current.snapshotId});
   if(blocked.length)fail(blocked.join(' '));
   const [previous]=change.previousRevisionId?await tx.select().from(revision).where(and(eq(revision.id,change.previousRevisionId),eq(revision.recordId,identity.id))):[];
   if(change.previousRevisionId&&!previous)fail('The prior revision is unavailable.');
   const [compensation]=await tx.insert(revision).values({tenantId:ctx.tenantId,recordId:identity.id,ordinal:current.ordinal+1,attemptId:id,snapshotId:previous?.snapshotId??null,previousRevisionId:current.id,kind:'revert',cycleName:previous?.cycleName??current.cycleName}).returning({id:revision.id});
   changes.push({recordId:identity.id,revisionId:compensation.id,previousRevisionId:current.id,snapshotId:previous?.snapshotId??null});
  }
  await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:id,kind:'reverted',actorId:ctx.userId!,changes,detail:{restored:changes.length}});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:id,eventType:'payroll-history-import.reverted',actor:actorOf(ctx),payload:{changes}});
  return {attemptId:id,restored:changes.length};
 });}catch(error){await failureEvent(ctx,id,'revert_failed',error);throw error;}
}

export async function listPayrollHistoryAttempts(ctx:SessionContext,options:{before?:string;limit?:number}={}){
 assertModuleGate(ctx,'payroll');if(options.before&&!uuid.test(options.before))fail('Import cursor unavailable.');return withTenant(ctx,async tx=>{
  await principal(tx,ctx);const limit=Math.min(100,Math.max(1,options.limit??25));
  const rows=await tx.select({id:attempt.id,sourceName:attempt.sourceName,sourceHash:attempt.sourceHash,companyIds:attempt.companyIds,plan:attempt.plan,createdBy:attempt.createdBy,createdAt:attempt.createdAt}).from(attempt)
   .where(options.before?sql`(${attempt.createdAt},${attempt.id}) < (select created_at,id from payroll_history_import_attempt where id=${options.before}::uuid)`:undefined)
   .orderBy(desc(attempt.createdAt),desc(attempt.id)).limit(limit+1);
  const chosen=rows.slice(0,limit),events=chosen.length?await tx.select().from(historyEvent).where(inArray(historyEvent.attemptId,chosen.map(row=>row.id))).orderBy(asc(historyEvent.createdAt),asc(historyEvent.id)):[];
  return {items:chosen.map(row=>({...row,events:events.filter(event=>event.attemptId===row.id)})),nextCursor:rows.length>limit?chosen.at(-1)!.id:null};
 });
}
export async function payrollHistorySource(ctx:SessionContext,id:string){
 assertModuleGate(ctx,'payroll');if(!uuid.test(id))return null;
 return withTenant(ctx,async tx=>{await principal(tx,ctx);const [row]=await tx.select({name:attempt.sourceName,mimeType:attempt.mimeType,content:attempt.sourceContent}).from(attempt).where(eq(attempt.id,id));return row??null;});
}

/** Metadata and original planned differences remain private under the same attempt RLS as its source. */
export async function getPayrollHistoryAttempt(ctx:SessionContext,id:string){
 assertModuleGate(ctx,'payroll');if(!uuid.test(id))return null;
 return withTenant(ctx,async tx=>{
  await principal(tx,ctx);
  const [source]=await tx.select({id:attempt.id,sourceName:attempt.sourceName,sourceHash:attempt.sourceHash,companyIds:attempt.companyIds,plan:attempt.plan,createdBy:attempt.createdBy,createdAt:attempt.createdAt}).from(attempt).where(eq(attempt.id,id));
  if(!source)return null;
  const events=await tx.select().from(historyEvent).where(eq(historyEvent.attemptId,id)).orderBy(asc(historyEvent.createdAt),asc(historyEvent.id));
  return {...source,events};
 });
}
