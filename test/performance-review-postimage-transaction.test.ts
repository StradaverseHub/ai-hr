/** Hosted-only physical transaction, writer fence and initial custody postcondition adversaries. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {withTenant,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {approveGoalTx,readGoalApprovalSourceTx,readCheckInCancellationSourceTx,cancelCheckInTx,readCheckInCompletionPlanTx,completeCheckInTx} from '../packs/performance/service';
import {appendEvent} from '../db/events';
import {captureNativeOutcomeTargetsTx} from '../core/module-native-outcome-targets';
import {erasePersonPiiTx} from '../core/pdpa';
import {owner} from './harness';
import {b,hire,fixture,state,proof,installPerformancePostimageFixtures,type Packet} from './helpers/performance-postimage-fixture';
installPerformancePostimageFixtures();

async function completeProtectedTx(tx:Tx,a:Awaited<ReturnType<typeof fixture>>,r:Packet){
  let eventId:string;
  if(a.kind==='goal'){const current=await readGoalApprovalSourceTx(tx,a.ctx,a.id,true);eventId=(await approveGoalTx(tx,a.ctx,{goalId:a.id},current.reviewDigest,true)).eventId;}
  else if(a.kind==='cancel'){const current=await readCheckInCancellationSourceTx(tx,a.ctx,a.id,true);eventId=(await cancelCheckInTx(tx,a.ctx,{checkinId:a.id},current.reviewDigest,true)).eventId;}
  else{const input={checkinId:a.id,...(a.kind==='replace'?{notes:'\u00a0\uFEFF Human Unicode note \u2003\n'}:{})},current=await readCheckInCompletionPlanTx(tx,a.ctx,input,true);eventId=(await completeCheckInTx(tx,a.ctx,input,current.reviewDigest,true)).eventId;}
  await captureNativeOutcomeTargetsTx(tx,a.ctx,{action:a.action,sourceId:r.actionId,eventId,targets:[{kind:'employment',id:a.employee.employmentId},{kind:'person',id:a.employee.personId}]});
  await tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${a.action},${r.reviewedDigest},${eventId}::uuid)`);
}

// The callable SQL boundary must close over the rest of the actual transaction, even after an
// immediate constraint flush. Each attempted mutation has an independent authorized positive contrast.
for(const kind of ['goal','cancel','preserve','replace'] as const)for(const mutation of ['row','event','actor'] as const)it(`fences ${kind} ${mutation} writes after protected completion and immediate constraints`,async()=>{
 const a=await fixture(kind);
 if(mutation==='actor'){await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:a.ctx.userId!,companyId:null,role:'hr_admin'});a.ctx.grants=[{role:'manager',companyId:null},{role:'hr_admin',companyId:null}];a.ctx.roles=['manager','hr_admin'];}
 const r=(await a.prepare()).review,before=await state(a),replacement=await hire('Fictional Later Actor Binding');
 async function mutate(tx:Tx){
  if(mutation==='row'){
   const rows=kind==='goal'?await tx.update(schema.performanceGoal).set({title:'Later same-transaction title'}).where(eq(schema.performanceGoal.id,a.id)).returning({id:schema.performanceGoal.id}):await tx.update(schema.performanceCheckin).set({scheduledOn:'2026-12-31'}).where(eq(schema.performanceCheckin.id,a.id)).returning({id:schema.performanceCheckin.id});expect(rows).toHaveLength(1);
  }else if(mutation==='actor'){
   const rows=await tx.update(schema.appUser).set({personId:replacement.personId}).where(eq(schema.appUser.id,a.ctx.userId!)).returning({id:schema.appUser.id});expect(rows).toHaveLength(1);
  }else await appendEvent(tx,{tenantId:b.tenantId,aggregateType:kind==='goal'?'performance-goal':'performance-checkin',aggregateId:a.id,eventType:'fictional.performance-extra',actor:{type:'user',id:a.ctx.userId!},subjectEmploymentId:a.employee.employmentId});
 }
 // Real app-role UPDATE RETURNING/append owner; a zero-row RLS fixture cannot prove this fence.
 await expect(withTenant(a.ctx,async tx=>{await mutate(tx);throw Error('positive mutation rollback');})).rejects.toThrow('positive mutation rollback');
 await expect(withTenant(a.ctx,async tx=>{
  await completeProtectedTx(tx,a,r);
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await mutate(tx);
 })).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});
 expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});

it('refuses a real child-savepoint native effect as a top-transaction completion witness',async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await tx.execute(sql`SAVEPOINT fictional_child_effect`);const current=await readGoalApprovalSourceTx(tx,a.ctx,a.id,true),effect=await approveGoalTx(tx,a.ctx,{goalId:a.id},current.reviewDigest,true);await tx.execute(sql`RELEASE SAVEPOINT fictional_child_effect`);await tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${a.action},${r.reviewedDigest},${effect.eventId}::uuid)`);})).rejects.toMatchObject({cause:{code:'42501',message:'Performance postimage unavailable'}});expect(await state(a)).toEqual(before);
});
it('refuses a matching native goal/event committed by an earlier transaction',async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,effect=await withTenant(a.ctx,async tx=>{const current=await readGoalApprovalSourceTx(tx,a.ctx,a.id,true);return approveGoalTx(tx,a.ctx,{goalId:a.id},current.reviewDigest,true);}),before=await state(a);
 await expect(withTenant(a.ctx,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${a.action},${r.reviewedDigest},${effect.eventId}::uuid)`))).rejects.toMatchObject({cause:{code:'42501',message:'Performance postimage unavailable'}});expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});
it('keeps nondeferrable fences active within a later child savepoint',async()=>{
 const a=await fixture('cancel'),r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await completeProtectedTx(tx,a,r);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await tx.execute(sql`SAVEPOINT fictional_child_tamper`);await tx.update(schema.performanceCheckin).set({notes:'Child tamper'}).where(eq(schema.performanceCheckin.id,a.id));await tx.execute(sql`RELEASE SAVEPOINT fictional_child_tamper`);})).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});expect(await state(a)).toEqual(before);
});
it('does not let a context switch hide the same transaction receipt from a real group administrator writer',async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await completeProtectedTx(tx,a,r);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await tx.execute(sql`select set_config('app.user_id',${b.adminUserId},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:null}])},true)`);await tx.update(schema.performanceGoal).set({title:'Context-switch tamper'}).where(eq(schema.performanceGoal.id,a.id));})).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});expect(await state(a)).toEqual(before);
});
it('refuses canonical erasure of the original subject after completion in the same transaction',async()=>{
 const a=await fixture('preserve');await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:a.ctx.userId!,companyId:null,role:'hr_admin'});a.ctx.grants=[{role:'manager',companyId:null},{role:'hr_admin',companyId:null}];a.ctx.roles=['manager','hr_admin'];const r=(await a.prepare()).review,before=await state(a);
 await expect(withTenant(a.ctx,async tx=>{await completeProtectedTx(tx,a,r);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await erasePersonPiiTx(tx,a.ctx,{subjectEmploymentId:a.employee.employmentId,scope:'contact',reason:'Fictional same-transaction erasure',requestRef:'fictional-'+randomUUID()});})).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});

for(const kind of ['goal','cancel','preserve','replace'] as const)for(const changed of ['root','actor-person'] as const)it(`refuses ${kind} initial persisted custody ${changed} rewrite by a later BEFORE trigger`,async()=>{
 const a=await fixture(kind),r=(await a.prepare()).review,before=await state(a);
 const mutation=changed==='root'?"NEW.performance_postimage_root_xid:='0'::xid8;":`NEW.person_id:='${a.employee.personId}'::uuid;`;
 // Alphabetical order is deliberate: this mutates NEW AFTER performance_postimage_retire, while
 // OLD is still awaiting_confirmation, before the completed writer fences can see a stored anchor.
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.zz_fictional_completed_metadata() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF NEW.id='${r.actionId}'::uuid AND NEW.state='completed' AND pg_trigger_depth()=1 THEN ${mutation} END IF;RETURN NEW;END$$`));
 await owner.db.execute(sql`CREATE TRIGGER zz_fictional_completed_metadata BEFORE UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app.zz_fictional_completed_metadata()`);
 try{await expect(withTenant(a.ctx,tx=>completeProtectedTx(tx,a,r))).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed custody changed'}});expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',root:null,event:null,bodies:1});}
 finally{await owner.db.execute(sql`DROP TRIGGER zz_fictional_completed_metadata ON app.assistant_own_leave_review`);await owner.db.execute(sql`DROP FUNCTION app.zz_fictional_completed_metadata()`);}
});
