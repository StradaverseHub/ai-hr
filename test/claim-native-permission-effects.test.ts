/** Actual native ports and raw app-role refusals; no fabricated publication or completion marker. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {appendEvent} from '../db/events';
import {hireEmployee} from '../core/org';
import {cancelClaim,createClaimType,markReimbursementsPaid,listReimbursementsDue} from '../core/claims';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext,subject:{personId:string;employmentId:string},own:SessionContext,typeId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);
 subject=await hireEmployee(admin,{person:{fullName:'Fictional claim port owner',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');
 own={...admin,userId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 typeId=(await createClaimType(admin,{code:'NATIVE',name:'Fictional native claim',requiresReceipt:false,defaultTaxable:false})).id;
});
async function claim(status:'pending'|'approved'='pending'){
 const [row]=await owner.db.insert(s.claimRequest).values({tenantId:b.tenantId,employmentId:subject.employmentId,claimTypeId:typeId,amount:'25.00',incurredOn:todayInKualaLumpur(),taxable:false,status}).returning();return row;
}
async function refusal(run:Promise<unknown>,message:string){
 let failure:unknown;try{await run;}catch(error){failure=error;}
 let denied=false;for(let error=failure;error&&typeof error==='object';error=(error as {cause?:unknown}).cause){
  if((error as {code?:string}).code==='42501'&&(error as {message?:string}).message===message)denied=true;
 }expect(denied).toBe(true);
}
it('cancels only the actual own pending claim and records the actual actor once',async()=>{
 const row=await claim();await cancelClaim(own,row.id,subject.employmentId);
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id)))[0].status).toBe('cancelled');
 const events=await owner.client`select actor_id,subject_employment_id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${row.id}::uuid and event_type='claim-request.cancelled'`;
 expect(events).toEqual([{actor_id:own.userId,subject_employment_id:subject.employmentId}]);
 await expect(cancelClaim(own,row.id,subject.employmentId)).rejects.toThrow('Only a pending claim can be cancelled');
});
it('cannot forge a cancellation receipt with an audit, owner GUC, nested savepoint or restored row',async()=>{
 const row=await claim(),before=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`;
 await refusal(withTenant(own,async tx=>{
  await tx.execute(sql`select set_config('app.owner','true',true)`);
  await tx.transaction(async nested=>{
   await nested.update(s.claimRequest).set({status:'cancelled'}).where(eq(s.claimRequest.id,row.id));
   await appendEvent(nested,{tenantId:b.tenantId,aggregateType:'claim-request',aggregateId:row.id,eventType:'claim-request.cancelled',actor:{type:'user',id:own.userId},subjectEmploymentId:subject.employmentId});
   await nested.update(s.claimRequest).set({status:'pending'}).where(eq(s.claimRequest.id,row.id));
  });
 }),'Claim payment or cancellation source unavailable');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id)))[0].status).toBe('pending');
 expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(before);
 await expect(withTenant(own,tx=>tx.execute(sql`insert into app.module_claim_effect select * from app.module_claim_effect`))).rejects.toThrow();
});
it('refuses employee reimbursement and raw admin payment while preserving the finite admin native owner',async()=>{
 const row=await claim('approved');
 expect(await listReimbursementsDue(own)).toEqual([]);
 await expect(markReimbursementsPaid(own,{claimIds:[row.id]})).rejects.toThrow('Claim reimbursement unavailable');
 await refusal(withTenant(admin,tx=>tx.update(s.claimRequest).set({status:'paid',paidAt:new Date(),payoutRef:'forged'}).where(eq(s.claimRequest.id,row.id))),'Claim payment or cancellation source unavailable');
 expect(await markReimbursementsPaid(admin,{claimIds:[row.id],payoutRef:'Fictional bank confirmation'})).toEqual({paid:1});
 const [paid]=await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id));expect(paid.status).toBe('paid');expect(paid.payoutRef).toBe('Fictional bank confirmation');
 const events=await owner.client`select actor_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${row.id}::uuid and event_type='claim-request.paid'`;
 expect(events).toEqual([{actor_id:admin.userId,payload:{via:'reimbursement',payoutRef:'Fictional bank confirmation'}}]);
});
it('rejects wrong selected employment and another actual employee without mutating the claim',async()=>{
 const row=await claim();await expect(cancelClaim(own,row.id,randomUUID())).rejects.toThrow('Claim does not belong to the selected employment');
 const strangerId=await createAppUser(b.tenantId,null,'employee'),stranger={...own,userId:strangerId,personId:null};
 await expect(cancelClaim(stranger,row.id)).rejects.toThrow('Only the claimant or an admin can cancel this claim');
 expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id,row.id)))[0].status).toBe('pending');
});
