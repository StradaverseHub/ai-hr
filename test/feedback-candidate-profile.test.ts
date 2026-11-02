/** Test-only native candidate experiment; production services, migrations and policies stay intact. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import * as s from '../db/schema';
import * as perf from '../packs/performance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('measures the real standard-feedback reader against bounded native candidates with actual RLS retained',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const users=Array.from({length:500},()=>({userId:randomUUID(),personId:randomUUID(),employmentId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional feedback profile',primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'feedback_profile_'+u.userId})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:b.companyId})));
 for(const table of ['employment','person','app_user','role_assignment','peer_feedback_request'])await owner.client.unsafe('analyze '+table);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(b),userId:u.userId,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]});
 const profile={kind:'COMPONENT_PROFILE_NOT_500_USER_CAPACITY',fixtureEmployments:500,callsPerBurst:100,rows:{}as Record<string,number[]>,controls:0,helperDropped:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/feedback-candidate-profile.json',JSON.stringify(profile,null,2));};
 await owner.client.unsafe(`CREATE FUNCTION app.perf_feedback_candidates() RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $candidate$
 BEGIN
  IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Current principal required' USING ERRCODE='42501'; END IF;
  RETURN (WITH own_points AS MATERIALIZED (
   SELECT e.id,e.person_id FROM public.employment e
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
    AND e.person_id=(SELECT p.person_id FROM app.principal(app.current_user_id()) p WHERE p.tenant_id=app.current_tenant_id())
  ) SELECT coalesce(array_agg(r.id),'{}'::uuid[]) FROM own_points e JOIN public.peer_feedback_request r ON r.peer_employment_id=e.id
  WHERE r.tenant_id=app.current_tenant_id() AND r.status='pending' AND app.is_self_person(e.person_id));
 END;$candidate$; REVOKE ALL ON FUNCTION app.perf_feedback_candidates() FROM PUBLIC; GRANT EXECUTE ON FUNCTION app.perf_feedback_candidates() TO ai_hr_app`);
 await owner.client.unsafe(`CREATE FUNCTION app.perf_feedback_projection() RETURNS TABLE(id uuid,subject_name text,source_updated_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $projection$
 BEGIN RETURN QUERY
 SELECT r.id,r.subject_name,r.created_at FROM public.peer_feedback_request r
 WHERE r.tenant_id=app.current_tenant_id() AND r.status='pending'
  AND EXISTS(SELECT 1 FROM public.employment peer WHERE peer.id=r.peer_employment_id AND peer.tenant_id=r.tenant_id AND app.is_self_person(peer.person_id))
  AND NOT EXISTS(SELECT 1 FROM public.performance_onehr_panel panel WHERE panel.request_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM public.performance_review review JOIN public.performance_onehr_cycle cycle ON cycle.cycle_id=review.cycle_id WHERE review.id=r.review_id)
 ORDER BY r.created_at DESC,r.id;
 END;$projection$; REVOKE ALL ON FUNCTION app.perf_feedback_projection() FROM PUBLIC; GRANT EXECUTE ON FUNCTION app.perf_feedback_projection() TO ai_hr_app`);
 const invoker=(context:SessionContext)=>withTenant(context,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,context);
  const rows=await tx.execute<{id:string;subjectName:string;sourceUpdatedAt:Date}>(sql`select id,subject_name as "subjectName",source_updated_at as "sourceUpdatedAt" from app.perf_feedback_projection()`);
  return rows.map(row=>({...row,kind:'feedback' as const,linkPath:'/me/performance#feedback-'+row.id}));
 });
 const candidate=(context:SessionContext)=>withTenant(context,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,context);
  const [row]=await tx.execute<{ids:string[]}>(sql`select app.perf_feedback_candidates()as ids`);
  if(row.ids.length===0)return [];
  // Candidate IDs only narrow a real APP/RLS read. Keep every original predicate and output field.
  const rows=await tx.select({id:s.peerFeedbackRequest.id,subjectName:s.peerFeedbackRequest.subjectName,sourceUpdatedAt:s.peerFeedbackRequest.createdAt}).from(s.peerFeedbackRequest).where(and(
   inArray(s.peerFeedbackRequest.id,row.ids),eq(s.peerFeedbackRequest.tenantId,context.tenantId),eq(s.peerFeedbackRequest.status,'pending'),
   sql`EXISTS(SELECT 1 FROM public.employment peer WHERE peer.id=${s.peerFeedbackRequest.peerEmploymentId} AND peer.tenant_id=${s.peerFeedbackRequest.tenantId} AND app.is_self_person(peer.person_id))`,
   sql`NOT EXISTS(SELECT 1 FROM public.performance_onehr_panel panel WHERE panel.request_id=${s.peerFeedbackRequest.id})`,
   sql`NOT EXISTS(SELECT 1 FROM public.performance_review review JOIN public.performance_onehr_cycle cycle ON cycle.cycle_id=review.cycle_id WHERE review.id=${s.peerFeedbackRequest.reviewId})`
  )).orderBy(desc(s.peerFeedbackRequest.createdAt),s.peerFeedbackRequest.id);
  return rows.map(row=>({...row,kind:'feedback' as const,linkPath:'/me/performance#feedback-'+row.id}));
 });
 const burst=async(read:typeof candidate)=>{const start=performance.now();const results=await Promise.allSettled(users.slice(0,100).map(async u=>expect(await read(ctx(u))).toEqual([])));expect(results.filter(r=>r.status==='rejected')).toEqual([]);return performance.now()-start;};
 try{
  for(const phase of ['original','candidate','invoker','original-after']as const){const read=phase==='candidate'?candidate:phase==='invoker'?invoker:perf.pendingStandardFeedbackTaskMetadata;await burst(read);profile.rows[phase]=[await burst(read),await burst(read)];save();}
  await setModule(b.tenantId,'performance','active');const admin=await entitledCtx(b),today=todayInKualaLumpur();
  const {cycleId}=await perf.createCycle(admin,{name:'Fictional feedback candidate control',periodStart:today.slice(0,4)+'-01-01',periodEnd:today.slice(0,4)+'-12-31'});
  const [review]=await owner.db.insert(s.performanceReview).values({tenantId:b.tenantId,cycleId,employmentId:users[1].employmentId,reviewerEmploymentId:users[2].employmentId}).returning({id:s.performanceReview.id});
  const [request]=await owner.db.insert(s.peerFeedbackRequest).values({tenantId:b.tenantId,reviewId:review.id,subjectEmploymentId:users[1].employmentId,peerEmploymentId:users[0].employmentId,subjectName:'Fictional subject',peerName:'Fictional peer',cycleName:'Fictional cycle'}).returning({id:s.peerFeedbackRequest.id});
  for(const context of [ctx(users[0]),{...ctx(users[0]),personId:null},ctx(users[1]),adminCtx(foreign)]){
   const original=await perf.pendingStandardFeedbackTaskMetadata(context);expect(await candidate(context)).toEqual(original);expect(await invoker(context)).toEqual(original);profile.controls++;
  }
  expect(await candidate(ctx(users[0]))).toMatchObject([{id:request.id,kind:'feedback'}]);
  // Native panel rows can be hidden by the live-card RLS arm. Owner-side candidate pruning must
  // never turn that hidden exclusion into a stronger APP predicate and silently drop existing tasks.
  await owner.db.insert(s.onehrPanel).values({tenantId:b.tenantId,requestId:request.id,reviewId:review.id,subjectEmploymentId:users[1].employmentId,peerEmploymentId:users[0].employmentId,relationship:'peer'});
  const [hidden]=await withTenant(ctx(users[0]),tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from performance_onehr_panel where request_id=${request.id}::uuid`));
  expect(hidden.n).toBe(0);
  const withHiddenPanel=await perf.pendingStandardFeedbackTaskMetadata(ctx(users[0]));expect(withHiddenPanel).toMatchObject([{id:request.id,kind:'feedback'}]);
  expect(await candidate(ctx(users[0]))).toEqual(withHiddenPanel);expect(await invoker(ctx(users[0]))).toEqual(withHiddenPanel);profile.controls++;
  await owner.db.delete(s.onehrPanel).where(eq(s.onehrPanel.requestId,request.id));
  // Converting the cycle uses the existing owner. Every OneHR exclusion still executes as APP,
  // so a hidden review or non-live panel can never be pruned with stronger definer visibility.
  await perf.configureOnehrCycle(admin,cycleId,null);
  for(const context of [ctx(users[0]),{...ctx(users[0]),personId:null},ctx(users[1]),adminCtx(foreign)]){
   const original=await perf.pendingStandardFeedbackTaskMetadata(context);expect(await candidate(context)).toEqual(original);expect(await invoker(context)).toEqual(original);profile.controls++;
  }
  const roles=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,users[0].userId));
  try{
   await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,users[0].userId));
   await expect(candidate(ctx(users[0]))).rejects.toThrow();await expect(invoker(ctx(users[0]))).rejects.toThrow();await expect(perf.pendingStandardFeedbackTaskMetadata(ctx(users[0]))).rejects.toThrow();profile.controls++;
  }finally{await owner.db.insert(s.roleAssignment).values(roles);}
  const bad={...ctx(users[0]),personId:users[1].personId};await expect(candidate(bad)).rejects.toThrow();await expect(invoker(bad)).rejects.toThrow();await expect(perf.pendingStandardFeedbackTaskMetadata(bad)).rejects.toThrow();profile.controls++;
  await owner.client`update app_user set archived_at=now()where id=${users[0].userId}::uuid`;
  await expect(candidate(ctx(users[0]))).rejects.toThrow();await expect(invoker(ctx(users[0]))).rejects.toThrow();await expect(perf.pendingStandardFeedbackTaskMetadata(ctx(users[0]))).rejects.toThrow();profile.controls++;
  await owner.client`update app_user set archived_at=null where id=${users[0].userId}::uuid`;
  await owner.db.update(s.peerFeedbackRequest).set({status:'declined'}).where(eq(s.peerFeedbackRequest.id,request.id));
  expect(await candidate(ctx(users[0]))).toEqual([]);expect(await invoker(ctx(users[0]))).toEqual([]);expect(await perf.pendingStandardFeedbackTaskMetadata(ctx(users[0]))).toEqual([]);profile.controls++;save();
 }finally{await owner.client.unsafe('DROP FUNCTION app.perf_feedback_candidates(); DROP FUNCTION app.perf_feedback_projection()');const [cleanup]=await owner.client`select to_regprocedure('app.perf_feedback_candidates()')is null and to_regprocedure('app.perf_feedback_projection()')is null as clean`;expect(cleanup.clean).toBe(true);profile.helperDropped=true;save();}
},180000);
