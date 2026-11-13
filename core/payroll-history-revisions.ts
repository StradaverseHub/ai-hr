import {createHash,randomUUID} from 'node:crypto';
import {and,asc,desc,eq,getTableColumns,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assignment,company,employment,person,payrollCycle,payrollBatch,payPeriod,payslip,
 payrollHistoryImportAttempt as attempt,payrollHistoryImportRecord as record,payrollHistoryImportSnapshot as snapshot,
 payrollHistoryImportRevision as revision,payrollHistoryImportEvent as historyEvent} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {assertModuleGate} from './module-gate';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {lockPayrollHistoryWriteTx} from './payroll-history-lock';
import {resolvePayrollPermission,batchDownstreamWarnings} from './payroll';
import {historyAnalyzeFactsTx,preparePayrollHistoryRevisionTx,toIsoPeriod} from './payroll-history-import';
import {todayInKualaLumpur} from '../lib/hr-date';
import {parseCsvRecords} from '../lib/csv';
import {historyColumnLabel,readHistoryField,type PayrollHistoryRecord} from '../lib/payroll-history-import-schema';
import {historyRecordKey,type HistoryRevisionPlan,type HistoryRevisionRow,type ImportedPayrollValues,type HistoryRevisionChange} from '../lib/payroll-history-revisions';
import {actorOn,creatorOf,resolveImportActors,type ImportRowActors} from './import-actor-label';
import type {ImportActor} from '../lib/import-reference';

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
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const [row]=await tx.execute<{ok:boolean}>(sql`select app.can_admin_payroll_for(${companyId}::uuid) as ok`);
 // The canonical resolver rechecks current scope. Preserve the original grant objects: an explicit
 // empty/narrow carrier must not borrow roles or become an accidentally empty authorized carrier.
 if(!row?.ok||!await resolvePayrollPermission(tx,ctx,kind==='import'?'payroll.history.import':'payroll.history.revert',companyId))fail('Payroll history access is unavailable for a company in this file.');
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
export async function parsePayrollHistorySource(name:string,bytes:Buffer):Promise<PayrollHistoryRecord[]>{
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
  cycleId:'',cycleName:readHistoryField(input,'payroll_cycle'),rowNums:[rowNum],operation:'invalid',reasons:[reason],recordId:null,expectedRevisionId:null,expectedSnapshotId:null,values:null,beforeValues:null,valueHash:null,overwrite:false,codes:readHistoryField(input,'doe_code')?[readHistoryField(input,'doe_code')]:[]};
}
function emptyBatchTotals(){return {gross:BigInt(0),net:BigInt(0),epfEmployee:BigInt(0),epfEmployer:BigInt(0),socsoEmployee:BigInt(0),socsoEmployer:BigInt(0),eisEmployee:BigInt(0),eisEmployer:BigInt(0),pcb:BigInt(0)};}
type BatchTotals=ReturnType<typeof emptyBatchTotals>;
/** Match the existing batch accumulator in both preview and commit, with integer cents. */
function addBatchTotals(totals:BatchTotals,values:ImportedPayrollValues){
 const cents=(amount:unknown)=>BigInt(Number(amount).toFixed(2).replace('.',''));
 totals.gross+=cents(values.grossPay);totals.net+=cents(values.netPay);
 for(const name of Object.keys(totals) as (keyof BatchTotals)[])if(name!=='gross'&&name!=='net')totals[name]+=cents(values.statutory[name]??0);
}
const batchTotalsOverflow=(totals:BatchTotals)=>Object.values(totals).some(value=>value>BigInt(999999999999)||value< -BigInt(999999999999));
/** A planned month's identity: the key every per-record fact is read by. */
type PlanKey={companyId:string;employmentId:string;period:string;cycleId:string};
const planKey=(k:PlanKey)=>[k.companyId,k.employmentId,k.period,k.cycleId].join(':');
const byText=(a:string,b:string)=>a<b?-1:a>b?1:0;
const sortBy=<T,>(rows:T[],key:(row:T)=>string)=>[...rows].sort((a,b)=>byText(key(a),key(b)));
/** Whether payroll processed in AIHR (not imported) reaches a period or a later month of its year, and whether a
 * statutory report was generated for it, per (company, period). The same SQL predicates the per-record reads used. */
async function periodFactsTx(tx:Tx,pairs:{companyId:string;period:string}[]){
 const unique=sortBy([...new Map(pairs.map(p=>[p.companyId+':'+p.period,p])).values()],p=>p.companyId+':'+p.period);
 if(!unique.length)return new Map<string,{later:boolean;reports:boolean}>();
 const rows=await tx.execute<{company_id:string;period:string;later:boolean;reports:boolean}>(sql`select k.company_id,k.period,
   exists(select 1 from payroll_batch b where b.company_id=k.company_id and b.pay_period>=k.period and b.pay_period like k.year_pattern
    and b.status<>'draft' and b.history_import_attempt_id is null) as later,
   exists(select 1 from statutory_report s where s.company_id=k.company_id and (s.period_key=k.year or (s.period_key>=k.period and s.period_key like k.year_pattern))) as reports
  from jsonb_to_recordset(${JSON.stringify(unique.map(p=>({company_id:p.companyId,period:p.period,year:p.period.slice(0,4),year_pattern:p.period.slice(0,4)+'-%'})))}::jsonb)
   k(company_id uuid,period text,year text,year_pattern text) order by k.company_id,k.period`);
 return new Map([...rows].map(r=>[r.company_id+':'+r.period,{later:r.later,reports:r.reports}]));
}
/** What has already gone out from a batch (payment exports, statutory artefacts), once per distinct batch. */
async function downstreamFactsTx(tx:Tx,batches:{id:string;companyId:string;payPeriod:string}[]){
 const out=new Map<string,Awaited<ReturnType<typeof batchDownstreamWarnings>>>();
 for(const b of sortBy([...new Map(batches.map(b=>[b.id,b])).values()],b=>b.id))out.set(b.id,await batchDownstreamWarnings(tx,{batchId:b.id,companyId:b.companyId,payPeriod:b.payPeriod}));
 return out;
}
/** Every per-record fact the plan reads, in a fixed number of bulk reads under the caller's row security (the
 * effective-only payslip policy included), instead of about eight reads per record. Each value is exactly what the
 * per-record read returned; the plan's rules below then run over these facts in memory. The same function reads them
 * again at release (`historyPlanFactsDigestTx`), so an unchanged digest proves an unchanged plan. */
