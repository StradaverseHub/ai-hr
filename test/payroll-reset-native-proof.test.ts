/** Actual app-role SQL/native reset proof, before the Assistant action is mounted. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {createBatch,createLoan,prefillLoansForBatch,generatePayslips,resetProcessedBatchTx,previewReviewedPayrollResetTx} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,batchId:string,employmentId:string,loanId:string,repId:string,claimId:string,individualId:string,period:string;
const reviewedDigest='b'.repeat(64),intentDigest='c'.repeat(64),reason='Fictional human correction';
const ids=(values:string[])=>sql`ARRAY[${sql.join(values.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
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
  await expect(withTenant(ctx,tx=>tx.execute(sql`update app.assistant_own_leave_review set payroll_reset_proof='{}'::jsonb where id=${id}::uuid`))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app._payroll_reset_transition()`))).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('rejects same-transaction inserted reservations even while the caller owns the parent lock',async()=>{
  const id=await prepare(),before=await state();await expect(withTenant(ctx,async tx=>{await arm(tx,id);await tx.insert(s.loanRepayment).values({tenantId:b.tenantId,loanId,employmentId,sequenceNo:50,dueAmount:'1.00',status:'reserved',reservedBatchId:batchId});})).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('rejects retargeting a source schedule row and changing a reviewed source before arming',async()=>{
  const id=await prepare(),before=await state();await expect(withTenant(ctx,async tx=>{await arm(tx,id);await tx.update(s.loanRepayment).set({reservedBatchId:null,appliedBatchId:null}).where(eq(s.loanRepayment.id,repId));})).rejects.toThrow();expect(await state()).toEqual(before);
  await expect(withTenant(ctx,async tx=>{await tx.update(s.payrollBatch).set({remarks:'Changed after review'}).where(eq(s.payrollBatch.id,batchId));await arm(tx,id);})).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it.each(['DELETE','UPDATE'] as const)('rejects physical %s observations inside a nested savepoint before a later top-level write can launder them',async(op)=>{
  const id=await prepare(),before=await state();await expect(withTenant(ctx,async tx=>{await arm(tx,id);await tx.execute(sql`SAVEPOINT fictional_nested_reset`);if(op==='DELETE')await tx.delete(s.payslip).where(eq(s.payslip.batchId,batchId));else await resetProcessedBatchTx(tx,ctx,{batchId,reason});await tx.execute(sql`RELEASE SAVEPOINT fictional_nested_reset`);await complete(tx,id,randomUUID());})).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('refuses wrong loan arithmetic and an omitted native effect',async()=>{
  const id=await prepare(),before=await state();await expect(withTenant(ctx,async tx=>{await arm(tx,id);await tx.update(s.employeeLoan).set({outstandingBalance:'201.00',instalmentsPaid:0,status:'active'}).where(eq(s.employeeLoan.id,loanId));})).rejects.toThrow();expect(await state()).toEqual(before);
  await expect(withTenant(ctx,async tx=>{await arm(tx,id);await tx.delete(s.payslip).where(eq(s.payslip.batchId,batchId));await complete(tx,id,randomUUID());})).rejects.toThrow();expect(await state()).toEqual(before);
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
});
