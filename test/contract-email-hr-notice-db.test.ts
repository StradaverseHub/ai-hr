/** Native6010 notice proof. Only external credentials/SMTP are fictional; all document/kernel/queue SQL is real. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {sql} from 'drizzle-orm';
const auth=vi.hoisted(()=>({origin:'https://hr-notice.example.test',send:vi.fn()}));
// Only external Auth/relay credentials and SMTP are fictional. All capability/queue/Form/kernel SQL is real.
vi.mock('../lib/internal-auth/config',async original=>({...await original<typeof import('../lib/internal-auth/config')>(),internalSelected:()=>true,internalConfig:()=>({origin:auth.origin,key:'ab'.repeat(32)}),internalIssuer:(tenant:string)=>auth.origin+'/auth/'+tenant}));
vi.mock('../lib/internal-auth/active-relay',()=>({readLifecycleRelayTx:async()=>({revision:'fixture',senderName:'OneHR',relay:{config:{from:'noreply@hr-notice.example.test',fromName:'OneHR'}}})}));
vi.mock('../lib/internal-auth/store',async original=>({...await original<typeof import('../lib/internal-auth/store')>(),admittedAuthSql:{},readRecord:async(_:unknown,key:string)=>{const[tenant,user]=key.slice('credential:'.length).split('/');return {subject:tenant+'/'+user,tenantId:tenant,issuer:auth.origin+'/auth/'+tenant,email:user+'@hr-notice.example.test'};}}));
vi.mock('../lib/internal-auth/service',async original=>({...await original<typeof import('../lib/internal-auth/service')>(),InternalAuthError:class extends Error{},assertActiveCredential:async(_:unknown,credential:{subject:string})=>({app_user_id:credential.subject.split('/')[1]})}));
vi.mock('../lib/internal-auth/smtp',()=>({sendSmtp:auth.send}));
import {withTenant} from '../db/client';
import {closeAll,migrateTestDb,owner,setModule} from './harness';
import {contractEmailHRNoticeFixture} from './helpers/contract-email-hr-notice-fixture';
import {internalAutomationMail} from '../lib/internal-auth/automation-mail';
import {bindContractSharedEmployee} from '../packs/contracts/service';
import {saveAutomationWorkflow} from '../packs/automation/service';
beforeAll(migrateTestDb);afterAll(closeAll);
type F=Awaited<ReturnType<typeof contractEmailHRNoticeFixture>>;
async function lease(id:string){const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${id}::uuid`);return token;}
async function actionNotices(f:F){return (await f.notices()).filter(item=>item.payload.mail.subject==='Contract document needs your action');}
async function assertNoBusinessEffects(f:F){
 expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`)).toEqual([]);
 expect(await owner.db.execute(sql`select posting_id from contract_shared_posting where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`)).toEqual([]);
 expect((await owner.db.execute<{count:number}>(sql`select count(*)::integer count from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid`))[0].count).toBe(1);
 expect((await owner.db.execute<{stage:string}>(sql`select data->>'stage' as stage from contract_shared_case where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`))[0].stage).toBe('open');
 expect(await f.employeeMail()).toEqual([]);
}
it('queues one native initial HR link, sends through the restricted real delivery protocol once and never exposes Form data or authored effects',async()=>{
 auth.send.mockReset();auth.send.mockResolvedValue(undefined);
 const f=await contractEmailHRNoticeFixture(auth.origin);await f.drainNotice(f.admin.userId!);const[mail]=await actionNotices(f);
 expect(mail.payload.mail.to).toEqual([f.admin.userId]);expect(mail.payload.mail.cc).toEqual([]);expect(mail.payload.mail.body).toBe('A Contract document is waiting for your action.\n\n{{case.link}}');
 expect(mail.payload.context.letterId).toBe(f.pin.letterId);expect(mail.payload.mail.delivery).toEqual({version:1,sender:'noreply',pdfDocumentIds:[],linkDocumentIds:[],assets:[]});
 const events=await f.snapshot();expect(events).toHaveLength(1);expect(events[0]).toMatchObject({trigger_event:'emailDocumentHRNotice',workflow_versions:[],actor_type:'user',actor_user_id:f.admin.userId,actor_person_id:f.admin.personId});
 const token=await lease(mail.id);expect(await internalAutomationMail({deliveryId:mail.id,leaseToken:token},auth.send)).toMatchObject({outcome:'sent'});expect(auth.send).toHaveBeenCalledOnce();
 const smtpMessage=auth.send.mock.calls[0]?.[1];expect(smtpMessage?.text).toBe('A Contract document is waiting for your action.\n\n'+auth.origin+'/lifecycle/contracts/letters/'+f.pin.letterId);
 expect(await internalAutomationMail({deliveryId:mail.id,leaseToken:token},auth.send)).toMatchObject({outcome:'skipped'});expect(auth.send).toHaveBeenCalledOnce();
 await f.tick();expect(await actionNotices(f)).toHaveLength(1);await assertNoBusinessEffects(f);
 expect(JSON.stringify(events)).not.toContain('hrAnswer');expect(JSON.stringify(mail)).not.toContain('FICTIONAL-PRIVATE');
},180_000);
it('routes HR Review to actual BP Sign and a send-back to the frozen nonemployee owner, while stale notices cancel and employee SendEmail remains held',async()=>{
 const f=await contractEmailHRNoticeFixture(auth.origin);await f.drainNotice(f.admin.userId!);const[oldHR]=await actionNotices(f);
 await f.answer();await f.act(f.admin,'reviewed');await f.drainNotice(f.approver.userId!);
 const bp=(await actionNotices(f)).find(item=>item.payload.mail.to.includes(f.approver.userId!))!;expect(bp).toBeTruthy();
 expect((await owner.db.execute<{target:unknown}>(sql`select app.automation_email_target(${oldHR.id}::uuid,${await lease(oldHR.id)}::uuid,${auth.origin}) as target`))[0].target).toBeNull();
 await f.act(f.approver,'returned');
 for(let count=0;count<100&&(await actionNotices(f)).length<3;count++)await f.tick();
 const notices=await actionNotices(f);expect(notices).toHaveLength(3);expect(notices[2].payload.mail.to).toEqual([f.admin.userId]);
 const latest=(await f.snapshot()).at(-1)!;expect(latest).toMatchObject({actor_type:'user',actor_user_id:f.approver.userId,actor_person_id:f.approver.personId,workflow_versions:[]});
 expect((await owner.db.execute<{target:unknown}>(sql`select app.automation_email_target(${bp.id}::uuid,${await lease(bp.id)}::uuid,${auth.origin}) as target`))[0].target).toBeNull();
 expect(JSON.stringify(notices)).not.toContain('FICTIONAL-PRIVATE-ANSWER-MUST-NOT-MAIL');expect(JSON.stringify(await f.snapshot())).not.toContain('hrAnswer');await assertNoBusinessEffects(f);
},180_000);
it('resumes only the original waiting SendEmail after all actual HR prerequisites finish, without inviting the employee early',async()=>{
 const f=await contractEmailHRNoticeFixture(auth.origin);await f.drainNotice(f.admin.userId!);await f.answer();await f.act(f.admin,'reviewed');await f.drainNotice(f.approver.userId!);expect(await f.employeeMail()).toEqual([]);
 const[origin]=await owner.db.execute<{job:string;event:string}>(sql`select job_id as job,origin_event_id as event from app.contract_email_prerequisite_origin where tenant_id=${f.b.tenantId}::uuid and pin_id=${f.pin.id}::uuid`);
 await f.act(f.approver,'signed');
 for(let count=0;count<100&&(await f.employeeMail()).length===0;count++)await f.tick();expect(await f.employeeMail()).toHaveLength(1);
 const[callback]=await owner.db.execute<{job:string;root:string;run:string;actor:string}>(sql`select event.job_id as job,event.root_event_id as root,event.data->>'runId' as run,event.actor_user_id as actor from contract_shared_event event join app.contract_email_prerequisite_resume receipt on receipt.tenant_id=event.tenant_id and receipt.event_id=event.id where receipt.tenant_id=${f.b.tenantId}::uuid and receipt.pin_id=${f.pin.id}::uuid`);
 expect(callback).toMatchObject({job:origin.job,root:origin.event,run:f.pin.runId,actor:f.approver.userId});
 expect((await actionNotices(f)).flatMap(item=>item.payload.mail.to)).not.toContain(f.employeeActor.userId);
 expect((await owner.db.execute<{status:string}>(sql`select status from automation_run where tenant_id=${f.b.tenantId}::uuid and id=${f.pin.runId}::uuid`))[0].status).toBe('done');
 expect(await owner.db.execute(sql`select posting_id from contract_shared_posting where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`)).toEqual([]);
},180_000);
it('excludes the actual employee PID from parallel pending routes and does not send an invitation when an employee account self-binds',async()=>{
 const f=await contractEmailHRNoticeFixture(auth.origin,{parallel:true,unboundEmployee:true});await f.drainNotice(f.admin.userId!);
 expect((await actionNotices(f)).flatMap(item=>item.payload.mail.to)).toEqual([f.admin.userId]);
 await owner.db.execute(sql`update app_user set person_id=${f.employee.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employeeActor.userId}::uuid`);
 await bindContractSharedEmployee(f.employeeActor,f.pin.letterId);await f.tick();
 expect((await actionNotices(f)).flatMap(item=>item.payload.mail.to)).not.toContain(f.employeeActor.userId);await assertNoBusinessEffects(f);
},180_000);
it('retains a true system initial notice in its actual sealed parent job with no captured or fabricated human',async()=>{
 const f=await contractEmailHRNoticeFixture(auth.origin,{system:true});await f.drainNotice(f.admin.userId!);
 const[event]=await owner.db.execute<{type:string;user:string|null;person:string|null;creator:string|null;kind:string;root:string;source:string}>(sql`select event.actor_type as type,event.actor_user_id as "user",event.actor_person_id as person,job.created_by as creator,job.kind,event.root_event_id as root,source.event_id as source from app.contract_email_hr_notice receipt join contract_shared_event event on event.tenant_id=receipt.tenant_id and event.id=receipt.event_id join bulk_job job on job.tenant_id=event.tenant_id and job.id=event.job_id join app.contract_system_job_source source on source.tenant_id=job.tenant_id and source.job_id=job.id where receipt.tenant_id=${f.b.tenantId}::uuid`);
 expect(event).toMatchObject({type:'system',user:null,person:null,creator:null,kind:'contract_scheduled_automation'});expect(event.root).toBe(event.source);await assertNoBusinessEffects(f);
},180_000);
it.each(['recipientPid','company','entitlement','archivedActor','subjectPerson'] as const)('denies a queued HR notice after actual %s source drift before SMTP',async changed=>{
 auth.send.mockReset();auth.send.mockResolvedValue(undefined);const f=await contractEmailHRNoticeFixture(auth.origin);await f.drainNotice(f.admin.userId!);const[mail]=await actionNotices(f);
 if(changed==='recipientPid')await owner.db.execute(sql`update app_user set person_id=${f.approver.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.admin.userId}::uuid`);
 if(changed==='company'){const[other]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${f.b.tenantId}::uuid,'Fictional changed notice company') returning id`);await owner.db.execute(sql`update employment set company_id=${other.id}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);}
 if(changed==='entitlement')await setModule(f.b.tenantId,'lifecycle','disabled');
 if(changed==='archivedActor')await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${f.admin.userId}::uuid`);
 if(changed==='subjectPerson'){const[person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name) values(${f.b.tenantId}::uuid,'Fictional changed notice subject') returning id`);await owner.db.execute(sql`update employment set person_id=${person.id}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);}
 const token=await lease(mail.id);expect((await owner.db.execute<{target:unknown}>(sql`select app.automation_email_target(${mail.id}::uuid,${token}::uuid,${auth.origin}) as target`))[0].target).toBeNull();
 expect(await internalAutomationMail({deliveryId:mail.id,leaseToken:token},auth.send)).toMatchObject({outcome:'skipped'});expect(auth.send).not.toHaveBeenCalled();
},180_000);
it('keeps fixed notice leaves private, refuses forged unsealed selection and never admits the internal notice as an authored workflow trigger',async()=>{
 const f=await contractEmailHRNoticeFixture(auth.origin);await f.drainNotice(f.admin.userId!);
 const[notice]=await owner.db.execute<{id:string}>(sql`select event_id as id from app.contract_email_hr_notice where tenant_id=${f.b.tenantId}::uuid`);
 await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.contract_shared_email_hr_notice_emit(${f.pin.letterId}::uuid)`))).rejects.toThrow();
 const denied=await owner.client.begin(async native=>{await native`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true),set_config('app.contract_event',${notice.id},true),set_config('app.bulk_job',${randomUUID()},true)`;return native<{held:boolean;effect:boolean}[]>`select app.contract_shared_email_hr_notice_held(${notice.id}::uuid) as held,app.contract_shared_effect_held(${f.caseId}::uuid,${f.pin.runId}::uuid,'email','sendEmail') as effect`;});expect(denied[0]).toEqual({held:false,effect:false});
 await expect(saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,id:randomUUID(),trigger:{event:'emailDocumentHRNotice',days:0,workdays:false,repeat:false}},expectedRevision:0,reason:'Must reject native-only trigger'})).rejects.toThrow();
 const functions=['app.contract_shared_email_hr_notice_source(uuid,uuid,integer)','app.contract_shared_email_hr_notice_emit(uuid,text)','app.contract_shared_email_hr_notice_progress()','app.contract_shared_email_hr_notice_identity(uuid,uuid)','app.contract_shared_email_hr_notice_held(uuid)','app.contract_shared_email_hr_notice_context(uuid,uuid)','app.contract_shared_email_hr_notice_page(uuid)','app.contract_shared_email_hr_notice_eligible(uuid,uuid,jsonb)','app.contract_shared_worker_event_held_before_hr_notice(uuid,integer)','app.contract_shared_effect_held_before_hr_notice(uuid,uuid,text,text)','app.contract_shared_event_check_before_hr_notice(uuid,uuid)','app.contract_shared_mail_context_before_hr_notice(uuid,text)','app.automation_email_queue_rich_before_hr_notice(text,uuid,text,uuid[],uuid[],text,text,jsonb)','app.contract_shared_delivery_eligible_before_hr_notice(uuid,uuid,jsonb)','app.contract_shared_delivery_eligible_before_hr_notice(uuid,uuid,uuid,jsonb)'];
 for(const signature of functions){const[privilege]=await owner.db.execute<{allowed:boolean}>(sql`select has_function_privilege('ai_hr_app',${signature},'EXECUTE') as allowed`);expect(privilege.allowed,signature).toBe(false);}
 const[table]=await owner.db.execute<{rls:boolean;forced:boolean;app:boolean;policy:boolean}>(sql`select c.relrowsecurity as rls,c.relforcerowsecurity as forced,has_table_privilege('ai_hr_app',c.oid,'SELECT') as app,exists(select 1 from pg_policies p where p.schemaname='app' and p.tablename='contract_email_hr_notice' and p.policyname='contract_email_hr_notice_owner') as policy from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relname='contract_email_hr_notice'`);expect(table).toEqual({rls:true,forced:true,app:false,policy:true});
},180_000);