async function planRecordFactsTx(tx:Tx,keys:PlanKey[]){
 const empIds=[...new Set(keys.map(k=>k.employmentId))].sort(byText),companyIds=[...new Set(keys.map(k=>k.companyId))].sort(byText),periods=[...new Set(keys.map(k=>k.period))].sort(byText);
 if(!keys.length)return{names:[],records:[],latest:[],first:[],snapshots:[],collisions:[],runs:[],periods:[] as [string,{later:boolean;reports:boolean}][],targets:[],downstream:[] as [string,Awaited<ReturnType<typeof batchDownstreamWarnings>>][]};
 const names=sortBy(await tx.select({id:employment.id,name:person.fullName}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(inArray(employment.id,empIds)),r=>r.id);
 const wanted=new Set(keys.map(planKey));
 const records=sortBy((await tx.select().from(record).where(and(inArray(record.employmentId,empIds),inArray(record.companyId,companyIds),inArray(record.period,periods))))
  .filter(r=>wanted.has(planKey(r))),r=>r.id);
 const recordIds=records.map(r=>r.id);
 const latest=recordIds.length?sortBy(await tx.selectDistinctOn([revision.recordId]).from(revision).where(inArray(revision.recordId,recordIds)).orderBy(revision.recordId,desc(revision.ordinal)),r=>r.recordId):[];
 const first=recordIds.length?sortBy(await tx.select({recordId:revision.recordId,kind:revision.kind}).from(revision).where(and(inArray(revision.recordId,recordIds),eq(revision.ordinal,1))),r=>r.recordId):[];
 const snapshotIds=[...new Set(latest.map(r=>r.snapshotId).filter((id):id is string=>!!id))].sort(byText);
 const snapshots=snapshotIds.length?sortBy(await tx.select({id:snapshot.id,valueHash:snapshot.valueHash,values:snapshot.values}).from(snapshot).where(inArray(snapshot.id,snapshotIds)),r=>r.id):[];
 const collisions=sortBy((await tx.select({id:payslip.id,employmentId:payslip.employmentId,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,cycleId:payrollBatch.payrollCycleId,
   history:payrollBatch.historyImportAttemptId,status:payrollBatch.status,releasedAt:payrollBatch.releasedAt,batchId:payrollBatch.id,
   basicSalary:payslip.basicSalary,allowance:payslip.allowance,overtimePay:payslip.overtimePay,bonus:payslip.bonus,grossPay:payslip.grossPay,statutory:payslip.statutory,
   otherDeductions:payslip.otherDeductions,totalDeductions:payslip.totalDeductions,netPay:payslip.netPay,employerCost:payslip.employerCost})
  .from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId))
  .where(and(inArray(payslip.employmentId,empIds),inArray(payrollBatch.companyId,companyIds),inArray(payrollBatch.payPeriod,periods)))),r=>r.id);
 // Runs processed in AIHR (not imported) for the planned companies and months: the open-run refusal and the
 // "processed without this employee" warning read them.
 const runs=sortBy(await tx.select({id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,cycleId:payrollBatch.payrollCycleId,status:payrollBatch.status}).from(payrollBatch)
  .where(and(inArray(payrollBatch.companyId,companyIds),inArray(payrollBatch.payPeriod,periods),isNull(payrollBatch.historyImportAttemptId))),r=>r.id);
 const periodRows=[...await periodFactsTx(tx,keys)].sort(([a],[b])=>byText(a,b));
 // The batches an overwrite would replace from: an ordinary payslip on file or the current imported snapshot.
 const targetIds=[...new Set([...snapshotIds,...collisions.map(c=>c.id)])].sort(byText);
 const targets=targetIds.length?sortBy(await tx.select({payslipId:payslip.id,id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,
   releasedAt:payrollBatch.releasedAt,history:payrollBatch.historyImportAttemptId}).from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).where(inArray(payslip.id,targetIds)),r=>r.payslipId):[];
 const downstream=[...await downstreamFactsTx(tx,targets)].sort(([a],[b])=>byText(a,b));
 return{names,records,latest,first,snapshots,collisions,runs,periods:periodRows,targets,downstream};
}
type PlanRecordFacts=Awaited<ReturnType<typeof planRecordFactsTx>>;
/** The plan's master and authority facts around the per-record ones (companies and cycles in payroll scope, each
 * company's permission, and what `analyze` read for each company of the file). */
