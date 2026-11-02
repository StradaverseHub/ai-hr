/** Actual migrated service against its former APP/RLS query; ordered nonempty and live controls. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {and,desc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {peerFeedbackRequest} from '../db/schema';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import * as perf from '../packs/performance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
async function formerQuery(tx:Tx,tenantId:string){
    const rows=await tx.select({id:peerFeedbackRequest.id,subjectName:peerFeedbackRequest.subjectName,
      sourceUpdatedAt:peerFeedbackRequest.createdAt}).from(peerFeedbackRequest)
      .where(and(eq(peerFeedbackRequest.tenantId,tenantId),eq(peerFeedbackRequest.status,'pending'),
        sql`EXISTS (SELECT 1 FROM public.employment peer WHERE peer.id=${peerFeedbackRequest.peerEmploymentId}
          AND peer.tenant_id=${peerFeedbackRequest.tenantId} AND app.is_self_person(peer.person_id))`,
        sql`NOT EXISTS (SELECT 1 FROM public.performance_onehr_panel panel WHERE panel.request_id=${peerFeedbackRequest.id})`,
        sql`NOT EXISTS (SELECT 1 FROM public.performance_review review JOIN public.performance_onehr_cycle cycle ON cycle.cycle_id=review.cycle_id WHERE review.id=${peerFeedbackRequest.reviewId})`))
      .orderBy(desc(peerFeedbackRequest.createdAt),peerFeedbackRequest.id);
    return rows.map(row=>({...row,kind:'feedback' as const,linkPath:'/me/performance#feedback-'+row.id}));
}
const former=(ctx:SessionContext)=>withTenant(ctx,async tx=>{await assertAssignedWorkPrincipalTx(tx,ctx);return formerQuery(tx,ctx.tenantId);});
const native=(tx:Tx,tenantId:string)=>tx.select({id:sql<string>`f.id`,subjectName:sql<string>`f.subject_name`,
 sourceUpdatedAt:sql`f.source_updated_at`.mapWith(s.peerFeedbackRequest.createdAt)})
 .from(sql`app.standard_feedback_task_metadata(${tenantId}::uuid) f`).orderBy(desc(sql`f.source_updated_at`),sql`f.id`);
it('retains invoker ownership, RLS, row ordering and fresh identities across500 actual principals',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 await setModule(b.tenantId,'performance','active');await setModule(foreign.tenantId,'performance','active');
 const users=Array.from({length:500},()=>({userId:randomUUID(),personId:randomUUID(),employmentId:randomUUID()}));
 const foreignPeer={userId:randomUUID(),personId:randomUUID(),employmentId:randomUUID()},foreignSubject={personId:randomUUID(),employmentId:randomUUID()};
 await owner.db.insert(s.person).values([...users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional standard feedback actor',primaryEmail:u.userId+'@example.invalid'})),
  {id:foreignPeer.personId,tenantId:foreign.tenantId,fullName:'Fictional foreign feedback actor',primaryEmail:'foreign-peer@example.invalid'},
  {id:foreignSubject.personId,tenantId:foreign.tenantId,fullName:'Fictional foreign feedback subject',primaryEmail:'foreign-subject@example.invalid'}]);
 await owner.db.insert(s.employment).values([...users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})),
  {id:foreignPeer.employmentId,tenantId:foreign.tenantId,personId:foreignPeer.personId,companyId:foreign.companyId,hiredOn:'2020-01-01'},
  {id:foreignSubject.employmentId,tenantId:foreign.tenantId,personId:foreignSubject.personId,companyId:foreign.companyId,hiredOn:'2020-01-01'}]);
 await owner.db.insert(s.appUser).values([...users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'feedback_plan_'+u.userId})),
  {id:foreignPeer.userId,tenantId:foreign.tenantId,personId:foreignPeer.personId,workosUserId:'feedback_plan_'+foreignPeer.userId}]);
 await owner.db.insert(s.roleAssignment).values([...users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:b.companyId})),
  {tenantId:foreign.tenantId,appUserId:foreignPeer.userId,role:'employee' as const,companyId:foreign.companyId}]);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(b),userId:u.userId,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]});
 const foreignCtx:SessionContext={...adminCtx(foreign),userId:foreignPeer.userId,personId:foreignPeer.personId,roles:['employee'],grants:[{role:'employee',companyId:foreign.companyId}]};
 const signature='app.standard_feedback_task_metadata(uuid)';
 const [fn]=await owner.client`select p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('ai_hr_app',p.oid,'EXECUTE')as app_execute,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where a.grantee=0 and a.privilege_type='EXECUTE')as public_execute from pg_proc p where p.oid=${signature}::regprocedure`;
 expect(fn).toMatchObject({prosecdef:false,provolatile:'s',app_execute:true,public_execute:false});expect(fn.proconfig.some((v:string)=>v.replaceAll(' ','')==='search_path=pg_catalog,public,pg_temp')).toBe(true);
 const today=todayInKualaLumpur(),admin=await entitledCtx(b);
 const {cycleId}=await perf.createCycle(admin,{name:'Fictional standard feedback plan',periodStart:today.slice(0,4)+'-01-01',periodEnd:today.slice(0,4)+'-12-31'});
 const {cycleId:foreignCycle}=await perf.createCycle(await entitledCtx(foreign),{name:'Fictional foreign feedback plan',periodStart:today.slice(0,4)+'-01-01',periodEnd:today.slice(0,4)+'-12-31'});
 const reviews=await owner.db.insert(s.performanceReview).values([1,2,3].map(i=>({tenantId:b.tenantId,cycleId,employmentId:users[i].employmentId,reviewerEmploymentId:users[0].employmentId}))).returning({id:s.performanceReview.id});
 const [foreignReview]=await owner.db.insert(s.performanceReview).values({tenantId:foreign.tenantId,cycleId:foreignCycle,employmentId:foreignSubject.employmentId,reviewerEmploymentId:foreignPeer.employmentId}).returning({id:s.performanceReview.id});
 const at=new Date(Date.UTC(2026,0,1));
 const requests=await owner.db.insert(s.peerFeedbackRequest).values([
  ...[0,1].map(i=>({tenantId:b.tenantId,reviewId:reviews[i].id,subjectEmploymentId:users[i+1].employmentId,peerEmploymentId:users[0].employmentId,subjectName:'Fictional own subject '+i,peerName:'Fictional own peer',createdAt:at})),
  {tenantId:b.tenantId,reviewId:reviews[2].id,subjectEmploymentId:users[3].employmentId,peerEmploymentId:users[1].employmentId,subjectName:'Fictional other recipient subject',peerName:'Fictional other peer',createdAt:at},
 ]).returning({id:s.peerFeedbackRequest.id});
 const [foreignRequest]=await owner.db.insert(s.peerFeedbackRequest).values({tenantId:foreign.tenantId,reviewId:foreignReview.id,subjectEmploymentId:foreignSubject.employmentId,peerEmploymentId:foreignPeer.employmentId,subjectName:'Fictional foreign subject',peerName:'Fictional foreign peer',createdAt:at}).returning({id:s.peerFeedbackRequest.id});
 const expectedIds=requests.slice(0,2).map(r=>r.id).sort();
 const actual=await perf.pendingStandardFeedbackTaskMetadata(ctx(users[0]));expect(actual.map(r=>r.id)).toEqual(expectedIds);expect(actual.every(r=>r.sourceUpdatedAt instanceof Date&&r.sourceUpdatedAt.getTime()===at.getTime())).toBe(true);
 let controls=0;
 const cases=await Promise.allSettled(users.map(async(u,index)=>{
  const got=await perf.pendingStandardFeedbackTaskMetadata(ctx(u));expect(got).toEqual(await former(ctx(u)));
  expect(got.map(r=>r.id)).toEqual(index===0?expectedIds:index===1?[requests[2].id]:[]);controls++;
 }));expect(cases.filter(r=>r.status==='rejected')).toEqual([]);expect(controls).toBe(500);
 expect((await perf.pendingStandardFeedbackTaskMetadata(foreignCtx)).map(r=>r.id)).toEqual([foreignRequest.id]);controls++;
 expect(await perf.pendingStandardFeedbackTaskMetadata({...ctx(users[0]),personId:null})).toEqual(await former({...ctx(users[0]),personId:null}));controls++;
 await withTenant(ctx(users[0]),async tx=>{
  const [before]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);
  for(const current of [ctx(users[0]),ctx(users[1]),foreignCtx,ctx(users[0])]){
   await tx.execute(sql`select set_config('app.tenant_id',${current.tenantId},true),set_config('app.user_id',${current.userId!},true),set_config('app.roles','employee',true),set_config('app.grants',${JSON.stringify(current.grants)},true)`);
   const got=await native(tx,current.tenantId),old=await formerQuery(tx,current.tenantId);expect(got.map(r=>r.id)).toEqual(old.map(r=>r.id));
   expect(got.map(r=>r.id)).toEqual(current.userId===users[0].userId?expectedIds:current.userId===users[1].userId?[requests[2].id]:[foreignRequest.id]);controls++;
  }
  const [after]=await tx.execute<{pid:number}>(sql`select pg_backend_pid()as pid`);expect(after.pid).toBe(before.pid);
  expect(await native(tx,foreign.tenantId)).toEqual([]);controls++;
 });
 // The live-card policy deliberately hides this panel. Its hidden existence must not be an owner-side exclusion.
 await owner.db.insert(s.onehrPanel).values({tenantId:b.tenantId,requestId:requests[0].id,reviewId:reviews[0].id,subjectEmploymentId:users[1].employmentId,peerEmploymentId:users[0].employmentId,relationship:'peer'});
 const [hidden]=await withTenant(ctx(users[0]),tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from performance_onehr_panel where request_id=${requests[0].id}::uuid`));expect(hidden.n).toBe(0);
 expect(await perf.pendingStandardFeedbackTaskMetadata(ctx(users[0]))).toEqual(await former(ctx(users[0])));controls++;
 await owner.db.delete(s.onehrPanel).where(eq(s.onehrPanel.requestId,requests[0].id));
 await perf.configureOnehrCycle(admin,cycleId,null);
 for(const context of [ctx(users[0]),{...ctx(users[0]),personId:null},ctx(users[1]),foreignCtx]){expect(await perf.pendingStandardFeedbackTaskMetadata(context)).toEqual(await former(context));controls++;}
 const denied=async(context:SessionContext)=>{await expect(perf.pendingStandardFeedbackTaskMetadata(context)).rejects.toThrow();await expect(former(context)).rejects.toThrow();controls++;};
 await denied({...ctx(users[0]),personId:users[1].personId});
 const roles=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,users[0].userId));
 try{await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,users[0].userId));await denied(ctx(users[0]));}finally{await owner.db.insert(s.roleAssignment).values(roles);}
 try{await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,users[0].userId));await denied(ctx(users[0]));}finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,users[0].userId));}
 await owner.db.update(s.peerFeedbackRequest).set({status:'declined'}).where(eq(s.peerFeedbackRequest.id,requests[0].id));
 expect(await perf.pendingStandardFeedbackTaskMetadata(ctx(users[0]))).toEqual(await former(ctx(users[0])));controls++;
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/standard-feedback-plan.json',JSON.stringify({kind:'MIGRATED_APP_RLS_PARITY_NOT_CAPACITY',actors:500,controls,signature,securityInvoker:!fn.prosecdef,publicExecute:fn.public_execute,appliedToInstallation:false}));
},120000);
