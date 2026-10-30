/** Actual app-role SQL/native reset proof, before the Assistant action is mounted. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {assignRole} from '../core/admin';
import {erasePersonPii} from '../core/pdpa';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {createBatch,createLoan,prefillLoansForBatch,generatePayslips,resetProcessedBatchTx,previewReviewedPayrollResetTx,setPayrollPermissionGrant} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,batchId:string,employmentId:string,loanId:string,repId:string,claimId:string,individualId:string,period:string;
const reviewedDigest='b'.repeat(64),intentDigest='c'.repeat(64),reason='Fictional human correction';
const ids=(values:string[])=>sql`ARRAY[${sql.join(values.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
function databaseError(error:unknown){let current=error,code:string|undefined;const messages:string[]=[];for(let i=0;i<8&&current&&typeof current==='object';i++){const row=current as {code?:unknown;message?:unknown;cause?:unknown};if(typeof row.code==='string')code=row.code;if(typeof row.message==='string')messages.push(row.message);current=row.cause;}return{code,message:messages.join('\n')};}
async function refused(work:(tx:Tx)=>Promise<unknown>,message:string,code='P0001'){let failure:unknown;try{await withTenant(ctx,work);}catch(error){failure=error;}expect(failure,'Expected the exact native proof refusal').toBeDefined();const actual=databaseError(failure);expect(actual.code).toBe(code);expect(actual.message).toContain(message);}
async function prepare(){const actionId=randomUUID();await withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{source:{people:string[];sourceDigest:string}}>(sql`select app.payroll_reset_review_context(${batchId}::uuid) as source`);
 const [batch]=await tx.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));
 await tx.execute(sql`select app.assistant_payroll_reset_review_prepare(${actionId}::uuid,${ctx.personId??null}::uuid,${batchId}::uuid,${b.companyId}::uuid,${batch.payPeriodId}::uuid,${ids(row.source.people)},NULL::uuid,ARRAY[]::uuid[],${intentDigest},${reviewedDigest},${'a'.repeat(16)},'fictional-wrapped-key','fictional-proof-fixture-ciphertext',${row.source.sourceDigest})`);
 });return actionId;}
async function arm(tx:Tx,id:string){await previewReviewedPayrollResetTx(tx,ctx,{batchId,reason});await tx.execute(sql`select app.assistant_payroll_reset_review_arm(${id}::uuid,${reason})`);}
async function complete(tx:Tx,id:string,eventId:string){const [row]=await tx.execute<{review:unknown}>(sql`select app.assistant_payroll_reset_review_complete(${id}::uuid,${reviewedDigest},${eventId}::uuid) as review`);return row.review;}
async function state(){return{batch:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId)),slips:await owner.db.select().from(s.payslip).where(eq(s.payslip.tenantId,b.tenantId)).orderBy(s.payslip.id),loans:await owner.db.select().from(s.employeeLoan).where(eq(s.employeeLoan.tenantId,b.tenantId)).orderBy(s.employeeLoan.id),reps:await owner.db.select().from(s.loanRepayment).where(eq(s.loanRepayment.tenantId,b.tenantId)).orderBy(s.loanRepayment.id),claims:await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.tenantId,b.tenantId)).orderBy(s.claimRequest.id),individuals:await owner.db.select().from(s.payrollIndividualTxn).where(eq(s.payrollIndividualTxn.tenantId,b.tenantId)).orderBy(s.payrollIndividualTxn.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),history:await owner.db.select().from(s.payrollStatusHistory).where(eq(s.payrollStatusHistory.tenantId,b.tenantId)).orderBy(s.payrollStatusHistory.id)};}
beforeAll(async()=>{await migrateTestDb();});afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();for(const module of ['payroll','multi_cycle_payroll'] as const)await setModule(b.tenantId,module,'active');
 await setSetting(b.tenantId,'payroll.reset_enabled',true);ctx=await entitledCtx(b,['hr_admin']);
 const [year,month]=todayInKualaLumpur().split('-').map(Number);period=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);
 const hire=await hireEmployee(ctx,{person:{fullName:'Fictional reset proof employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:String(year-1)+'-01-01'});employmentId=hire.employmentId;
 await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:String(year-1)+'-01-01'});await requirePackFor('MY').statutory.set(ctx,{personId:hire.personId,icNumber:'900101019885'});
 loanId=(await createLoan(ctx,{employmentId,loanType:'personal',principal:200,interestRate:0,interestMethod:'none',durationMonths:1,startDate:period+'-01'})).id;
 batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:period})).batchId;await prefillLoansForBatch(ctx,{batchId});
 const [rep]=await owner.db.select().from(s.loanRepayment).where(eq(s.loanRepayment.loanId,loanId));repId=rep.id;
 const [type]=await owner.db.insert(s.claimType).values({tenantId:b.tenantId,code:'FICTIONAL',name:'Fictional'}).returning();
 const [claim]=await owner.db.insert(s.claimRequest).values({tenantId:b.tenantId,employmentId,claimTypeId:type.id,amount:'80.00',incurredOn:period+'-03',taxable:true,status:'approved',payrollBatchId:batchId}).returning();claimId=claim.id;
 const [individual]=await owner.db.insert(s.payrollIndividualTxn).values({tenantId:b.tenantId,batchId,companyId:b.companyId,payPeriod:period,employmentId,kind:'leave',txnDate:period+'-03',amount:'0'}).returning();individualId=individual.id;
 await generatePayslips(ctx,{batchId});
});
async function mixedActor(visibleRepayment=false){
 const administrator=ctx,[other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional separate HR company'}).returning(),[department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:other.id,name:'Fictional separate HR department'}).returning();
 const visible=await hireEmployee(administrator,{person:{fullName:'Fictional visible repayment subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:other.id,departmentId:department.id,employmentType:'full_time',hiredOn:String(Number(period.slice(0,4))-1)+'-01-01'});
 const userId=await createAppUser(b.tenantId,null,'employee');await assignRole(administrator,{appUserId:userId,role:'hr_admin',companyId:other.id});await assignRole(administrator,{appUserId:userId,role:'payroll_partner',companyId:b.companyId});await setPayrollPermissionGrant(administrator,{companyId:b.companyId,permissionKey:'payroll.rollback',role:'payroll_partner',allowed:true});
 if(visibleRepayment)await owner.db.update(s.loanRepayment).set({employmentId:visible.employmentId}).where(eq(s.loanRepayment.id,repId));
 ctx={...await entitledCtx(b,['employee','hr_admin','payroll_partner']),userId,personId:undefined,grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:other.id},{role:'payroll_partner',companyId:b.companyId}]};
 const [scope]=await withTenant(ctx,tx=>tx.execute<{hrVisible:boolean;payrollVisible:boolean;loanVisible:boolean}>(sql`select app.can_see_employment(${employmentId}::uuid) as "hrVisible",app.can_admin_payroll_employment(${employmentId}::uuid) as "payrollVisible",app.is_admin_for(${b.companyId}::uuid) as "loanVisible"`));expect(scope).toEqual({hrVisible:false,payrollVisible:true,loanVisible:false});return visible.employmentId;
}
describe('protected native reset proof',()=>{
 it('proves the full native transition and preserves historical completion after real regeneration',async()=>{
  const before=await state(),id=await prepare();let eventId='';
  await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});eventId=native.resetEventId;expect(native).toMatchObject({payslipsCleared:1,loanInstalmentsReversed:1,loansReopened:1,claimsReverted:1});await complete(tx,id,eventId);});
  const after=await state();expect(after.batch[0]).toMatchObject({status:'draft',totals:null,employeeCount:0});expect(after.slips).toHaveLength(0);expect(after.loans[0]).toMatchObject({outstandingBalance:'200.00',instalmentsPaid:0,status:'active'});expect(after.reps[0]).toMatchObject({status:'reserved',appliedBatchId:null,appliedAmount:'0.00'});expect(after.claims[0]).toMatchObject({status:'approved',paidAt:null,payoutRef:null,payrollBatchId:batchId});expect(after.individuals[0]).toMatchObject({consumedBatchId:null,consumedAt:null});expect(after.individuals[0].amount).toBe(before.individuals[0].amount);
  const [stored]=await owner.db.execute<{phase:string;body:number;proof:unknown}>(sql`select payroll_reset_proof->>'phase' phase,payroll_reset_proof proof,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) body from app.assistant_own_leave_review r where r.id=${id}::uuid`);expect(stored.phase).toBe('completed');expect(stored.body).toBe(0);expect(JSON.stringify(stored.proof)).not.toContain('progress');expect(JSON.stringify(stored.proof)).not.toContain('source');
  await generatePayslips(ctx,{batchId});const regenerated=await state();
  await withTenant(ctx,async tx=>{const [row]=await tx.execute<{receipt:{resetEventId:string;currentStatus:string}}>(sql`select app.read_own_payroll_reset_effect(${batchId}::uuid,${eventId}::uuid) receipt`);expect(row.receipt).toMatchObject({resetEventId:eventId,currentStatus:'processed'});await complete(tx,id,eventId);});expect(await state()).toEqual(regenerated);
 });
 it('refuses a caller-written witness and a direct call of the private trigger',async()=>{
  const id=await prepare(),before=await state();
  await refused(tx=>tx.execute(sql`update app.assistant_own_leave_review set payroll_reset_proof='{}'::jsonb where id=${id}::uuid`),'permission denied','42501');
  await refused(tx=>tx.execute(sql`select app._payroll_reset_transition()`),'permission denied','42501');expect(await state()).toEqual(before);
 });
 it('rejects same-transaction inserted reservations even while the caller owns the parent lock',async()=>{
  const id=await prepare(),before=await state();await refused(async tx=>{await arm(tx,id);await tx.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId,sequenceNo:50,dueAmount:'1.00',status:'reserved',reservedBatchId:batchId});},'Payroll reset source membership changed');expect(await state()).toEqual(before);
 });
 it('rejects retargeting a source schedule row and changing a reviewed source before arming',async()=>{
  const id=await prepare(),before=await state();await refused(async tx=>{await arm(tx,id);await tx.update(s.loanRepayment).set({reservedBatchId:null,appliedBatchId:null}).where(eq(s.loanRepayment.id,repId));},'Payroll reset repayment mismatch');expect(await state()).toEqual(before);
  await refused(async tx=>{await tx.update(s.payrollBatch).set({remarks:'Changed after review'}).where(eq(s.payrollBatch.id,batchId));await arm(tx,id);},'Payroll reset reviewed source changed');expect(await state()).toEqual(before);
 });
 it.each(['DELETE','UPDATE'] as const)('rejects physical %s observations inside a nested savepoint before a later top-level write can launder them',async(op)=>{
  const id=await prepare(),before=await state();await refused(async tx=>{await arm(tx,id);await tx.execute(sql`SAVEPOINT fictional_nested_reset`);if(op==='DELETE')await tx.delete(s.payslip).where(eq(s.payslip.batchId,batchId));else await resetProcessedBatchTx(tx,ctx,{batchId,reason});await tx.execute(sql`RELEASE SAVEPOINT fictional_nested_reset`);await complete(tx,id,randomUUID());},'Payroll reset observation is not top-level');expect(await state()).toEqual(before);
 });
 it('refuses wrong loan arithmetic and an omitted native effect',async()=>{
  const id=await prepare(),before=await state();await refused(async tx=>{await arm(tx,id);await tx.update(s.employeeLoan).set({outstandingBalance:'201.00',instalmentsPaid:0,status:'active'}).where(eq(s.employeeLoan.id,loanId));},'Payroll reset loan transition mismatch');expect(await state()).toEqual(before);
  await refused(async tx=>{await arm(tx,id);await tx.delete(s.payslip).where(eq(s.payslip.batchId,batchId));await complete(tx,id,randomUUID());},'Payroll reset effect inventory mismatch');expect(await state()).toEqual(before);
 });
 it.each([true,false])('uses the actual native shortfall branch (scheduled remainder exists=%s)',async(exists)=>{
  await owner.db.update(s.loanRepayment).set({appliedAmount:'100.00'}).where(eq(s.loanRepayment.id,repId));await owner.db.update(s.employeeLoan).set({outstandingBalance:'100.00',status:'active'}).where(eq(s.employeeLoan.id,loanId));
  if(exists)await owner.db.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId,sequenceNo:2,dueAmount:'100.00',status:'scheduled'});
  const id=await prepare();await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});await complete(tx,id,native.resetEventId);});
  const after=await state();expect(after.reps).toHaveLength(1);expect(after.reps[0]).toMatchObject({status:'reserved',dueAmount:exists?'200.00':'100.00'});expect(after.loans[0].outstandingBalance).toBe('200.00');
 });
 it('preserves a competing original reservation and leaves anomalous recalc IDs alone when the timestamp is NULL',async()=>{
  await owner.db.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId,sequenceNo:2,dueAmount:'20.00',status:'reserved',reservedBatchId:batchId});await owner.db.update(s.payrollBatch).set({needsRecalcAt:null,recalcEmploymentIds:[employmentId]}).where(eq(s.payrollBatch.id,batchId));
  const id=await prepare();await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});await complete(tx,id,native.resetEventId);});const after=await state();expect(after.reps.find(row=>row.id===repId)).toMatchObject({status:'scheduled',reservedBatchId:null});expect(after.reps.filter(row=>row.status==='reserved')).toHaveLength(1);expect(after.batch[0].recalcEmploymentIds).toEqual([employmentId]);expect(after.events.filter(row=>row.eventType==='payroll-batch.recalc-cleared')).toHaveLength(0);
 });
 it('releases consumed rows that were retargeted to another run and preserves their keyed values',async()=>{
  const other=(await createBatch(ctx,{companyId:b.companyId,payPeriod:todayInKualaLumpur().slice(0,7)})).batchId;
  await owner.db.update(s.payrollIndividualTxn).set({batchId:other}).where(eq(s.payrollIndividualTxn.id,individualId));const before=await state(),id=await prepare();await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});await complete(tx,id,native.resetEventId);});const after=await state();expect(after.individuals[0]).toEqual({...before.individuals[0],consumedBatchId:null,consumedAt:null});
 });
 it('refuses an actual alternate loan writer lock before preview and leaves the complete transaction unchanged',async()=>{
  const id=await prepare(),before=await state();let ready!:()=>void,release!:()=>void;
  const start=new Promise<void>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;});
  const held=owner.db.transaction(async tx=>{await tx.select().from(s.employeeLoan).where(eq(s.employeeLoan.id,loanId)).for('update');ready();await finish;});
  await start;
  try{await refused(tx=>arm(tx,id),'could not obtain lock','55P03');expect(await state()).toEqual(before);}finally{release();await held;}
 });
 it('retires the complete private reset review on affected-person erasure without changing payroll results',async()=>{
  const id=await prepare(),before=await state();await erasePersonPii(ctx,{subjectEmploymentId:employmentId,scope:'contact',requestRef:'FICTIONAL-RESET-ERASURE',reason:'Fictional private reset review erasure'});
  const [row]=await owner.db.execute<{state:string;people:unknown;proof:unknown;bodies:number}>(sql`select state,payroll_reset_person_ids people,payroll_reset_proof proof,(select count(*)::int from app.assistant_own_leave_review_content where action_id=r.id) bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);
  expect(row).toEqual({state:'refused',people:null,proof:null,bodies:0});const after=await state();expect(after.batch).toEqual(before.batch);expect(after.slips).toEqual(before.slips);expect(after.loans).toEqual(before.loans);expect(after.reps).toEqual(before.reps);expect(after.claims).toEqual(before.claims);expect(after.individuals).toEqual(before.individuals);
 });

 it('preserves a genuine native mixed HR-in-A/payroll-partner-in-B positive with invisible loans and claims',async()=>{
  await mixedActor();const before=await state();let nativeCounts:unknown;
  await expect(withTenant(ctx,async tx=>{nativeCounts=await resetProcessedBatchTx(tx,ctx,{batchId,reason});throw Error('Fictional native parity rollback');})).rejects.toThrow('Fictional native parity rollback');expect(nativeCounts).toMatchObject({payslipsCleared:1,loanInstalmentsReversed:0,claimsReverted:0});expect(await state()).toEqual(before);
  const id=await prepare();await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});expect(native).toMatchObject({payslipsCleared:1,loanInstalmentsReversed:0,claimsReverted:0});await complete(tx,id,native.resetEventId);});const after=await state();expect(after.slips).toHaveLength(0);expect(after.loans).toEqual(before.loans);expect(after.reps).toEqual(before.reps);expect(after.claims).toEqual(before.claims);
 });
 it('preserves the native invisible-parent skip and refuses its otherwise-visible scheduled shortfall deletion',async()=>{
  const visibleId=await mixedActor(true);await owner.db.update(s.loanRepayment).set({appliedAmount:'100.00'}).where(eq(s.loanRepayment.id,repId));await owner.db.update(s.employeeLoan).set({outstandingBalance:'100.00',status:'active'}).where(eq(s.employeeLoan.id,loanId));const [shortfall]=await owner.db.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId:visibleId,sequenceNo:2,dueAmount:'100.00',status:'scheduled'}).returning();
  const before=await state(),id=await prepare();await refused(async tx=>{await arm(tx,id);await tx.execute(sql`select set_config('app.payroll_reset_current_rep',${repId},true)`);await tx.delete(s.loanRepayment).where(eq(s.loanRepayment.id,shortfall.id));},'Payroll reset shortfall loan unavailable');expect(await state()).toEqual(before);
  await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});expect(native).toMatchObject({loanInstalmentsReversed:1,loansReopened:0});await complete(tx,id,native.resetEventId);});const after=await state();expect(after.loans).toEqual(before.loans);expect(after.reps).toEqual(before.reps);
 });
 it('refuses an orphan shortfall even with an actual visible parent and an actual DELETE witness',async()=>{
  await owner.db.update(s.loanRepayment).set({appliedAmount:'100.00'}).where(eq(s.loanRepayment.id,repId));await owner.db.update(s.employeeLoan).set({outstandingBalance:'100.00',status:'active'}).where(eq(s.employeeLoan.id,loanId));const [shortfall]=await owner.db.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId,sequenceNo:2,dueAmount:'100.00',status:'scheduled'}).returning();const id=await prepare(),before=await state();
  await refused(async tx=>{await arm(tx,id);await tx.execute(sql`select set_config('app.payroll_reset_current_rep',${repId},true)`);await tx.delete(s.loanRepayment).where(eq(s.loanRepayment.id,shortfall.id));await complete(tx,id,randomUUID());},'Payroll reset orphan shortfall');expect(await state()).toEqual(before);
 });
 it('accepts the unchanged native sequential chain for multiple applied repayments on one loan',async()=>{
  await owner.db.update(s.loanRepayment).set({appliedAmount:'100.00',dueAmount:'100.00'}).where(eq(s.loanRepayment.id,repId));await owner.db.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId,sequenceNo:2,dueAmount:'50.00',appliedAmount:'50.00',status:'applied',reservedBatchId:batchId,appliedBatchId:batchId,appliedAt:new Date()});await owner.db.update(s.employeeLoan).set({outstandingBalance:'50.00',instalmentsPaid:2,status:'active'}).where(eq(s.employeeLoan.id,loanId));const id=await prepare();
  await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});expect(native.loanInstalmentsReversed).toBe(2);await complete(tx,id,native.resetEventId);});const after=await state();expect(after.loans[0]).toMatchObject({outstandingBalance:'200.00',instalmentsPaid:0,status:'active'});expect(after.reps.filter(row=>row.status==='reserved')).toHaveLength(1);expect(after.reps.filter(row=>row.status==='scheduled')).toHaveLength(1);expect(after.events.filter(row=>row.eventType==='loan.instalment.reversed')).toHaveLength(2);
 });
 it.each([{runType:'bonus'},{runSeq:99},{statutoryReportsForPeriod:99},{fictionalExtraKey:true}])('refuses incorrect or extra reset payload fields %j',async(patch)=>{
  const id=await prepare(),before=await state();
  await owner.db.execute(sql.raw("create function app.fictional_bad_reset_payload() returns trigger language plpgsql as $$begin if NEW.event_type='payroll-batch.reset' then NEW.payload:=NEW.payload||'"+JSON.stringify(patch)+"'::jsonb;end if;return NEW;end$$"));
  await owner.db.execute(sql`create trigger fictional_bad_reset_payload before insert on public.domain_event for each row execute function app.fictional_bad_reset_payload()`);
  try{await refused(async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});await complete(tx,id,native.resetEventId);},'Payroll reset native payload mismatch');expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger fictional_bad_reset_payload on public.domain_event`);await owner.db.execute(sql`drop function app.fictional_bad_reset_payload()`);}
 });
 it('refuses extra keys in a per-repayment native event payload',async()=>{
  const id=await prepare(),before=await state();await owner.db.execute(sql`create function app.fictional_bad_reset_step_payload() returns trigger language plpgsql as $$begin if NEW.event_type='loan.instalment.reversed' then NEW.payload:=NEW.payload||'{"fictionalExtraKey":true}'::jsonb;end if;return NEW;end$$`);await owner.db.execute(sql`create trigger fictional_bad_reset_step_payload before insert on public.domain_event for each row execute function app.fictional_bad_reset_step_payload()`);
  try{await refused(async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});await complete(tx,id,native.resetEventId);},'Payroll reset exact native event missing');expect(await state()).toEqual(before);}finally{await owner.db.execute(sql`drop trigger fictional_bad_reset_step_payload on public.domain_event`);await owner.db.execute(sql`drop function app.fictional_bad_reset_step_payload()`);}
 });

 it.each([false,true])('preserves the native visible-parent/invisible-child shortfall branch (visible lower remainder=%s)',async(visibleRemainder)=>{
  const visibleId=await mixedActor(true);await owner.db.update(s.employeeLoan).set({employmentId:visibleId,outstandingBalance:'100.00',status:'active'}).where(eq(s.employeeLoan.id,loanId));await owner.db.update(s.loanRepayment).set({appliedAmount:'100.00'}).where(eq(s.loanRepayment.id,repId));
  const [hidden]=await owner.db.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId,sequenceNo:3,dueAmount:'100.00',status:'scheduled'}).returning();
  if(visibleRemainder)await owner.db.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId:visibleId,sequenceNo:2,dueAmount:'100.00',status:'scheduled'});
  const before=await state();let nativeDue:string|undefined;
  await expect(withTenant(ctx,async tx=>{const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});expect(native).toMatchObject({loanInstalmentsReversed:1,loansReopened:0});const [rep]=await tx.select().from(s.loanRepayment).where(eq(s.loanRepayment.id,repId));nativeDue=rep.dueAmount;throw Error('Fictional native hidden-child rollback');})).rejects.toThrow('Fictional native hidden-child rollback');expect(nativeDue).toBe(visibleRemainder?'200.00':'100.00');expect(await state()).toEqual(before);
  const id=await prepare();await withTenant(ctx,async tx=>{await arm(tx,id);const native=await resetProcessedBatchTx(tx,ctx,{batchId,reason});await complete(tx,id,native.resetEventId);});const after=await state();expect(after.reps.find(row=>row.id===repId)).toMatchObject({status:'reserved',dueAmount:nativeDue});expect(after.reps.find(row=>row.id===hidden.id)).toEqual(hidden);expect(after.loans[0]).toMatchObject({outstandingBalance:'200.00',instalmentsPaid:0,status:'active'});
 });

});