type PlanFacts={companies:unknown[];cycleRows:unknown[];permissions:[string,boolean][];analyze:[string,unknown][];records:PlanRecordFacts};
export type HistoryPlanFactKeys={permissionCompanies:string[];analyzeCompanies:string[];keys:PlanKey[]};
const factsDigest=(facts:PlanFacts)=>hash(canonical(facts));
async function scopeFactsTx(tx:Tx){
 const companies=await tx.select({id:company.id,name:company.legalName,label:company.companyLabel,registration:company.registrationNo,currency:company.currency}).from(company)
  .where(and(isNull(company.archivedAt),sql`app.can_admin_payroll_for(${company.id})`));
 const cycleRows=await tx.select({id:payrollCycle.id,companyId:payrollCycle.companyId,name:payrollCycle.name,code:payrollCycle.code}).from(payrollCycle).where(isNull(payrollCycle.archivedAt));
 return{companies,cycleRows};
}
async function permitted(tx:Tx,ctx:SessionContext,companyId:string){
 try{await permission(tx,ctx,companyId,'import');return true;}catch(error){if(!(error instanceof PayrollHistoryRevisionError))throw error;return false;}
}
async function planRowsWithFacts(tx:Tx,ctx:SessionContext,records:PayrollHistoryRecord[],sourceHash:string):Promise<{plan:HistoryRevisionPlan;digest:string;factKeys:HistoryPlanFactKeys}>{
 const plan=emptyPlan(sourceHash);
 const facts:PlanFacts={companies:[],cycleRows:[],permissions:[],analyze:[],records:await planRecordFactsTx(tx,[])};
 const sealed=()=>({plan:seal(plan),digest:factsDigest(facts),factKeys:{permissionCompanies:facts.permissions.map(([id])=>id),analyzeCompanies:facts.analyze.map(([id])=>id),keys:[]}});
 if(!records.length){plan.issues.push({rowNum:1,reason:'The source file has no data rows.'});plan.counts.invalid=1;return sealed();}
 const {companies,cycleRows}=await scopeFactsTx(tx);
 facts.companies=sortBy(companies,c=>c.id);facts.cycleRows=sortBy(cycleRows,c=>c.id);
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
  if(!permissionCache.has(co.id))permissionCache.set(co.id,await permitted(tx,ctx,co.id));
  if(!permissionCache.get(co.id)){plan.rows.push(invalidRow(index+2,input,'Payroll history import permission is unavailable for this company.'));continue;}
  const amount=readHistoryField(input,'amount').replace(/[,_\s]/g,'');
  const numeric=/^\d+(?:\.\d{1,2})?$/.test(amount);
  const [whole,fraction='']=amount.split('.');
  if(!numeric||(numeric&&BigInt(whole+fraction.padEnd(2,'0'))>BigInt(999999999999))){plan.rows.push(invalidRow(index+2,input,'Enter a non-negative amount with at most two decimal places within the supported payroll range.'));continue;}
  const cycle=cycles[0],groupKey=co.id+':'+cycle.id;
  const group=groups.get(groupKey)??{company:co,cycle,records:[],indices:[]};
  group.records.push(input);group.indices.push(index+2);groups.set(groupKey,group);
 }
 facts.permissions=[...permissionCache].sort(([a],[b])=>byText(a,b));
 // Each group's months, as the commit owner resolves them; then every resolved month's facts in one set of reads.
 const analyzed=new Map<string,unknown>();
 const prepared:{group:typeof groups extends Map<string,infer G>?G:never;result:Awaited<ReturnType<typeof preparePayrollHistoryRevisionTx>>}[]=[];
 for(const group of groups.values())prepared.push({group,result:await preparePayrollHistoryRevisionTx(ctx,tx,group.company.id,group.records,f=>{if(!analyzed.has(group.company.id))analyzed.set(group.company.id,f);})});
 facts.analyze=[...analyzed].sort(([a],[b])=>byText(a,b));
 const keys:PlanKey[]=[];
 for(const {group,result} of prepared)for(const month of result.preview.months){const resolved=result.months.find(m=>m.month.key===month.key);if(resolved)keys.push({companyId:group.company.id,employmentId:resolved.employmentId,period:month.period,cycleId:group.cycle.id});}
 facts.records=await planRecordFactsTx(tx,keys);
 // Board 154511c4 — each employee's dated company, read once for the whole plan, so a month recorded under a
 // company the employee was not in (by their employment history) is pointed out before the import.
 const placementIds=[...new Set(keys.map(key=>key.employmentId))];
 const placements=placementIds.length?await tx.select({employmentId:assignment.employmentId,validFrom:assignment.validFrom,validTo:assignment.validTo,companyId:assignment.companyId}).from(assignment).where(and(inArray(assignment.employmentId,placementIds),isNull(assignment.supersededAt))):[];
 const inCompanyDuring=(employmentId:string,companyId:string,period:string)=>{
  const first=period+'-01',[y,m]=period.split('-').map(Number),last=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);
  const spans=placements.filter(p=>p.employmentId===employmentId&&p.companyId!==null&&p.validFrom<=last&&(p.validTo===null||p.validTo>first));
  return !spans.length||spans.some(p=>p.companyId===companyId);
 };
 const f=facts.records;
 const nameOf=new Map(f.names.map(r=>[r.id,r.name])),recordOf=new Map(f.records.map(r=>[planKey(r),r])),latestOf=new Map(f.latest.map(r=>[r.recordId,r])),firstOf=new Map(f.first.map(r=>[r.recordId,r]));
 const snapshotOf=new Map(f.snapshots.map(r=>[r.id,r])),periodOf=new Map(f.periods),targetOf=new Map(f.targets.map(r=>[r.payslipId,r])),downstreamOf=new Map(f.downstream);
 const cycleMatch=(cycleId:string|null,wanted:string)=>cycleId===null||cycleId===wanted;
 /** d28501b8 r2 — what has already gone out from the payroll an overwrite would replace. Shown for the user to
  * acknowledge; never a refusal. The figures were final when these were produced, and nothing here redoes them. */
 const overwriteWarnings=(row:Pick<HistoryRevisionRow,'companyId'|'period'>,targetPayslipId:string|null|undefined)=>{
  const warnings:string[]=[],year=row.period.slice(0,4),period=periodOf.get(row.companyId+':'+row.period)!;
  if(period.later)warnings.push(`Payroll processed in AIHR for ${row.period} or a later month of ${year} was worked out from the figures now on file. Tax (PCB) already deducted is not recalculated.`);
  if(period.reports)warnings.push(`A statutory return or report was already generated for ${row.period} or later in ${year}. It is not regenerated or resubmitted.`);
  const batch=targetPayslipId?targetOf.get(targetPayslipId):undefined;
  if(batch){
   const downstream=downstreamOf.get(batch.id)!;
   if(downstream.paymentDisbursed)warnings.push('A bank payment file was already exported for this payroll. It is not re-sent.');
   if(!batch.history)warnings.push('The employee was issued a payslip for this month. It stays as issued; HR records and reports use the overwritten figures.');
  }
  return warnings;
 };
 for(const {group,result:prepared_} of prepared){
  const rowNumber=(number:number)=>group.indices[number-2]??number;
  for(const problem of prepared_.preview.issues)if(problem.status!=='Warning')plan.issues.push({rowNum:rowNumber(problem.rowNum),reason:problem.description});
  for(const missing of prepared_.preview.missingColumns)plan.issues.push({rowNum:1,reason:'Missing required column: '+historyColumnLabel(missing)});
  for(const month of prepared_.preview.months){
   const resolved=prepared_.months.find(m=>m.month.key===month.key),rowNums=month.rowNums.map(rowNumber);
   const reasons=prepared_.preview.issues.filter(issue=>issue.status!=='Warning'&&month.rowNums.includes(issue.rowNum)).map(issue=>issue.description);
   const values:ImportedPayrollValues|null=resolved?{basicSalary:resolved.basicSalary.toFixed(2),allowance:resolved.allowance.toFixed(2),overtimePay:resolved.overtimePay.toFixed(2),bonus:resolved.bonus.toFixed(2),grossPay:resolved.grossPay.toFixed(2),statutory:resolved.statutory,
    otherDeductions:resolved.otherDeductions.toFixed(2),totalDeductions:resolved.totalDeductions.toFixed(2),netPay:resolved.netPay.toFixed(2),employerCost:resolved.employerCost.toFixed(2)}:null;
   if(values&&Object.entries(values).some(([name,value])=>name!=='statutory'&&(!Number.isFinite(Number(value))||Math.abs(Number(value))>9999999999.99)))reasons.push('An accumulated payroll amount exceeds the supported range.');
   const row:HistoryRevisionRow={companyId:group.company.id,companyName:group.company.name,currency:group.company.currency,employmentId:resolved?.employmentId??'',employeeNo:month.employeeNo,period:month.period,cycleId:group.cycle.id,cycleName:group.cycle.name,rowNums,
    operation:resolved&&!reasons.length?'create':'invalid',reasons,recordId:null,expectedRevisionId:null,expectedSnapshotId:null,values,beforeValues:null,valueHash:values?hash(canonical(values)):null,
    overwrite:true,codes:month.codes,protected:false,employeeName:resolved?nameOf.get(resolved.employmentId)??null:null,
    overwriteSource:null,expectedOrdinaryPayslipId:null,warnings:[]};
   if(resolved&&/^\d{4}-\d{2}$/.test(row.period)&&!inCompanyDuring(row.employmentId,row.companyId,row.period))row.otherCompany=true;
   if(resolved){
    const existing=recordOf.get(planKey(row));
    const latest=existing?latestOf.get(existing.id):undefined;
    row.recordId=existing?.id??null;row.expectedRevisionId=latest?.id??null;row.expectedSnapshotId=latest?.snapshotId??null;
    if(row.expectedSnapshotId){
     const current=snapshotOf.get(row.expectedSnapshotId);
     row.beforeValues=(current?.values as ImportedPayrollValues|undefined)??null;
     row.operation=current?.valueHash===row.valueHash?'unchanged':'replace';
    }
    // d28501b8 r2 — payroll on file for this identity. Read under the effective-only policy, so a processed
    // payslip that an earlier import already set aside is not seen again.
    const collisions=f.collisions.filter(p=>p.employmentId===row.employmentId&&p.companyId===row.companyId&&p.payPeriod===row.period&&cycleMatch(p.cycleId,row.cycleId));
    const others=collisions.filter(p=>p.id!==row.expectedSnapshotId);
    const open=f.runs.some(b=>b.companyId===row.companyId&&b.payPeriod===row.period&&b.status!=='closed'&&cycleMatch(b.cycleId,row.cycleId));
    if(open)row.reasons.push('Payroll for this period and Pay Cycle is still open in Payroll. Finish or discard it there before importing.');
    else if(others.length>1)row.reasons.push('More than one payroll result is on file for this employee, period and Pay Cycle, so the record to overwrite cannot be identified safely.');
    else if(others.length===1){
     const target=others[0];
     if(target.history||row.recordId)row.reasons.push('An earlier imported result for this identity predates import history and cannot be overwritten safely.');
     else{
      const before:ImportedPayrollValues={basicSalary:target.basicSalary,allowance:target.allowance,overtimePay:target.overtimePay,bonus:target.bonus,grossPay:target.grossPay,statutory:target.statutory as Record<string,unknown>,
       otherDeductions:target.otherDeductions,totalDeductions:target.totalDeductions,netPay:target.netPay,employerCost:target.employerCost};
      row.expectedOrdinaryPayslipId=target.id;row.beforeValues=before;row.overwriteSource='processed';
      row.operation=hash(canonical(before))===row.valueHash?'unchanged':'replace';
     }
    }else if(row.recordId){
     const first=firstOf.get(row.recordId);
     row.overwriteSource=first?.kind==='adopted'?'processed':'imported';
    }
    if(!row.reasons.length&&row.operation!=='unchanged'){
     row.warnings=overwriteWarnings(row,row.expectedOrdinaryPayslipId??row.expectedSnapshotId);
     if(row.operation==='create'&&!others.length){
      const ordinaryRun=f.runs.some(b=>b.companyId===row.companyId&&b.payPeriod===row.period&&cycleMatch(b.cycleId,row.cycleId));
      if(ordinaryRun)row.warnings.push('A payroll run was processed in AIHR for this period without this employee. The imported record is added beside it.');
     }
    }
   }
   if(row.reasons.length||!values)row.operation='invalid';
   plan.rows.push(row);
  }
 }
 // A valid individual record can still overflow its company/period/cycle batch.
 // Exclude unchanged rows exactly as commit does; they produce no new batch money.
 const batchGroups=new Map<string,HistoryRevisionRow[]>();
 for(const row of plan.rows)if(row.operation==='create'||row.operation==='replace'){
  const identity=[row.companyId,row.period,row.cycleId].join(':'),rows=batchGroups.get(identity)??[];rows.push(row);batchGroups.set(identity,rows);
 }
 for(const rows of batchGroups.values()){
  const totals=emptyBatchTotals();let overflow=false;
  for(const row of rows){addBatchTotals(totals,row.values!);overflow=overflow||batchTotalsOverflow(totals);}
  if(overflow)for(const row of rows){row.operation='invalid';row.reasons.push('An accumulated batch total exceeds the supported range. Split the source file.');}
 }
 plan.rows.sort((a,b)=>(a.rowNums[0]??0)-(b.rowNums[0]??0));
 plan.companyIds=[...new Set(plan.rows.filter(row=>row.companyId).map(row=>row.companyId))].sort();
 for(const row of plan.rows)plan.counts[row.operation==='create'?'created':row.operation==='replace'?'replaced':row.operation]++;
 if(plan.issues.length&&!plan.counts.invalid)plan.counts.invalid=1;
 return{plan:seal(plan),digest:factsDigest(facts),factKeys:{permissionCompanies:facts.permissions.map(([id])=>id),analyzeCompanies:facts.analyze.map(([id])=>id),keys}};
}
async function planRows(tx:Tx,ctx:SessionContext,records:PayrollHistoryRecord[],sourceHash:string):Promise<HistoryRevisionPlan>{
 return (await planRowsWithFacts(tx,ctx,records,sourceHash)).plan;
}
/** Re-read every fact a plan was made from, by the keys planning recorded, and digest it exactly as planning did.
 * Equal digests mean equal inputs, so re-planning would produce the same plan; this is how a staged confirm's release
 * proves "nothing changed since the plan" in a fixed number of reads instead of re-planning the whole file. */
