/** Hosted-only UPDATE/event/custody trigger and immutable-anchor adversaries. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {expect,it} from 'vitest';
import {owner} from './harness';
import {b,hire,fixture,state,proof,installPerformancePostimageFixtures} from './helpers/performance-postimage-fixture';
installPerformancePostimageFixtures();

for(const kind of ['goal','cancel','preserve','replace'] as const)for(const stage of ['update','event','before-custody','custody','body'] as const){
 it(`rolls back ${kind} actual persisted-row tampering during ${stage}`,async()=>{
  const a=await fixture(kind),r=(await a.prepare()).review,before=await state(a);
  const table=stage==='body'?'app.assistant_own_leave_review_content':stage==='event'?'public.domain_event':stage.endsWith('custody')?'app.assistant_own_leave_review':kind==='goal'?'public.performance_goal':'public.performance_checkin';
  const condition=stage==='body'?`OLD.action_id='${r.actionId}'::uuid`:stage==='event'?`NEW.aggregate_id='${a.id}'::uuid AND NEW.event_type='${kind==='goal'?'performance-goal.approved':kind==='cancel'?'performance-checkin.cancelled':'performance-checkin.completed'}'`:stage.endsWith('custody')?`NEW.id='${r.actionId}'::uuid AND NEW.state='completed'`:kind==='goal'?`NEW.id='${a.id}'::uuid AND NEW.approval_status='approved'`:`NEW.id='${a.id}'::uuid AND NEW.status='${kind==='cancel'?'cancelled':'completed'}'`;
  const mutation=kind==='goal'?`UPDATE public.performance_goal SET title='Unreviewed trigger title' WHERE id='${a.id}'::uuid;`:kind==='cancel'?`UPDATE public.performance_checkin SET scheduled_on='2026-12-31',notes='Unreviewed cancellation notes' WHERE id='${a.id}'::uuid;`:`UPDATE public.performance_checkin SET notes='Unreviewed completion notes' WHERE id='${a.id}'::uuid;`;
  await owner.db.execute(sql.raw(`CREATE FUNCTION app.fictional_postimage_tamper() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF pg_trigger_depth()=1 AND (${condition}) THEN ${mutation} END IF;IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;END$$`));
  await owner.db.execute(sql.raw(`CREATE TRIGGER fictional_postimage_tamper ${stage==='before-custody'?'BEFORE':'AFTER'} ${stage==='event'?'INSERT':stage==='body'?'DELETE':'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION app.fictional_postimage_tamper()`));
  try{await expect(a.confirm(r)).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({version:1,state:'awaiting_confirmation',bodies:1});}
  finally{await owner.db.execute(sql.raw(`DROP TRIGGER fictional_postimage_tamper ON ${table}`));await owner.db.execute(sql`DROP FUNCTION app.fictional_postimage_tamper()`);}
 });
}
for(const field of ['delete','state','action_kind','receipt_subject_id','user_id','performance_postimage_root_xid'] as const)it(`keeps completed ${field} immutable even when an owner trigger tries removing the fence anchor`,async()=>{
 const a=await fixture('goal'),r=(await a.prepare()).review,before=await state(a),value=field==='state'?"'refused'":field==='action_kind'?"'performance.checkin.cancel'":field==='performance_postimage_root_xid'?'NULL':`'${randomUUID()}'::uuid`;
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.fictional_remove_proof_anchor() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF NEW.id='${r.actionId}'::uuid AND NEW.state='completed' AND pg_trigger_depth()=1 THEN ${field==='delete'?'DELETE FROM app.assistant_own_leave_review WHERE id=NEW.id;':`UPDATE app.assistant_own_leave_review SET ${field}=${value} WHERE id=NEW.id;`}END IF;RETURN NEW;END$$`));
 await owner.db.execute(sql`CREATE TRIGGER fictional_remove_proof_anchor AFTER UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app.fictional_remove_proof_anchor()`);
 try{await expect(a.confirm(r)).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});}
 finally{await owner.db.execute(sql`DROP TRIGGER fictional_remove_proof_anchor ON app.assistant_own_leave_review`);await owner.db.execute(sql`DROP FUNCTION app.fictional_remove_proof_anchor()`);}
});
for(const retarget of ['old-event','new-event','subject-employment'] as const)it(`guards ${retarget} retargeting against protected receipt identities`,async()=>{
 const a=await fixture('goal'),other=await hire('Fictional Other Employment'),r=(await a.prepare()).review,before=await state(a),otherAggregate=randomUUID();
 // These adversarial owner-trigger mutations test OLD/NEW matching; ordinary app event UPDATE is
 // already denied by the immutable domain-event grants and is not claimed as an app-role contrast.
 const mutation=retarget==='subject-employment'?`UPDATE public.employment SET person_id='${other.personId}'::uuid WHERE id='${a.employee.employmentId}'::uuid;`:retarget==='old-event'?`UPDATE public.domain_event SET aggregate_id='${otherAggregate}'::uuid WHERE id=NEW.receipt_event_id;`:`INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id) VALUES('${b.tenantId}'::uuid,'performance-goal','${otherAggregate}'::uuid,'fictional.before-retarget','user','${a.ctx.userId}'::uuid,'${a.employee.employmentId}'::uuid);UPDATE public.domain_event SET aggregate_id='${a.id}'::uuid WHERE aggregate_id='${otherAggregate}'::uuid;`;
 await owner.db.execute(sql.raw(`CREATE FUNCTION app.fictional_retarget_completed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN IF NEW.id='${r.actionId}'::uuid AND NEW.state='completed' AND pg_trigger_depth()=1 THEN ${mutation} END IF;RETURN NEW;END$$`));await owner.db.execute(sql`CREATE TRIGGER fictional_retarget_completed AFTER UPDATE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app.fictional_retarget_completed()`);
 try{await expect(a.confirm(r)).rejects.toThrow();expect(await state(a)).toEqual(before);expect(await proof(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});}
 finally{await owner.db.execute(sql`DROP TRIGGER fictional_retarget_completed ON app.assistant_own_leave_review`);await owner.db.execute(sql`DROP FUNCTION app.fictional_retarget_completed()`);}
});
