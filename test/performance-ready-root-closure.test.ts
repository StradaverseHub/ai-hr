/** PRIVATE V2 future test/performance-ready-root-closure.test.ts. NOT collected/executed locally.
 * Actual native effects + protected SQL completion, actual app role; owner only fixture/hooks/observe. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {withTenant,type Tx} from '../db/client';
import {appendEvent} from '../db/events';
import * as schema from '../db/schema';
import {approveGoalTx,readGoalApprovalSourceTx,readCheckInCancellationSourceTx,cancelCheckInTx,
 readCheckInCompletionPlanTx,completeCheckInTx,readCheckInSchedulingPlanTx,scheduleCheckInTx,
 completeCheckIn,cancelCheckIn} from '../packs/performance/service';
import {captureNativeOutcomeTargetsTx} from '../core/module-native-outcome-targets';
import {checkInSchedulingReviews} from '../core/assistant-actions/checkin-scheduling-review-store';
import {CheckInScheduling as S} from '../lib/assistant-actions/checkin-scheduling-contract';
import {owner} from './harness';
import {erasePersonPiiTx} from '../core/pdpa';
import {group} from './helpers/performance-postimage-fixture';
import {b,fixture,installPerformancePostimageFixtures} from './helpers/performance-postimage-fixture';
installPerformancePostimageFixtures();
type Kind='goal'|'cancel'|'preserve'|'replace'|'schedule';
async function setup(kind:Kind){
 const a=await fixture(kind==='schedule'?'cancel':kind);
 if(kind!=='schedule'){const review=(await a.prepare()).review;return{a,review,kind,planned:a.id};}
 const result=await checkInSchedulingReviews.prepare(a.ctx,S.Human.parse({action:S.action,contractVersion:1,
  employmentId:a.employee.employmentId,scheduledOn:'2026-12-15',confirmSchedule:true}));
 const review=result.review;
 const [row]=await owner.db.execute<{planned:string}>(sql`select checkin_schedule_planned_id as planned from app.assistant_own_leave_review where id=${review.actionId}::uuid`);
 expect(row.planned).toMatch(/^[a-f0-9-]{36}$/);return{a,review,kind,planned:row.planned};
}
type F=Awaited<ReturnType<typeof setup>>;
async function complete(tx:Tx,f:F){
 const a=f.a;let eventId:string;
 if(f.kind==='schedule'){
  const p={subjectEmploymentId:a.employee.employmentId,scheduledOn:'2026-12-15'};
  const native=await readCheckInSchedulingPlanTx(tx,a.ctx,p);
  eventId=(await scheduleCheckInTx(tx,a.ctx,p,{plannedResultId:f.planned,expectedDigest:native.reviewDigest})).eventId;
 }else if(f.kind==='goal'){
  const native=await readGoalApprovalSourceTx(tx,a.ctx,a.id,true);
  eventId=(await approveGoalTx(tx,a.ctx,{goalId:a.id},native.reviewDigest,true)).eventId;
 }else if(f.kind==='cancel'){
  const native=await readCheckInCancellationSourceTx(tx,a.ctx,a.id,true);
  eventId=(await cancelCheckInTx(tx,a.ctx,{checkinId:a.id},native.reviewDigest,true)).eventId;
 }else{
  const p={checkinId:a.id,...(f.kind==='replace'?{notes:'\u00a0\uFEFF Human Unicode note \u2003\n'}:{})};
  const native=await readCheckInCompletionPlanTx(tx,a.ctx,p,true);
  eventId=(await completeCheckInTx(tx,a.ctx,p,native.reviewDigest,true)).eventId;
 }
 const action=f.kind==='schedule'?S.action:a.action;
 await captureNativeOutcomeTargetsTx(tx,a.ctx,{action,sourceId:f.review.actionId,eventId,
  targets:[{kind:'employment',id:a.employee.employmentId},{kind:'person',id:a.employee.personId}]});
 if(f.kind==='schedule')await tx.execute(sql`select app.assistant_checkin_schedule_complete(${f.review.actionId}::uuid,${f.review.reviewedDigest},${eventId}::uuid)`);
 else await tx.execute(sql`select app.assistant_assigned_review_complete(${f.review.actionId}::uuid,${action},${f.review.reviewedDigest},${eventId}::uuid)`);
 return eventId;
}
async function observed(f:F){
 const [r]=await owner.db.execute<{ledger:unknown;body:unknown}>(sql`select to_jsonb(r) as ledger,
  (select coalesce(jsonb_agg(to_jsonb(c) order by c.action_id),'[]'::jsonb) from app.assistant_own_leave_review_content c where c.action_id=r.id) as body
  from app.assistant_own_leave_review r where r.id=${f.review.actionId}::uuid`);
 return{custody:r,allReviews:Array.from(await owner.db.execute(sql`select to_jsonb(r) as value from app.assistant_own_leave_review r order by r.id`)),
  allBodies:Array.from(await owner.db.execute(sql`select to_jsonb(c) as value from app.assistant_own_leave_review_content c order by c.action_id`)),goals:await owner.db.select().from(schema.performanceGoal).orderBy(schema.performanceGoal.id),
  checkins:await owner.db.select().from(schema.performanceCheckin).orderBy(schema.performanceCheckin.id),
  events:await owner.db.select().from(schema.domainEvent).orderBy(schema.domainEvent.id),
  captures:Array.from(await owner.db.execute(sql`select to_jsonb(c) as value from app.native_outcome_source_capture c order by c.id`)),
  targets:Array.from(await owner.db.execute(sql`select to_jsonb(t) as value from app.native_outcome_source_target t order by t.capture_id,t.kind,t.target_id`))};
}
async function install(name:string,relation:string,timing:string,operation:string,body:string){
 // name/relation/timing/operation/body are finite fictional test source constants, never user inputs.
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN ${body} IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END$$`));
 await owner.db.execute(sql.raw(`CREATE TRIGGER ${name} ${timing} ${operation} ON ${relation} FOR EACH ROW EXECUTE FUNCTION app.${name}()`));
 return async()=>{await owner.db.execute(sql.raw(`DROP TRIGGER ${name} ON ${relation}`));await owner.db.execute(sql.raw(`DROP FUNCTION app.${name}()`));};
}

for(const kind of ['goal','cancel','preserve','replace','schedule'] as const)
it(`refuses ${kind} real unrelated event retargeted by a LATER BEFORE trigger after IMMEDIATE`,async()=>{
 const f=await setup(kind),before=await observed(f),unrelated=randomUUID();
 const cleanup=await install('zz_fictional_late_performance_event','public.domain_event','BEFORE','INSERT',
  `IF NEW.event_type='fictional.performance-unrelated' THEN NEW.aggregate_id:='${f.planned}'::uuid;END IF;`);
 async function append(tx:Tx){
  const id=randomUUID();await appendEvent(tx,{id,tenantId:b.tenantId,aggregateType:'fictional-unrelated',
   aggregateId:unrelated,eventType:'fictional.performance-unrelated',actor:{type:'user',id:f.a.ctx.userId!},
   subjectEmploymentId:f.a.employee.employmentId});return id;
 }
 try{
  // Actual app-role positive: hook executes, event changes to protected target, no completed anchor
  // exists yet. Actual row read proves installed late hook; deliberate throw rolls this positive back.
  await expect(withTenant(f.a.ctx,async tx=>{const id=await append(tx);
   const [event]=await tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,id));
   expect(event.aggregateId).toBe(f.planned);throw Error('fictional actual late-hook positive');
  })).rejects.toThrow('fictional actual late-hook positive');
  expect(await observed(f)).toEqual(before);
  await expect(withTenant(f.a.ctx,async tx=>{await complete(tx,f);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);await append(tx);
  })).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});
  expect(await observed(f)).toEqual(before);
 }finally{await cleanup();}
});

for(const at of ['ledger','body'] as const)for(const change of ['status','notes','date'] as const)
it(`refuses scheduling quiet AFTER ${at} ${change} mutation with complete rollback`,async()=>{
 const f=await setup('schedule'),before=await observed(f);
 const mutation=change==='status'?"status='completed',completed_at=transaction_timestamp()":change==='notes'?"notes='Fictional unreviewed note'":"scheduled_on='2026-12-31'";
 const predicate=at==='ledger'?`NEW.id='${f.review.actionId}'::uuid AND NEW.state='completed'`:`OLD.action_id='${f.review.actionId}'::uuid`;
 const cleanup=await install('zz_fictional_schedule_after',at==='ledger'?'app.assistant_own_leave_review':'app.assistant_own_leave_review_content','AFTER',at==='ledger'?'UPDATE':'DELETE',
  `IF ${predicate} AND pg_trigger_depth()=1 THEN UPDATE public.performance_checkin SET ${mutation} WHERE id=coalesce(nullif(current_setting('fictional.performance_hook_target',true),''),'${f.planned}')::uuid;END IF;`);
 try{
  // SAME actual native/protected completion and SAME adversarial hook. Only the hook's fictional
  // target changes to the existing unrelated scheduled sentinel; no production guard is disabled.
  await expect(withTenant(f.a.ctx,async tx=>{
   await tx.execute(sql`select set_config('fictional.performance_hook_target',${f.a.id},true)`);
   await complete(tx,f);
   const [sentinel]=await tx.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,f.a.id));
   expect(sentinel).toBeDefined();
   if(change==='status')expect(sentinel).toMatchObject({status:'completed',completedAt:expect.any(Date)});
   else if(change==='notes')expect(sentinel.notes).toBe('Fictional unreviewed note');
   else expect(sentinel.scheduledOn).toBe('2026-12-31');
   const [protectedRow]=await tx.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,f.planned));
   expect(protectedRow).toMatchObject({status:'scheduled',notes:null,completedAt:null,scheduledOn:'2026-12-15'});
   throw Error('fictional actual scheduling hook positive');
  })).rejects.toThrow('fictional actual scheduling hook positive');
  expect(await observed(f)).toEqual(before);
  await expect(withTenant(f.a.ctx,tx=>complete(tx,f))).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});
  expect(await observed(f)).toEqual(before);
 }finally{await cleanup();}
});

it('protects completed scheduling from a real same-role same-root row update after IMMEDIATE',async()=>{
 const f=await setup('schedule'),before=await observed(f);
 // Native ordinary row sentinel from fixture is an actually writable scheduled manager item.
 await expect(withTenant(f.a.ctx,async tx=>{const rows=await tx.update(schema.performanceCheckin).set({notes:'Fictional native authorized positive'}).where(eq(schema.performanceCheckin.id,f.a.id)).returning({id:schema.performanceCheckin.id});
  expect(rows).toHaveLength(1);throw Error('fictional actual writer positive');})).rejects.toThrow('fictional actual writer positive');
 await expect(withTenant(f.a.ctx,async tx=>{await complete(tx,f);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await tx.update(schema.performanceCheckin).set({notes:'Fictional same-root tamper'}).where(eq(schema.performanceCheckin.id,f.planned));
 })).rejects.toMatchObject({cause:{code:'42501',message:'Performance completed command is closed until commit'}});
 expect(await observed(f)).toEqual(before);
});

for(const field of ['person','root','kind'] as const)
it(`refuses scheduling late initial BEFORE completed ledger ${field} substitution`,async()=>{
 const f=await setup('schedule'),before=await observed(f);
 const mutation=field==='person'?`NEW.person_id:='${f.a.employee.personId}'::uuid;`:field==='root'?"NEW.checkin_schedule_birth_xact:='0';":"NEW.action_kind:='performance.checkin.cancel';";
 const cleanup=await install('zz_fictional_schedule_metadata','app.assistant_own_leave_review','BEFORE','UPDATE',
  `IF NEW.id='${f.review.actionId}'::uuid AND NEW.state='completed' THEN ${mutation} END IF;`);
 try{await expect(withTenant(f.a.ctx,tx=>complete(tx,f))).rejects.toThrow();expect(await observed(f)).toEqual(before);
 }finally{await cleanup();}
});

for(const later of ['complete','cancel'] as const)
it(`keeps actual later native ${later} scheduling history available without a second birth`,async()=>{
 const f=await setup('schedule');await withTenant(f.a.ctx,tx=>complete(tx,f));
 const receipt=await checkInSchedulingReviews.reopen(f.a.ctx,f.review.actionId);
 if(later==='complete')await completeCheckIn(f.a.ctx,{checkinId:f.planned,notes:'Fictional legitimate later notes'});
 else await cancelCheckIn(f.a.ctx,{checkinId:f.planned});
 expect(await checkInSchedulingReviews.reopen(f.a.ctx,f.review.actionId)).toEqual(receipt);
 const rows=await owner.db.select().from(schema.performanceCheckin).where(eq(schema.performanceCheckin.id,f.planned));
 expect(rows).toHaveLength(1);expect(rows[0].status).toBe(later==='complete'?'completed':'cancelled');
 const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,f.planned));
 expect(events.filter(e=>e.eventType==='performance-checkin.scheduled')).toHaveLength(1);
});

for(const kind of ['goal','schedule'] as const)
it(`rolls ${kind} native effect back when real DB expiry passes during final body trigger`,async()=>{
 const f=await setup(kind);
 // PROTECTED SQL-LAYER fixture, not encrypted public-confirmation coverage. Owner shortens the
 // existing deadline solely to exercise the SQL final-expiry boundary; no fake JS clock, native
 // production TTL override, review grant or guarded public unwrap bypass is claimed.
 await owner.db.execute(sql`update app.assistant_own_leave_review set expires_at=clock_timestamp()+interval '2 seconds' where id=${f.review.actionId}::uuid`);
 const before=await observed(f);
 const cleanup=await install('zz_fictional_expiry_after_body','app.assistant_own_leave_review_content','AFTER','DELETE',
  `IF OLD.action_id='${f.review.actionId}'::uuid THEN PERFORM pg_sleep(least(3,greatest(0,extract(epoch from ((SELECT expires_at FROM app.assistant_own_leave_review WHERE id=OLD.action_id)-clock_timestamp())))+0.05));END IF;`);
 try{
  await expect(withTenant(f.a.ctx,async tx=>{
   // Fixture observation uses its real owner connection; the app receives no private-table SELECT.
   const [clock]=await owner.db.execute<{live:boolean}>(sql`select clock_timestamp()<expires_at as live from app.assistant_own_leave_review where id=${f.review.actionId}::uuid`);
   expect(clock.live).toBe(true);await complete(tx,f);
  })).rejects.toMatchObject({cause:{code:'42501',message:kind==='schedule'?'Scheduling final custody changed':'Performance completed custody changed'}});
  expect(await observed(f)).toEqual(before);
 }finally{await cleanup();}
});

for(const mode of ['direct-insert','late-before-retarget'] as const)
it(`refuses completed-body ${mode} after a real pending-body positive and whole rollback`,async()=>{
 const f=await setup('schedule');
 const pending=async()=>{const result=await checkInSchedulingReviews.prepare(f.a.ctx,S.Human.parse({action:S.action,
  contractVersion:1,employmentId:f.a.employee.employmentId,scheduledOn:'2026-12-15',confirmSchedule:true}));return result.review;};
 const source=await pending(),target=await pending();
 const [wire]=await owner.db.execute<{kid:string;wrapped_dek:string;ciphertext:string}>(sql`select kid,wrapped_dek,ciphertext from app.assistant_own_leave_review_content where action_id=${target.actionId}::uuid`);
 expect(wire).toBeDefined();expect(wire.kid).toMatch(/^[a-f0-9]{16}$/);
 // Fixture-only removal of a REAL prepared body's wire makes room to restore the SAME original
 // envelope, same AAD/identity. This tests physical body admission, never a forged valid public DTO.
 await owner.db.execute(sql`delete from app.assistant_own_leave_review_content where action_id=${target.actionId}::uuid`);
 const beforePositive=await observed(f);
 const literal=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
 const targetExpr=mode==='direct-insert'
  ?`coalesce(nullif(current_setting('fictional.performance_body_target',true),''),'${f.review.actionId}')::uuid`
  :`'${source.actionId}'::uuid`;
 const cleanupInsert=await install('zz_fictional_completed_body_insert','app.assistant_own_leave_review_content','AFTER','DELETE',
  `IF OLD.action_id='${f.review.actionId}'::uuid AND pg_trigger_depth()=1 THEN INSERT INTO app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext) VALUES(${targetExpr},${literal(wire.kid)},${literal(wire.wrapped_dek)},${literal(wire.ciphertext)});END IF;`);
 let cleanupRetarget:(()=>Promise<void>)|undefined;
 if(mode==='late-before-retarget')cleanupRetarget=await install('zz_fictional_late_body_retarget',
  'app.assistant_own_leave_review_content','BEFORE','INSERT',
  `IF NEW.action_id='${source.actionId}'::uuid THEN NEW.action_id:=coalesce(nullif(current_setting('fictional.performance_body_target',true),''),'${f.review.actionId}')::uuid;PERFORM set_config('fictional.performance_body_late_reached','yes',true);END IF;`);
 try{
  await expect(withTenant(f.a.ctx,async tx=>{
   await tx.execute(sql`select set_config('fictional.performance_body_target',${target.actionId},true)`);
   await complete(tx,f); // actual native effect, actual protected completion, actual DELETE hook
   // No private-table SELECT grant or fixture definer is introduced. Observe the restored real
   // packet through the EXISTING current-login guarded scheduling SQL read owner.
   const [saved]=await tx.execute<{value:{sealed:{kid:string;wrappedDek:string;ciphertext:string};metadata:{state:string}}}>(sql`select app.assistant_checkin_schedule_read(${target.actionId}::uuid) as value`);
   expect(saved.value.metadata.state).toBe('awaiting_confirmation');
   expect(saved.value.sealed).toMatchObject({kid:wire.kid,wrappedDek:wire.wrapped_dek,ciphertext:wire.ciphertext});
   if(mode==='late-before-retarget'){
    const [flag]=await tx.execute<{reached:string}>(sql`select current_setting('fictional.performance_body_late_reached',true) as reached`);
    expect(flag.reached).toBe('yes');
    // Original source body still exists at original id; actual inserted target differs, proving
    // late NEW.action_id retarget rather than a hypothetical source-only trigger installation.
    const [original]=await tx.execute<{value:{metadata:{state:string};sealed:unknown}}>(sql`select app.assistant_checkin_schedule_read(${source.actionId}::uuid) as value`);
    expect(original.value.metadata.state).toBe('awaiting_confirmation');expect(original.value.sealed).not.toBeNull();
   }
   throw Error('fictional actual pending-body positive');
  })).rejects.toThrow('fictional actual pending-body positive');
  expect(await observed(f)).toEqual(beforePositive);
  // Restore the true pending packet outside the effect test. Negative now starts with all three
  // pending reviews/ciphertexts real and intact; compare WHOLE reviews/bodies in rollback snapshot.
  await owner.db.execute(sql`insert into app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext) values(${target.actionId}::uuid,${wire.kid},${wire.wrapped_dek},${wire.ciphertext})`);
  const beforeNegative=await observed(f);
  await expect(withTenant(f.a.ctx,tx=>complete(tx,f))).rejects.toMatchObject({cause:{code:'42501',message:'Review body requires pending parent'}});
  expect(await observed(f)).toEqual(beforeNegative);
 }finally{if(cleanupRetarget)await cleanupRetarget();await cleanupInsert();}
});

it('permits real later canonical erasure after completed scheduling with body already gone',async()=>{
 const f=await setup('schedule');const eventId=await withTenant(f.a.ctx,tx=>complete(tx,f));
 const [before]=await owner.db.execute<{state:string;event:string;planned:string;result:string;root:string;bodies:number}>(sql`select r.state,r.receipt_event_id as event,
  r.checkin_schedule_planned_id as planned,r.checkin_schedule_result_id as result,r.checkin_schedule_birth_xact as root,
  (select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies
  from app.assistant_own_leave_review r where r.id=${f.review.actionId}::uuid`);
 expect(before).toMatchObject({state:'completed',event:eventId,planned:f.planned,result:f.planned,bodies:0});
 // Existing native canonical admission, contact-only scope, real retained subject and audited effect;
 // independent NEW transaction through normal native service owner, no restoration or privilege waiver.
 // Seed genuinely erasable non-NULL contacts; primaryEmail is retained non-NULL identity.
 await owner.db.update(schema.person).set({personalEmail:'fictional-erasure@fixture.test',phone:'+60120000000'}).where(eq(schema.person.id,f.a.employee.personId));
 const [contactBefore]=await owner.db.select().from(schema.person).where(eq(schema.person.id,f.a.employee.personId));
 expect(contactBefore.personalEmail).toBe('fictional-erasure@fixture.test');expect(contactBefore.phone).toBe('+60120000000');
 const report=await withTenant(group(),tx=>erasePersonPiiTx(tx,group(),{subjectEmploymentId:f.a.employee.employmentId,
  scope:'contact',reason:'Fictional later scheduling erasure',requestRef:'fictional-scheduling-'+randomUUID()}));
 expect(report).toBeDefined();
 const [after]=await owner.db.execute<{state:string;event:string;planned:string;result:string;root:string;bodies:number;intent:string|null;reviewed:string|null}>(sql`select r.state,r.receipt_event_id as event,
  r.checkin_schedule_planned_id as planned,r.checkin_schedule_result_id as result,r.checkin_schedule_birth_xact as root,
  r.intent_digest as intent,r.reviewed_digest as reviewed,
  (select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies
  from app.assistant_own_leave_review r where r.id=${f.review.actionId}::uuid`);
 expect(after).toEqual({...before,intent:null,reviewed:null});
 const [person]=await owner.db.select().from(schema.person).where(eq(schema.person.id,f.a.employee.personId));
 expect(report.erased).toEqual(expect.arrayContaining(['personalEmail','phone']));
 expect(person.personalEmail).toBeNull();expect(person.phone).toBeNull();
 expect(person.primaryEmail).toBe(contactBefore.primaryEmail);
 const erasures=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,f.a.employee.personId));
 expect(erasures.filter(e=>e.eventType==='pii.erased')).toHaveLength(1);
 const births=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,f.planned));
 expect(births.filter(e=>e.eventType==='performance-checkin.scheduled')).toHaveLength(1);
});