export async function historyPlanFactsDigestTx(tx:Tx,ctx:SessionContext,keys:HistoryPlanFactKeys){
 const {companies,cycleRows}=await scopeFactsTx(tx);
 const facts:PlanFacts={companies:sortBy(companies,c=>c.id),cycleRows:sortBy(cycleRows,c=>c.id),permissions:[],analyze:[],records:await planRecordFactsTx(tx,keys.keys)};
 for(const id of keys.permissionCompanies)facts.permissions.push([id,await permitted(tx,ctx,id)]);
 for(const id of keys.analyzeCompanies)facts.analyze.push([id,await historyAnalyzeFactsTx(ctx,tx,id)]);
 return factsDigest(facts);
}

export async function previewPayrollHistoryUpload(ctx:SessionContext,input:{name:string;mimeType?:string;content:Buffer;operationKey?:string}){
 assertModuleGate(ctx,'payroll');
 const name=(input.name.split(/[\\/]/).pop()??'payroll-history.csv').slice(0,255)||'payroll-history.csv';
 if(input.content.length>10485760)fail('Choose a file no larger than 10 MB.');
 const sourceHash=hash(input.content),operationKey=input.operationKey&&uuid.test(input.operationKey)?input.operationKey:randomUUID();
 let records:PayrollHistoryRecord[]=[],parseError:string|undefined;
 try{records=await parsePayrollHistorySource(name,input.content);}catch(error){parseError=error instanceof PayrollHistoryRevisionError?error.message:'This source file could not be read.';}
 const priorTx=async(tx:Tx)=>{
  const [prior]=await tx.select({id:attempt.id,sourceHash:attempt.sourceHash,plan:attempt.plan}).from(attempt).where(and(eq(attempt.createdBy,ctx.userId!),eq(attempt.operationKey,operationKey)));
  if(prior&&prior.sourceHash!==sourceHash)fail('This upload operation already identifies a different file.');
  return prior?{attemptId:prior.id,plan:prior.plan}:null;
 };
 // The plan is validated in one read-only snapshot with no tenant-wide lock: a history writer commits whole, so the
 // snapshot sees it all or nothing (as the shared history barrier made it before), and the database refuses any
 // write in it. Confirming re-plans under the history write lock and refuses a plan that changed.
 const planned=await withTenant(ctx,async tx=>{
  await principal(tx,ctx);
  const prior=await priorTx(tx);if(prior)return prior;
  return {attemptId:null,plan:parseError?seal({...emptyPlan(sourceHash),issues:[{rowNum:1,reason:parseError}],counts:{created:0,replaced:0,unchanged:0,invalid:1}}):await planRows(tx,ctx,records,sourceHash)};
 },{readOnlySnapshot:true});
 if(planned.attemptId)return {attemptId:planned.attemptId,plan:planned.plan};
 const plan=planned.plan;
 return withTenant(ctx,async tx=>{
  await principal(tx,ctx);
  const prior=await priorTx(tx);if(prior)return prior;
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
export type HistoryConfirmInput={attemptId:string;previewHash:string;confirmReplacement:boolean;skipReplacements?:boolean;selectedRecordKeys?:string[];acknowledgeWarnings?:boolean;expectedCompanyId?:string};
type AttemptRow=typeof attempt.$inferSelect;
/** The confirm's checks on the attempt as it was validated, in the single transaction's order: authority, the
 * selection rules and the acknowledgement. `confirmed` when an earlier confirmation already committed it. */
async function confirmChecksTx(tx:Tx,ctx:SessionContext,input:HistoryConfirmInput,lock:boolean):Promise<{source:AttemptRow;confirmed:typeof historyEvent.$inferSelect|null;applies:(row:HistoryRevisionRow)=>boolean}>{
 await principal(tx,ctx);
 const query=tx.select().from(attempt).where(eq(attempt.id,input.attemptId)),[source]=lock?await query.for('update'):await query;if(!source)fail('Import attempt unavailable.');
 for(const id of source.companyIds)await permission(tx,ctx,id,'import');
 if(input.expectedCompanyId&&(!uuid.test(input.expectedCompanyId)||source.companyIds.some(id=>id!==input.expectedCompanyId)))fail('This record-based import is restricted to its selected company. Use the original-file workflow for a multi-company import.');
 const events=await tx.select().from(historyEvent).where(eq(historyEvent.attemptId,source.id));
 if(events.some(event=>event.kind==='reverted'))fail('This import was reverted. Validate a new upload to import again.');
 const confirmed=events.find(event=>event.kind==='confirmed')??null;
 const skip=!!input.skipReplacements&&!input.confirmReplacement;
 const selected=input.selectedRecordKeys?new Set(input.selectedRecordKeys):null;
 const applies=(row:HistoryRevisionRow)=>row.operation==='create'||(row.operation==='replace'&&!skip&&(selected?selected.has(historyRecordKey(row)):input.confirmReplacement));
 if(confirmed)return{source,confirmed,applies};
 if(input.previewHash!==source.plan.previewHash||source.plan.counts.invalid||source.plan.issues.length)fail('Correct the file and validate a new attempt before confirming.');
 if(source.plan.counts.replaced&&!input.confirmReplacement&&!skip&&!selected)fail('Confirm replacement of the existing imported history before continuing.');
 if(selected?.size&&!input.confirmReplacement)fail('Confirm replacement of the existing imported history before continuing.');
 if(skip&&!source.plan.counts.created)fail('This file has no new records. Confirm the replacement or cancel.');
 if(source.plan.counts.replaced&&!source.plan.rows.some(applies))fail('Nothing is selected to import. Tick the records to overwrite, or cancel.');
 if(source.plan.rows.some(row=>applies(row)&&row.warnings?.length)&&!input.acknowledgeWarnings)fail('Acknowledge what has already gone out for these months before continuing.');
 return{source,confirmed:null,applies};
}
/** The rows a confirm locks FOR SHARE before re-reading its plan (companies, employments, cycles), as before. */
async function shareMasterRowsTx(tx:Tx,source:AttemptRow){
 if(source.companyIds.length)await tx.select({id:company.id}).from(company).where(inArray(company.id,source.companyIds)).orderBy(asc(company.id)).for('share');
 const employmentIds=[...new Set(source.plan.rows.map(row=>row.employmentId).filter(Boolean))].sort(),cycleIds=[...new Set(source.plan.rows.map(row=>row.cycleId).filter(Boolean))].sort();
 if(employmentIds.length)await tx.select({id:employment.id}).from(employment).where(inArray(employment.id,employmentIds)).orderBy(asc(employment.id)).for('share');
 if(cycleIds.length)await tx.select({id:payrollCycle.id}).from(payrollCycle).where(inArray(payrollCycle.id,cycleIds)).orderBy(asc(payrollCycle.id)).for('share');
}
/** A history change being committed by the background job (core/payroll-history-job.ts) holds the tenant's one open
 * stage; a single-transaction writer would race its staged rows, so it is refused until the stage closes. */
async function refuseWhileStagedTx(tx:Tx){
 const [row]=await tx.execute<{busy:boolean}>(sql`select app.payroll_history_stage_busy(null) as busy`);
 if(row?.busy)fail('Another payroll history import or recovery is being committed. Try again when it finishes.');
}
/** `skipReplacements` (d28501b8) imports only the new records and leaves every earlier result as it is.
 * `selectedRecordKeys` (r2) replaces only the ticked records; `acknowledgeWarnings` is required when any
 * applied record carries warnings about what has already gone out.
 *
 * The single-transaction confirm, kept for the trusted record-based and chat paths; the Import Payroll History
 * screen commits through the staged job (`requestPayrollHistoryConfirm`), which writes the same rows. */
export async function confirmPayrollHistoryUpload(ctx:SessionContext,input:HistoryConfirmInput){
 assertModuleGate(ctx,'payroll');if(!uuid.test(input.attemptId))fail('Import attempt unavailable.');
 try{return await withTenant(ctx,async tx=>{
  await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  const {source,confirmed,applies}=await confirmChecksTx(tx,ctx,input,true);
  // importedRows: the source rows THIS call applied (none when an earlier confirmation already committed the attempt).
  if(confirmed)return {attemptId:source.id,counts:source.plan.counts,changes:confirmed.changes,alreadyCommitted:true,importedRows:0};
  await refuseWhileStagedTx(tx);
  await shareMasterRowsTx(tx,source);
  const fresh=await planRows(tx,ctx,await parsePayrollHistorySource(source.sourceName,source.sourceContent),source.sourceHash);
  if(fresh.previewHash!==source.plan.previewHash||fresh.counts.invalid)fail('The source, master data, permissions or target revisions changed. Validate a new attempt.');
  const changes:HistoryRevisionChange[]=[];
  const groups=new Map<string,HistoryRevisionRow[]>();
  for(const row of fresh.rows)if(applies(row)){
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
   const totals=emptyBatchTotals();
   for(const row of rows){
    const {recordId,slipId,previous}=await writeRecordPayslipTx(tx,ctx,source.id,batch.id,row);
    addBatchTotals(totals,row.values!);
    if(batchTotalsOverflow(totals))fail('An accumulated batch total exceeds the supported range. Split the source file.');
    pending.push({row,recordId,slipId,previous});
   }
   await tx.update(payrollBatch).set({employeeCount:rows.length,totals:Object.fromEntries(Object.entries(totals).map(([name,value])=>[name,Number(value)/100])),status:'closed'}).where(eq(payrollBatch.id,batch.id));
   if(!parent||parent.status!=='closed')await tx.update(payPeriod).set({status:'closed'}).where(eq(payPeriod.id,parentId));
   for(const item of pending)changes.push(await writeSnapshotRevisionTx(tx,ctx,source.id,item));
  }
  const skippedReplacements=fresh.rows.filter(row=>row.operation==='replace'&&!applies(row)).length;
  await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:source.id,kind:'confirmed',actorId:ctx.userId!,changes,detail:{counts:fresh.counts,skippedReplacements}});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:source.id,eventType:'payroll-history-import.committed',actor:actorOf(ctx),payload:{counts:fresh.counts,skippedReplacements,changes}});
  const importedRows=fresh.rows.filter(applies).reduce((sum,row)=>sum+row.rowNums.length,0);
  return {attemptId:source.id,counts:fresh.counts,changes,skippedReplacements,alreadyCommitted:false,importedRows};
 });}catch(error){await failureEvent(ctx,input.attemptId,'failed',error);throw error;}
}
/** One record's identity, its adoption of a processed payslip (d28501b8 r2: the processed payslip enters history as
 * the record's first revision, set aside by the correction; the database checks the adopted values are that
 * payslip's own columns) and its imported payslip. Shared by the single transaction and the staged job's steps. */
