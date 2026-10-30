import type { NotificationEmailRequest } from '../lib/notification-email-model';
import {leadershipPrinciples} from '../packs/performance/onehr/framework-model';
import { kpiLibraryImportHeaders } from '../packs/performance/onehr/import-model';
import { architectureHeaders } from '../packs/performance/onehr/architecture-model';
import { recordLoginSucceeded } from '../core/auth';
import { parseCsv,toCsv } from '../lib/csv';
import { randomUUID } from 'node:crypto';
import {readFileSync} from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import * as perf from '../packs/performance/service';
import { defaultPolicy, type KPI } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import sourceGolden from './fixtures/onehr/source-golden.json';
import {setRewardMember} from './rewards-access-fixture';
import { createRewardUnit, getRewardUnit, importOnehrRewardResults } from '../packs/rewards/service';
import { adminCtx, closeAll, createAppUser, entitledCtx, harnessSnapshot, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { saveNotificationEmailPolicy,saveNotificationEmailPreferences,retryNotificationEmail } from '../core/notification-email';
import { deliverNotificationEmails,type NotificationEmailTransport } from '../core/notification-email-delivery';
import { dispatchNotifications,dispatchNotificationsFromSweep,notificationStillTargets } from '../core/notifications';
import { appendEvent,actorOf } from '../db/events';
import { todayInKualaLumpur } from '../lib/hr-date';
import { generateDraft,readImage } from '../lib/ai';
import { resolveActiveAiConfig } from '../core/ai-config';

export async function restrictedReminderMailOwner(run:(role:string)=>Promise<void>){
  const role='reminder_mail_owner_'+randomUUID().replaceAll('-','');
  const tables=['performance_assessment_reminder_run','performance_assessment_reminder_recipient','notification_delivery','domain_event','review_cycle','performance_assessment_reminder_epoch'];
  const initial=await owner.client`select c.relname,pg_get_userbyid(c.relowner) as owner from pg_class c where c.relnamespace='public'::regnamespace and c.relname=ANY(${tables}) order by c.relname`;
  const [fn]=await owner.client`select pg_get_userbyid(proowner) as owner from pg_proc where oid='identity_email.assessment_tasks(uuid,uuid,text)'::regprocedure`;
  for(const name of [...initial.map(r=>r.owner),fn.owner])if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))throw Error('Unexpected fixture owner identifier');
  await owner.client.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  try{
    await owner.client.unsafe(`GRANT USAGE,CREATE ON SCHEMA public,app,identity_email TO "${role}"`);
    await owner.client.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
    await owner.client.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app,identity_email TO "${role}"`);
    for(const table of tables)await owner.client.unsafe(`ALTER TABLE ${table} OWNER TO "${role}"`);
    await owner.client.unsafe(`ALTER FUNCTION identity_email.assessment_tasks(uuid,uuid,text) OWNER TO "${role}"`);
    // Deployment must define the helper as the same restricted owner, not only invoke it later.
    const migration=readFileSync(new URL('../db/migrations/0542_account_email_failures.sql',import.meta.url),'utf8');
    const marker=migration.indexOf('CREATE OR REPLACE FUNCTION identity_email.assessment_tasks(');
    expect(marker).toBeGreaterThanOrEqual(0);const definition=migration.slice(marker);expect(definition.length).toBeGreaterThan(1800);
    await owner.client.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE "${role}"`);await tx.unsafe(definition);});
    const [flags]=await owner.client`select r.rolsuper,r.rolbypassrls,p.prosecdef,pg_has_role('ai_hr_app',r.oid,'USAGE') as app_member,has_parameter_privilege(r.oid,'app.tenant_id','SET') as persistent_context_set from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='identity_email.assessment_tasks(uuid,uuid,text)'::regprocedure`;
    expect(flags).toEqual({rolsuper:false,rolbypassrls:false,prosecdef:true,app_member:false,persistent_context_set:false});
    expect((await owner.client`select relforcerowsecurity from pg_class where oid in ('performance_assessment_reminder_run'::regclass,'performance_assessment_reminder_recipient'::regclass) order by relname`).map(r=>r.relforcerowsecurity)).toEqual([true,true]);
    await run(role);
  }finally{
    await owner.client.unsafe(`ALTER FUNCTION identity_email.assessment_tasks(uuid,uuid,text) OWNER TO "${fn.owner}"`);
    for(const row of initial)await owner.client.unsafe(`ALTER TABLE ${row.relname} OWNER TO "${row.owner}"`);
    await owner.client.unsafe(`DROP OWNED BY "${role}"`);await owner.client.unsafe(`DROP ROLE "${role}"`);
  }
}

export const year=Number(todayInKualaLumpur().slice(0,4));

