/** Hosted-only native proof, private custody, history and genuine functional-scope fixtures. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {setReportingLine} from '../core/org';
import {approveGoalTx,updateGoal,readGoalApprovalSourceTx,readCheckInCancellationSourceTx,cancelCheckInTx,readCheckInCompletionPlanTx,completeCheckInTx} from '../packs/performance/service';
import {grantAssistant} from '../core/assistant-grant';
import {erasePersonPii} from '../core/pdpa';
import {goalApprovalReviews,readGoalApprovalChoices} from '../core/assistant-actions/goal-approval-review-store';
import {GoalApproval as G} from '../lib/assistant-actions/goal-approval-contract';
import {owner,entitledCtx} from './harness';
import {b,group,hire,fixture,state,proof,installPerformancePostimageFixtures} from './helpers/performance-postimage-fixture';
installPerformancePostimageFixtures();

for(const kind of ['goal','cancel','preserve','replace'] as const){
 it(`keeps ${kind} commitments private, clears them on completion, recovers original history`,async()=>{
  const a=await fixture(kind),r=(await a.prepare()).review,p=await proof(r.actionId);expect(p.version).toBe(1);expect(p.root).toBeNull();expect(p.unchanged).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(r)).not.toContain(p.unchanged!);
  const result=await a.confirm(r);expect(result.kind).toBe('completed');expect(await proof(r.actionId)).toMatchObject({version:1,state:'completed',unchanged:null,notes:null,mode:null,bodies:0});
  expect((await proof(r.actionId)).root).toMatch(/^[0-9]+$/);expect(JSON.stringify(result)).not.toContain('Private');expect(await a.reopen(r.actionId)).toEqual(result);
  if(kind==='replace'){const [row]=await owner.db.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,a.id));expect(row.notes).toBe('Human Unicode note');}
  if(kind==='goal'){await updateGoal(a.self,{goalId:a.id,title:'Legitimate later human edit'});expect(await a.reopen(r.actionId)).toEqual(result);expect((await state(a)).events.filter(e=>e.eventType==='performance-goal.approved')).toHaveLength(1);}
 });
}
it('SQL derives preservation from the locked DB notes and uses pure UTC serialization without changing authority timezone',async()=>{
 const a=await fixture('preserve');
 const result=await withTenant(a.ctx,async tx=>{
  await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
  const [first]=await tx.execute<{p:unknown;zone:string}>(sql`select app.assistant_performance_review_expected(${a.action},${a.id}::uuid,'preserve','FORGED preserved notes') as p,current_setting('TimeZone') as zone`);
  await tx.execute(sql`SET LOCAL TIME ZONE 'America/Adak'`);
  const [second]=await tx.execute<{p:unknown;zone:string}>(sql`select app.assistant_performance_review_expected(${a.action},${a.id}::uuid,'preserve',NULL) as p,current_setting('TimeZone') as zone`);return{first,second};
 });expect(result.first.p).toEqual(result.second.p);expect(result.first.zone).toBe('Pacific/Kiritimati');expect(result.second.zone).toBe('America/Adak');
});
it('rejects forged prepare commitments before inserting custody',async()=>{
 const a=await fixture('goal'),id=randomUUID();
 await expect(withTenant(a.ctx,tx=>tx.execute(sql`select app.assistant_performance_review_prepare(${a.action},${id}::uuid,${a.ctx.personId}::uuid,${a.employee.employmentId}::uuid,${b.companyId}::uuid,${a.employee.personId}::uuid,${a.id}::uuid,${'1'.repeat(64)},${'2'.repeat(64)},'fictional','fictional','fictional',${JSON.stringify({version:1,unchanged:'0'.repeat(64),notes:null,notesMode:null})}::jsonb,NULL)`))).rejects.toMatchObject({cause:{code:'42501',message:'Performance source changed before custody'}});expect(await proof(id)).toBeUndefined();
});
for(const completed of [false,true])it(`refuses retroactive proof for a genuine legacy ${completed?'completed':'pending'} packet`,async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,legacyId=randomUUID();
 const [saved]=await owner.db.execute<{packet:Record<string,unknown>;body:Record<string,unknown>}>(sql`select to_jsonb(r) as packet,to_jsonb(c) as body from app.assistant_own_leave_review r join app.assistant_own_leave_review_content c on c.action_id=r.id where r.id=${r.actionId}::uuid`);
 // Release the per-subject pending uniqueness through the actual lifecycle, preserving the old row.
 await goalApprovalReviews.discard(a.ctx,{actionId:r.actionId});
 // A genuine ordinary native completion owns a new unique event; no qualified receipt is cloned,
 // and no protected historical marker, event or uniqueness constraint is rewritten.
 const eventId=completed?(await withTenant(a.ctx,tx=>approveGoalTx(tx,a.ctx,{goalId:a.id}))).eventId:null;
 const packet={...saved.packet,id:legacyId,state:completed?'completed':'awaiting_confirmation',...(completed?{intent_digest:null,reviewed_digest:null,receipt_event_id:eventId}:{}),performance_postimage_version:null,performance_postimage_unchanged:null,performance_postimage_notes:null,performance_postimage_mode:null,performance_postimage_event_id:null,performance_postimage_root_xid:null};
 await owner.db.execute(sql`insert into app.assistant_own_leave_review select (jsonb_populate_record(NULL::app.assistant_own_leave_review,${JSON.stringify(packet)}::jsonb)).*`);
 if(!completed)await owner.db.execute(sql`insert into app.assistant_own_leave_review_content select (jsonb_populate_record(NULL::app.assistant_own_leave_review_content,${JSON.stringify({...saved.body,action_id:legacyId})}::jsonb)).*`);
 const before=await state(a);if(completed)await expect(a.reopen(legacyId)).rejects.toThrow();else expect(await a.reopen(legacyId)).toMatchObject({kind:'retired'});
 expect(await proof(legacyId)).toMatchObject({version:null,unchanged:null,notes:null,mode:null,state:completed?'completed':'refused',bodies:0});expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'discarded',bodies:0});
});
for(const completed of [false,true])it(`canonical erasure clears sensitive proof for ${completed?'body-gone completed':'pending'} custody`,async()=>{
 const a=await fixture('preserve'),r=(await a.prepare()).review;if(completed)await a.confirm(r);
 await erasePersonPii(group(),{subjectEmploymentId:a.employee.employmentId,scope:'contact',reason:'Fictional human privacy request',requestRef:'fictional-proof-'+randomUUID()});
 expect(await proof(r.actionId)).toMatchObject({unchanged:null,notes:null,mode:null,bodies:0,state:completed?'completed':'refused'});
 const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'pii.erased'));expect(events.length).toBeGreaterThan(0);
});
it('documents the genuine functional-partner native-positive and bounded Assistant-negative goal door',async()=>{
 const a=await fixture('goal'),partner=await hire('Fictional Functional Partner',b.deptB);
 const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:partner.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,companyId:b.companyId,role:'performance_comp_partner'});await grantAssistant(group(),{appUserId:u.id});
 const ctx:SessionContext={...await entitledCtx(b,['performance_comp_partner']),userId:u.id,personId:partner.personId,grants:[{role:'performance_comp_partner',companyId:b.companyId}]};
 // Both are genuine managers at the native delegation write-time level. The partner manages a
 // DIFFERENT employee in sibling deptB, so native HOD visibility does not include the deptA subject.
 const separateReport=await hire('Fictional Partner Separate Direct Report',b.deptB);
 await setReportingLine(group(),{subordinateEmploymentId:separateReport.employmentId,managerEmploymentId:partner.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 await setReportingLine(group(),{subordinateEmploymentId:a.manager.employmentId,managerEmploymentId:partner.employmentId,lineType:'delegate',validFrom:'2026-01-01',reason:'Fictional whole-scope stand-in'});
 const scopes=await withTenant(ctx,tx=>tx.execute<{general:boolean;functional:boolean}>(sql`select app.can_see_employment(${a.employee.employmentId}::uuid) as general,app.can_admin_perfcomp_employment(${a.employee.employmentId}::uuid) as functional`));expect(scopes[0]).toEqual({general:false,functional:true});
 await expect(withTenant(ctx,async tx=>{await approveGoalTx(tx,ctx,{goalId:a.id});throw Error('native positive rollback');})).rejects.toThrow('native positive rollback');
 expect(await readGoalApprovalChoices(ctx,{query:'',subjectId:a.id})).toMatchObject({kind:'choices',items:[]});await expect(goalApprovalReviews.prepare(ctx,{action:G.action,contractVersion:1,employmentId:a.employee.employmentId,subjectId:a.id,approve:true})).rejects.toThrow();
 expect((await state(a)).row).toMatchObject({approvalStatus:'proposed'});
});


for(const kind of ['goal','cancel','preserve','replace'] as const)it(`preserves the existing default ${kind} native source/digest writer API`,async()=>{
 const a=await fixture(kind);
 await withTenant(a.ctx,async tx=>{
  if(kind==='goal'){const source=await readGoalApprovalSourceTx(tx,a.ctx,a.id);expect(source.postimageProof).toBeUndefined();await approveGoalTx(tx,a.ctx,{goalId:a.id},source.reviewDigest);}
  else if(kind==='cancel'){const source=await readCheckInCancellationSourceTx(tx,a.ctx,a.id);expect(source.postimageProof).toBeUndefined();await cancelCheckInTx(tx,a.ctx,{checkinId:a.id},source.reviewDigest);}
  else{const input={checkinId:a.id,...(kind==='replace'?{notes:' Default native replacement '}:{})},source=await readCheckInCompletionPlanTx(tx,a.ctx,input);expect(source.postimageProof).toBeUndefined();await completeCheckInTx(tx,a.ctx,input,source.reviewDigest);}
 });
 const after=await state(a);expect(after.row).toMatchObject(kind==='goal'?{approvalStatus:'approved'}:{status:kind==='cancel'?'cancelled':'completed'});expect(after.events.filter(e=>e.eventType===({goal:'performance-goal.approved',cancel:'performance-checkin.cancelled',preserve:'performance-checkin.completed',replace:'performance-checkin.completed'}[kind]))).toHaveLength(1);
});