async function writeRecordPayslipTx(tx:Tx,ctx:SessionContext,attemptId:string,batchId:string,row:HistoryRevisionRow){
 if(!row.values||!row.valueHash||row.operation==='invalid')fail('The file contains an invalid record.');
 let recordId=row.recordId;
 if(!recordId){const [created]=await tx.insert(record).values({tenantId:ctx.tenantId,companyId:row.companyId,employmentId:row.employmentId,period:row.period,cycleId:row.cycleId}).returning({id:record.id});recordId=created.id;}
 let [current]=await tx.select().from(revision).where(eq(revision.recordId,recordId)).orderBy(desc(revision.ordinal)).limit(1);
 if((current?.id??null)!==row.expectedRevisionId)fail('A target revision changed. Validate a new attempt.');
 if(row.expectedOrdinaryPayslipId){
  if(!row.beforeValues)fail('The payroll on file could not be read. Validate a new attempt.');
  await tx.insert(snapshot).values({id:row.expectedOrdinaryPayslipId,tenantId:ctx.tenantId,recordId,valueHash:hash(canonical(row.beforeValues)),values:row.beforeValues});
  [current]=await tx.insert(revision).values({tenantId:ctx.tenantId,recordId,ordinal:1,attemptId,snapshotId:row.expectedOrdinaryPayslipId,previousRevisionId:null,kind:'adopted',cycleName:row.cycleName}).returning();
 }
 const [slip]=await tx.insert(payslip).values({tenantId:ctx.tenantId,batchId,employmentId:row.employmentId,...row.values}).returning({id:payslip.id});
 return{recordId,slipId:slip.id,previous:current as typeof revision.$inferSelect|undefined};
}
async function writeSnapshotRevisionTx(tx:Tx,ctx:SessionContext,attemptId:string,item:{row:HistoryRevisionRow;recordId:string;slipId:string;previous:typeof revision.$inferSelect|undefined}):Promise<HistoryRevisionChange>{
 const {row,recordId,slipId,previous}=item;
 await tx.insert(snapshot).values({id:slipId,tenantId:ctx.tenantId,recordId,valueHash:row.valueHash!,values:row.values!});
 const [createdRevision]=await tx.insert(revision).values({tenantId:ctx.tenantId,recordId,ordinal:(previous?.ordinal??0)+1,attemptId,snapshotId:slipId,previousRevisionId:previous?.id??null,kind:row.expectedSnapshotId||row.expectedOrdinaryPayslipId?'correction':'import',cycleName:row.cycleName}).returning({id:revision.id});
 return{recordId,revisionId:createdRevision.id,previousRevisionId:previous?.id??null,snapshotId:slipId};
}

// ── Staged confirm and revert (core/payroll-history-job.ts drives them on the shared bulk-job kernel) ────────────
/** The transaction-local setting that makes this transaction's inserts belong to its job's stage (5055), and shows it
 * the rows its stage wrote. Only the job's chunk and release transactions set it. */
export async function joinPayrollHistoryStageTx(tx:Tx,stageId:string){await tx.execute(sql`select set_config('app.payroll_history_stage',${stageId},true)`);}
/** Whether another history job's stage is open in this tenant (the job then waits its turn; it never refuses). */
export async function payrollHistoryStageBusyTx(tx:Tx,stageId:string){
 const [row]=await tx.execute<{busy:boolean}>(sql`select app.payroll_history_stage_busy(${stageId}::uuid) as busy`);return row?.busy===true;
}
/** Open the job's stage for its attempt; false while another stage of the tenant is open. */
export async function openPayrollHistoryStageTx(tx:Tx,stageId:string,attemptId:string,operation:'confirm'|'revert'){
 const [row]=await tx.execute<{opened:boolean}>(sql`select app.payroll_history_stage_open(${stageId}::uuid,${attemptId}::uuid,${operation}) as opened`);return row?.opened===true;
}
/** One staged group (company, period, Pay Cycle): its batch's fixed fields, and the totals the single transaction
 * accumulated over the same rows in the same order (integer cents, as text). */
export type StagedHistoryGroup={companyId:string;period:string;cycleId:string;cycleName:string;statutoryVersion:string;employeeCount:number;totals:Record<string,string>};
/** A staged confirm, planned: the same checks and re-plan the single transaction made, without any write lock. */
export type StagedHistoryConfirm={alreadyCommitted:true;result:Record<string,unknown>}|{alreadyCommitted:false;attemptId:string;companyIds:string[];digest:string;factKeys:HistoryPlanFactKeys;
 groups:StagedHistoryGroup[];rows:{group:number;row:HistoryRevisionRow}[];counts:HistoryRevisionPlan['counts'];skippedReplacements:number;importedRows:number};
/** Web side of a staged confirm: the attempt's checks under the caller's authority (a refusal records the failure, as
 * the single transaction did). Short; reads the attempt only. */
export async function checkPayrollHistoryConfirm(ctx:SessionContext,input:HistoryConfirmInput){
 assertModuleGate(ctx,'payroll');if(!uuid.test(input.attemptId))fail('Import attempt unavailable.');
 try{return await withTenant(ctx,async tx=>{
  const {source,confirmed}=await confirmChecksTx(tx,ctx,input,false);
  return confirmed?{alreadyCommitted:true as const,companyIds:source.companyIds,result:{attemptId:source.id,counts:source.plan.counts,changes:confirmed.changes.length,alreadyCommitted:true,importedRows:0}}
   :{alreadyCommitted:false as const,companyIds:source.companyIds};
 });}catch(error){await failureEvent(ctx,input.attemptId,'failed',error);throw error;}
}
/** The job's prepare: the checks, the source parsed and the whole file re-planned in one read-only snapshot (no
 * lock), refused exactly when the single transaction would have refused, with the digest of every fact the plan read
 * (for the release) and the applied rows in the single transaction's order. */