/** Per-file live bindings: hooks and cases retain ownership of their current fixture. */
export function createOnehrServiceFixtures(fixtureState: {readonly b: Base; readonly a: SessionContext; readonly subject: {employmentId:string;personId:string}; readonly manager: {employmentId:string;personId:string}; readonly self: SessionContext; readonly mgr: SessionContext; readonly cycleId: string; readonly reviewId: string; readonly peers: {employmentId:string;ctx:SessionContext}[]}) {

  const hire=(name:string)=>hireEmployee(fixtureState.a,{person:{fullName:name,primaryEmail:`${randomUUID()}@onehr.test`},companyId:fixtureState.b.companyId,departmentId:fixtureState.b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  const view=(ctx:SessionContext=fixtureState.mgr)=>perf.getOnehrReview(ctx,fixtureState.reviewId).then(v=>{if(!v)throw Error('Missing view');return v;});
  async function editableDraftKpi(){
    const id=randomUUID();
    await perf.saveOnehrKpis(fixtureState.self,fixtureState.reviewId,(await view(fixtureState.self)).revision,[{id,title:'Agreed delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:fixtureState.manager.employmentId}],true);
    await perf.approveOnehrScorecard(fixtureState.mgr,fixtureState.reviewId,(await view()).revision,true,'Targets verified');
    vi.mocked(resolveActiveAiConfig).mockImplementation((await vi.importActual<typeof import('../core/ai-config')>('../core/ai-config')).resolveActiveAiConfig);
    return id;
  }

  async function complete(reviewCompetencies=true,overallRemark='',sections=false,selfDemonstrates=false){
    const id=randomUUID(),scoring={mechanism:'A' as const,method:'more' as const,rates:[0,50,100,150,200] as [number,number,number,number,number]};
    await perf.saveOnehrKpis(fixtureState.self,fixtureState.reviewId,(await view(fixtureState.self)).revision,[{id,title:'Deliver agreed outcomes',description:'Evidence-led delivery',weightBp:10000,unit:'units',scoring,moderatorEmploymentId:fixtureState.manager.employmentId}],true);
    await perf.approveOnehrScorecard(fixtureState.mgr,fixtureState.reviewId,(await view()).revision,true,'Agreed objectives');
    await perf.submitOnehrResults(fixtureState.self,fixtureState.reviewId,(await view(fixtureState.self)).revision,[{id,actual:100,note:'Completed outcomes'}],'Completed the agreed outcomes.');
    if(overallRemark)await perf.saveAssessmentDraft(fixtureState.mgr,fixtureState.reviewId,(await view()).revision,null,{kind:'moderation',lines:[{id,actual:100,note:'Verified'}],remark:overallRemark});
    await perf.moderateOnehrKpi(fixtureState.mgr,fixtureState.reviewId,(await view()).revision,id,100,'Verified');
    await perf.confirmOnehrPerformance(fixtureState.mgr,fixtureState.reviewId,(await view()).revision,'ME',overallRemark);
    // The default remains the original Developing source. Protected discussion admission cases opt
    // into explicit native Demonstrate answers with no supporting examples, creating a real question.
    const selfAnswer=selfDemonstrates?'yes':'no';
    await perf.submitOnehrCompetencies(fixtureState.self,fixtureState.reviewId,(await view(fixtureState.self)).revision,{'skill-1':{answer:selfAnswer,remark:''},'skill-2':{answer:selfAnswer,remark:''}},false,'I am developing these skills through assigned work.',sections?{Technical:'Employee category history.'}:{});
    if(reviewCompetencies)await perf.submitOnehrCompetencies(fixtureState.mgr,fixtureState.reviewId,(await view()).revision,{'skill-1':{answer:'yes',remark:'Observed delivery'},'skill-2':{answer:'yes',remark:'Observed future skill'}},true,'',sections?{Technical:'Manager category history.'}:{});
    await perf.assignOnehrPanel(fixtureState.mgr,fixtureState.reviewId,(await view()).revision,fixtureState.peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    for(let i=0;i<fixtureState.peers.length;i++){
      const requests=await perf.onehrAssignments(fixtureState.peers[i].ctx);const request=requests.feedback.find(r=>r.subject==='Assessment subject')!;const card=await perf.getOnehrFeedback(fixtureState.peers[i].ctx,request.id);
      const answer=i<2?'yes':'no';await perf.submitOnehrFeedback(fixtureState.peers[i].ctx,request.id,Object.fromEntries(card.statements.map(s=>[s.id,answer])),answer==='yes'?'Consistently observed these behaviours':'');
    }
  }
  async function reviewerPlan(allMatrix=false){
    const ids=[randomUUID(),randomUUID()],scoring={mechanism:'A' as const,method:'more' as const,rates:[0,50,100,150,200] as [number,number,number,number,number]},matrix=fixtureState.peers[0];
    await perf.saveOnehrKpis(fixtureState.self,fixtureState.reviewId,(await view(fixtureState.self)).revision,ids.map((id,i)=>({id,title:`Delivery ${i+1}`,description:'',weightBp:5000,unit:'units',scoring,moderatorEmploymentId:fixtureState.manager.employmentId})));
    for(const id of allMatrix?ids:[ids[1]])await perf.assignAssessmentKpiModerator(fixtureState.a,fixtureState.reviewId,(await view(fixtureState.a)).revision,id,matrix.employmentId);
    const goalId=randomUUID();await perf.saveOnehrPlan(fixtureState.self,fixtureState.reviewId,null,{career:{aspiration:'Develop facilitation',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:goalId,area:'Facilitation',dueOn:'',onJob:'Facilitate planning',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
    return {matrix,goalId,plan:(await view(fixtureState.mgr)).plans[0]};
  }
return {hire,view,editableDraftKpi,complete,reviewerPlan};
}