export async function planStagedPayrollHistoryConfirm(ctx:SessionContext,input:HistoryConfirmInput):Promise<StagedHistoryConfirm>{
 return withTenant(ctx,async tx=>{
  const {source,confirmed,applies}=await confirmChecksTx(tx,ctx,input,false);
  if(confirmed)return{alreadyCommitted:true,result:{attemptId:source.id,counts:source.plan.counts,changes:confirmed.changes.length,alreadyCommitted:true,importedRows:0}};
  const {plan:fresh,digest,factKeys}=await planRowsWithFacts(tx,ctx,await parsePayrollHistorySource(source.sourceName,source.sourceContent),source.sourceHash);
  if(fresh.previewHash!==source.plan.previewHash||fresh.counts.invalid)fail('The source, master data, permissions or target revisions changed. Validate a new attempt.');
  const groupOf=new Map<string,number>(),groups:StagedHistoryGroup[]=[],rows:{group:number;row:HistoryRevisionRow}[]=[];
  const totals:BatchTotals[]=[];
  for(const row of fresh.rows)if(applies(row)){
   if(!row.values||!row.valueHash||row.operation==='invalid')fail('The file contains an invalid record.');
   const groupKey=[row.companyId,row.period,row.cycleId].join(':');
   let index=groupOf.get(groupKey);
   if(index===undefined){index=groups.length;groupOf.set(groupKey,index);totals.push(emptyBatchTotals());
    groups.push({companyId:row.companyId,period:row.period,cycleId:row.cycleId,cycleName:row.cycleName,statutoryVersion:String(row.values?.statutory.version??''),employeeCount:0,totals:{}});}
   addBatchTotals(totals[index],row.values);
   if(batchTotalsOverflow(totals[index]))fail('An accumulated batch total exceeds the supported range. Split the source file.');
   groups[index].employeeCount++;rows.push({group:index,row});
  }
  // Rows of one group are written together, groups in the order the single transaction wrote them.
  rows.sort((a,b)=>a.group-b.group);
  groups.forEach((group,i)=>{group.totals=Object.fromEntries(Object.entries(totals[i]).map(([name,value])=>[name,value.toString()]));});
  return{alreadyCommitted:false,attemptId:source.id,companyIds:source.companyIds,digest,factKeys,groups,rows,counts:fresh.counts,
   skippedReplacements:fresh.rows.filter(row=>row.operation==='replace'&&!applies(row)).length,importedRows:fresh.rows.filter(applies).reduce((sum,row)=>sum+row.rowNums.length,0)};
 },{readOnlySnapshot:true});
}
/** A staged group's batch: a draft with no pay period yet (5055), invisible until the release. */
export async function stageHistoryBatchTx(tx:Tx,ctx:SessionContext,attemptId:string,group:StagedHistoryGroup){
 const [row]=await tx.execute<{id:string}>(sql`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,run_type,run_seq,status,batch_date,payroll_cycle_id,remarks,history_import_attempt_id,history_import_cycle_name)
  values(${ctx.tenantId}::uuid,${group.companyId}::uuid,null,${group.period},'adjustment',0,'draft',${todayInKualaLumpur()}::date,${group.cycleId}::uuid,'Imported payroll history',${attemptId}::uuid,${group.cycleName}) returning id`);
 return row.id;
}
/** One staged record: everything the single transaction wrote for it, in its order (its snapshot and revision after
 * its payslip; the batch closes in the release). */
export async function stageHistoryRowTx(tx:Tx,ctx:SessionContext,attemptId:string,batchId:string,row:HistoryRevisionRow){
 const written=await writeRecordPayslipTx(tx,ctx,attemptId,batchId,row);
 return writeSnapshotRevisionTx(tx,ctx,attemptId,{row,...written});
}
/** The staged confirm's release, in one short transaction: the history and Access write locks the single transaction
 * held, the same checks on the attempt, then every fact the plan read is read again and digested. An unchanged digest
 * proves the plan is unchanged; then each group's pay period is resolved or created, its run sequence allocated and
 * its batch closed with the same totals, the same `confirmed` history event and `committed` audit event are written,
 * and the stage is released, which makes every staged row visible at once. A changed digest returns 'recheck'
 * (nothing written): the job re-plans without locks and either refuses or releases again. */
export async function releaseStagedPayrollHistoryConfirmTx(tx:Tx,ctx:SessionContext,p:{stageId:string;input:HistoryConfirmInput;digest:string;factKeys:HistoryPlanFactKeys;
 groups:(StagedHistoryGroup&{batchId:string})[];changes:HistoryRevisionChange[];counts:HistoryRevisionPlan['counts'];skippedReplacements:number}):Promise<'released'|'recheck'>{
 await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
 const {source,confirmed}=await confirmChecksTx(tx,ctx,p.input,true);
 if(confirmed)fail('This import was already committed.');
 await shareMasterRowsTx(tx,source);
 // Read without the stage setting, so the plan's facts are read exactly as the plan saw them (the staged rows hidden).
 if(await historyPlanFactsDigestTx(tx,ctx,p.factKeys)!==p.digest)return'recheck';
 await joinPayrollHistoryStageTx(tx,p.stageId);
 for(const group of p.groups){
  const [parent]=await tx.select().from(payPeriod).where(and(eq(payPeriod.companyId,group.companyId),eq(payPeriod.period,group.period)));
  let parentId=parent?.id;
  if(!parentId){const [created]=await tx.insert(payPeriod).values({tenantId:ctx.tenantId,companyId:group.companyId,period:group.period,status:'open',statutoryVersion:group.statutoryVersion}).returning({id:payPeriod.id});parentId=created.id;}
  const [max]=await tx.select({seq:sql<number>`coalesce(max(${payrollBatch.runSeq}),0)::integer`}).from(payrollBatch).where(eq(payrollBatch.payPeriodId,parentId));
  const updated=await tx.execute(sql`update payroll_batch set pay_period_id=${parentId}::uuid,run_seq=${Number(max?.seq??0)+1},batch_date=${todayInKualaLumpur()}::date,
    employee_count=${group.employeeCount},totals=${JSON.stringify(Object.fromEntries(Object.entries(group.totals).map(([name,value])=>[name,Number(BigInt(value))/100])))}::jsonb,status='closed'
   where id=${group.batchId}::uuid and status='draft' and pay_period_id is null returning id`);
  if(updated.length!==1)fail('The staged payroll history changed. Validate a new attempt.');
  if(!parent||parent.status!=='closed')await tx.update(payPeriod).set({status:'closed'}).where(eq(payPeriod.id,parentId));
 }
 await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:source.id,kind:'confirmed',actorId:ctx.userId!,changes:p.changes,detail:{counts:p.counts,skippedReplacements:p.skippedReplacements}});
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:source.id,eventType:'payroll-history-import.committed',actor:actorOf(ctx),payload:{counts:p.counts,skippedReplacements:p.skippedReplacements,changes:p.changes}});
 await tx.execute(sql`select app.payroll_history_stage_release(${p.stageId}::uuid)`);
 return'released';
}
/** After a changed digest: the file is re-planned (no lock, read-only snapshot) and must still produce the plan the
 * attempt was validated with; its facts' digest replaces the old one. Otherwise the single transaction's refusal. */
export async function recheckStagedPayrollHistoryConfirm(ctx:SessionContext,input:HistoryConfirmInput){
 const planned=await planStagedPayrollHistoryConfirm(ctx,input);
 if(planned.alreadyCommitted)fail('This import was already committed.');
 return{digest:planned.digest,factKeys:planned.factKeys};
}
/** The reason a failed or stopped confirm/revert records, exactly as the single transaction recorded it. */
export function payrollHistoryFailureReason(error:unknown){return error instanceof PayrollHistoryRevisionError?error.message:'The operation failed; no payroll changes were committed.';}
/** The failure record (history event and audit event) for a staged confirm or revert that did not commit, written in
 * the caller's transaction (the job records it once, with its own marker in the same transaction). */
export async function recordPayrollHistoryFailureTx(tx:Tx,ctx:SessionContext,attemptId:string,kind:'failed'|'revert_failed',reason:string){
 const [found]=await tx.select({id:attempt.id}).from(attempt).where(eq(attempt.id,attemptId));if(!found||!ctx.userId)return false;
 await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId,kind,actorId:ctx.userId,changes:[],detail:{reason}});
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:attemptId,eventType:'payroll-history-import.'+kind,actor:actorOf(ctx),payload:{reason}});
 return true;
}

type RevertSource=Pick<typeof attempt.$inferSelect,'id'|'companyIds'>;
/** The revert's targets and their eligibility, read set-wise (a fixed number of reads for the whole attempt instead
 * of five to eight per record) and judged change by change in the attempt's order, so the first refusal is the one
 * the per-record reads gave. `lock` takes the records FOR UPDATE, in id order. */
async function revertTargetsTx(tx:Tx,ctx:SessionContext,source:RevertSource,lock:boolean){
 for(const companyId of source.companyIds)await permission(tx,ctx,companyId,'revert');
 const events=await tx.select().from(historyEvent).where(eq(historyEvent.attemptId,source.id));
 if(events.some(event=>event.kind==='reverted'))fail('This import has already been reverted.');const confirmed=events.find(event=>event.kind==='confirmed');if(!confirmed?.changes.length)fail('This attempt has no imported changes to revert.');
 const recordIds=[...new Set(confirmed.changes.map(change=>change.recordId))].sort(byText);
 const identityQuery=tx.select().from(record).where(inArray(record.id,recordIds)).orderBy(asc(record.id));
 const identities=new Map((lock?await identityQuery.for('update'):await identityQuery).map(row=>[row.id,row]));
 const visible=[...identities.keys()];
 const latestOf=new Map((visible.length?await tx.selectDistinctOn([revision.recordId]).from(revision).where(inArray(revision.recordId,visible)).orderBy(revision.recordId,desc(revision.ordinal)):[]).map(row=>[row.recordId,row]));
 const previousIds=[...new Set(confirmed.changes.map(change=>change.previousRevisionId).filter((id):id is string=>!!id))].sort(byText);
 const previousOf=new Map((previousIds.length?await tx.select().from(revision).where(inArray(revision.id,previousIds)):[]).map(row=>[row.id,row]));
 // Dependencies of every record whose restored revision is not an adopted processed payslip.
 const dependent=confirmed.changes.map(change=>{const identity=identities.get(change.recordId),previous=change.previousRevisionId?previousOf.get(change.previousRevisionId):undefined;
  return identity&&previous?.kind!=='adopted'?{identity,current:latestOf.get(identity.id)}:null;}).filter((x):x is NonNullable<typeof x>=>!!x);
 const periods=await periodFactsTx(tx,dependent.map(d=>({companyId:d.identity.companyId,period:d.identity.period})));
 const snapshotIds=[...new Set(dependent.map(d=>d.current?.snapshotId).filter((id):id is string=>!!id))].sort(byText);
 const batchOf=new Map((snapshotIds.length?await tx.select({payslipId:payslip.id,id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,releasedAt:payrollBatch.releasedAt,history:payrollBatch.historyImportAttemptId})
  .from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId)).where(inArray(payslip.id,snapshotIds)):[]).map(row=>[row.payslipId,row]));
 const downstream=await downstreamFactsTx(tx,[...batchOf.values()]);
 const dependencies=(row:{companyId:string;period:string;expectedSnapshotId:string|null})=>{
  const reasons:string[]=[],period=periods.get(row.companyId+':'+row.period)!;
  if(period.later)reasons.push('Normally processed payroll already depends on this period or a later period in the same year.');
  if(period.reports)reasons.push('A statutory report has already been generated for an affected period. Resolve that dependency before changing its basis.');
  if(row.expectedSnapshotId){
   const batch=batchOf.get(row.expectedSnapshotId);
   if(!batch)reasons.push('The current imported snapshot is unavailable.');
   else{
    const after=downstream.get(batch.id)!;
    if(after.paymentDisbursed)reasons.push('A payment export already references this history.');
    if(after.statutoryReportCount)reasons.push('A statutory artifact already references this history.');
    if(!batch.history||batch.releasedAt)reasons.push('An issued or legacy payroll result cannot be replaced by this import.');
   }
  }
  return reasons;
 };
 const targets:{change:HistoryRevisionChange;identity:typeof record.$inferSelect;current:typeof revision.$inferSelect;previous:typeof revision.$inferSelect|undefined}[]=[];
 for(const change of confirmed.changes){
  const identity=identities.get(change.recordId);if(!identity)fail('An imported record is unavailable.');
  const current=latestOf.get(identity.id);if(current?.id!==change.revisionId)fail('A later correction or revert changed this record. Revert is no longer safe.');
  const candidate=change.previousRevisionId?previousOf.get(change.previousRevisionId):undefined;
  const previous=candidate&&candidate.recordId===identity.id?candidate:undefined;if(change.previousRevisionId&&!previous)fail('The prior revision is unavailable.');
  // d28501b8 r2 — restoring an adopted processed payslip returns every reader to the figures that
  // payments, returns and later months were produced from, so those are no reason to refuse it.
  if(previous?.kind!=='adopted'){const blocked=dependencies({companyId:identity.companyId,period:identity.period,expectedSnapshotId:current.snapshotId});if(blocked.length)fail(blocked.join(' '));}
  targets.push({change,identity,current,previous});
 }
 const previewHash=hash(canonical({attemptId:source.id,actorId:ctx.userId,eventId:confirmed.id,targets:targets.map(target=>({recordId:target.identity.id,currentRevisionId:target.current.id,restoreSnapshotId:target.previous?.snapshotId??null})).sort((a,b)=>a.recordId.localeCompare(b.recordId))}));
 // What of the eligibility can still change while a staged revert is open: runs processed and statutory reports
 // generated for the dependent months, and statutory artefacts of the current snapshots' batches. Everything else it
 // read is immutable (records, revisions of a closed attempt, closed imported batches) or fenced by the open stage.
 const volatile:RevertVolatileKeys={pairs:sortBy([...new Map(dependent.map(d=>[d.identity.companyId+':'+d.identity.period,{companyId:d.identity.companyId,period:d.identity.period}])).values()],k=>k.companyId+':'+k.period),
  batches:sortBy([...new Map([...batchOf.values()].map(b=>[b.id,{id:b.id,companyId:b.companyId,payPeriod:b.payPeriod}])).values()],b=>b.id)};
 return {targets,previewHash,volatile};
}
type RevertVolatileKeys={pairs:{companyId:string;period:string}[];batches:{id:string;companyId:string;payPeriod:string}[]};
async function revertVolatileDigestTx(tx:Tx,keys:RevertVolatileKeys){
 return hash(canonical({periods:[...await periodFactsTx(tx,keys.pairs)].sort(([a],[b])=>byText(a,b)),downstream:[...await downstreamFactsTx(tx,keys.batches)].sort(([a],[b])=>byText(a,b))}));
}
/** User-requested read-only eligibility review. No recovery event or money changes occur here. */
export async function previewPayrollHistoryRevert(ctx:SessionContext,id:string){
 assertModuleGate(ctx,'payroll');if(!uuid.test(id))fail('Import attempt unavailable.');return withTenant(ctx,async tx=>{
  // A read-only snapshot with no tenant-wide lock (it never held a row): the revert itself re-derives the targets
  // under the history and Access write locks and refuses a preview that changed.
  await principal(tx,ctx);
  const [source]=await tx.select({id:attempt.id,companyIds:attempt.companyIds}).from(attempt).where(eq(attempt.id,id));if(!source)fail('Import attempt unavailable.');const plan=await revertTargetsTx(tx,ctx,source,false);
  return {attemptId:id,count:plan.targets.length,previewHash:plan.previewHash};
 },{readOnlySnapshot:true});
}
export async function revertPayrollHistoryUpload(ctx:SessionContext,id:string,expectedPreviewHash:string){
 assertModuleGate(ctx,'payroll');if(!uuid.test(id)||typeof expectedPreviewHash!=='string'||!/^([0-9a-f]{64})$/.test(expectedPreviewHash))fail('Review the current revert eligibility before confirming.');
 try{return await withTenant(ctx,async tx=>{
  await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);await principal(tx,ctx);
  const [source]=await tx.select({id:attempt.id,companyIds:attempt.companyIds}).from(attempt).where(eq(attempt.id,id)).for('update');if(!source)fail('Import attempt unavailable.');const plan=await revertTargetsTx(tx,ctx,source,true);if(plan.previewHash!==expectedPreviewHash)fail('The revert preview changed. Review eligibility again before confirming.');
  await refuseWhileStagedTx(tx);
  const changes:HistoryRevisionChange[]=[];for(const {identity,current,previous}of plan.targets){
   const [compensation]=await tx.insert(revision).values({tenantId:ctx.tenantId,recordId:identity.id,ordinal:current.ordinal+1,attemptId:id,snapshotId:previous?.snapshotId??null,previousRevisionId:current.id,kind:'revert',cycleName:previous?.cycleName??current.cycleName}).returning({id:revision.id});changes.push({recordId:identity.id,revisionId:compensation.id,previousRevisionId:current.id,snapshotId:previous?.snapshotId??null});
  }
  await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:id,kind:'reverted',actorId:ctx.userId!,changes,detail:{restored:changes.length}});await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:id,eventType:'payroll-history-import.reverted',actor:actorOf(ctx),payload:{changes}});return {attemptId:id,restored:changes.length};
 });}catch(error){await failureEvent(ctx,id,'revert_failed',error);throw error;}
}

const revertPreviewFormat=(id:string,expectedPreviewHash:string)=>{if(!uuid.test(id)||typeof expectedPreviewHash!=='string'||!/^([0-9a-f]{64})$/.test(expectedPreviewHash))fail('Review the current revert eligibility before confirming.');};
/** Web side of a staged revert: authority and the attempt's state, without the per-record eligibility (the job's
 * prepare and release establish that). A refusal records the failure, as the single transaction did. */
export async function checkPayrollHistoryRevert(ctx:SessionContext,id:string,expectedPreviewHash:string){
 assertModuleGate(ctx,'payroll');revertPreviewFormat(id,expectedPreviewHash);
 try{return await withTenant(ctx,async tx=>{
  await principal(tx,ctx);
  const [source]=await tx.select({id:attempt.id,companyIds:attempt.companyIds}).from(attempt).where(eq(attempt.id,id));if(!source)fail('Import attempt unavailable.');
  for(const companyId of source.companyIds)await permission(tx,ctx,companyId,'revert');
  const events=await tx.select({kind:historyEvent.kind,changes:historyEvent.changes}).from(historyEvent).where(eq(historyEvent.attemptId,source.id));
  if(events.some(event=>event.kind==='reverted'))fail('This import has already been reverted.');if(!events.find(event=>event.kind==='confirmed')?.changes.length)fail('This attempt has no imported changes to revert.');
  return{companyIds:source.companyIds};
 });}catch(error){await failureEvent(ctx,id,'revert_failed',error);throw error;}
}
/** One revert step: restore the record's previous snapshot by a 'revert' revision on top of its current one. */
export type StagedHistoryRevertTarget={recordId:string;currentRevisionId:string;currentOrdinal:number;restoreSnapshotId:string|null;cycleName:string};
/** The job's prepare: the revert's eligibility, set-wise, in one read-only snapshot (no lock); refused exactly when
 * the single transaction refused (a changed preview, a later correction, a dependency). */
export async function planStagedPayrollHistoryRevert(ctx:SessionContext,id:string,expectedPreviewHash:string){
 revertPreviewFormat(id,expectedPreviewHash);
 return withTenant(ctx,async tx=>{
  await principal(tx,ctx);
  const [source]=await tx.select({id:attempt.id,companyIds:attempt.companyIds}).from(attempt).where(eq(attempt.id,id));if(!source)fail('Import attempt unavailable.');
  const plan=await revertTargetsTx(tx,ctx,source,false);if(plan.previewHash!==expectedPreviewHash)fail('The revert preview changed. Review eligibility again before confirming.');
  return{companyIds:source.companyIds,volatile:plan.volatile,digest:await revertVolatileDigestTx(tx,plan.volatile),
   targets:plan.targets.map(({identity,current,previous}):StagedHistoryRevertTarget=>({recordId:identity.id,currentRevisionId:current.id,currentOrdinal:current.ordinal,
   restoreSnapshotId:previous?.snapshotId??null,cycleName:previous?.cycleName??current.cycleName}))};
 },{readOnlySnapshot:true});
}
export async function stageHistoryRevertTx(tx:Tx,ctx:SessionContext,id:string,target:StagedHistoryRevertTarget):Promise<HistoryRevisionChange>{
 const [compensation]=await tx.insert(revision).values({tenantId:ctx.tenantId,recordId:target.recordId,ordinal:target.currentOrdinal+1,attemptId:id,snapshotId:target.restoreSnapshotId,previousRevisionId:target.currentRevisionId,kind:'revert',cycleName:target.cycleName}).returning({id:revision.id});
 return{recordId:target.recordId,revisionId:compensation.id,previousRevisionId:target.currentRevisionId,snapshotId:target.restoreSnapshotId};
}
/** The staged revert's release: the single transaction's locks and its complete eligibility re-derivation (set-wise,
 * read without the stage setting so the staged revisions stay hidden from it), the same `reverted` history and audit
 * events, then the stage is released. */
export async function releaseStagedPayrollHistoryRevertTx(tx:Tx,ctx:SessionContext,p:{stageId:string;id:string;expectedPreviewHash:string;changes:HistoryRevisionChange[];
 volatile:RevertVolatileKeys;digest:string}):Promise<{attemptId:string;restored:number}|'recheck'>{
 await lockPayrollHistoryWriteTx(tx,ctx.tenantId);await lockAccessConfigurationWriteTx(tx,ctx.tenantId);await principal(tx,ctx);
 const [source]=await tx.select({id:attempt.id,companyIds:attempt.companyIds}).from(attempt).where(eq(attempt.id,p.id)).for('update');if(!source)fail('Import attempt unavailable.');
 for(const companyId of source.companyIds)await permission(tx,ctx,companyId,'revert');
 const events=await tx.select({kind:historyEvent.kind}).from(historyEvent).where(eq(historyEvent.attemptId,source.id));
 if(events.some(event=>event.kind==='reverted'))fail('This import has already been reverted.');
 // The rest of the eligibility cannot have changed since the plan: the records and the attempt's revisions are
 // immutable, the current snapshots' batches are closed imported batches, and the tenant's open stage excludes every
 // other history writer (a revision appended meanwhile would already have refused this job's own staged revision on
 // its chain check). What can change is re-read set-wise and compared; a change re-derives the whole eligibility
 // without locks and refuses exactly as the single transaction would.
 if(await revertVolatileDigestTx(tx,p.volatile)!==p.digest)return'recheck';
 await joinPayrollHistoryStageTx(tx,p.stageId);
 await tx.insert(historyEvent).values({tenantId:ctx.tenantId,attemptId:p.id,kind:'reverted',actorId:ctx.userId!,changes:p.changes,detail:{restored:p.changes.length}});
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'payroll-history-import',aggregateId:p.id,eventType:'payroll-history-import.reverted',actor:actorOf(ctx),payload:{changes:p.changes}});
 await tx.execute(sql`select app.payroll_history_stage_release(${p.stageId}::uuid)`);
 return{attemptId:p.id,restored:p.changes.length};
}

const personName=(actor:ImportActor)=>actor.kind==='person'?actor.name:null;
function labelAttempt<A extends {id:string;createdBy:string},E extends {actorId:string}>(actors:Map<string,ImportRowActors>,row:A,events:E[]){
 const createdByActor=creatorOf(actors,row.id);
 return {...row,createdByActor,createdByName:personName(createdByActor),events:events.map(event=>{const actor=actorOn(actors,row.id,event.actorId);return {...event,actor,actorName:personName(actor)};})};
}
export async function listPayrollHistoryAttempts(ctx:SessionContext,options:{before?:string;limit?:number}={}){
 assertModuleGate(ctx,'payroll');if(options.before&&!uuid.test(options.before))fail('Import cursor unavailable.');return withTenant(ctx,async tx=>{
  await principal(tx,ctx);const limit=Math.min(100,Math.max(1,options.limit??25));
  const rows=await tx.select({id:attempt.id,sourceName:attempt.sourceName,sourceHash:attempt.sourceHash,companyIds:attempt.companyIds,plan:attempt.plan,createdBy:attempt.createdBy,createdAt:attempt.createdAt}).from(attempt)
   .where(options.before?sql`(${attempt.createdAt},${attempt.id}) < (select created_at,id from payroll_history_import_attempt where id=${options.before}::uuid)`:undefined)
   .orderBy(desc(attempt.createdAt),desc(attempt.id)).limit(limit+1);
  const chosen=rows.slice(0,limit),events=chosen.length?await tx.select(getTableColumns(historyEvent)).from(historyEvent).where(inArray(historyEvent.attemptId,chosen.map(row=>row.id))).orderBy(asc(historyEvent.createdAt),asc(historyEvent.id)):[];
  // Board 8d02748a: every recorded actor on the page in ONE set-wise read (no per-row label function).
  const actors=await resolveImportActors(tx,'payroll_history',chosen.map(row=>row.id));
  return {items:chosen.map(row=>labelAttempt(actors,row,events.filter(event=>event.attemptId===row.id))),nextCursor:rows.length>limit?chosen.at(-1)!.id:null};
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
  const events=await tx.select(getTableColumns(historyEvent)).from(historyEvent).where(eq(historyEvent.attemptId,id)).orderBy(asc(historyEvent.createdAt),asc(historyEvent.id));
  const actors=await resolveImportActors(tx,'payroll_history',[id]);
  return labelAttempt(actors,source,events);
 });
}
