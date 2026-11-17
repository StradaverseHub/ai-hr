/** Actual native system jobs: no invented user, creator or human HR outcome; fictional identities only. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,owner,type Base} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {saveAutomationWorkflow,type AutomationWorkflow,automationEventKey} from '../packs/automation/service';
import {contractScheduleJobHandler,contractScheduledAutomationJobHandler} from '../packs/contracts/service';
import {runBulkJobTick,bulkJobContext} from '../core/bulk-job-worker';
import {enqueueBulkJobTx,type BulkJobRow} from '../core/bulk-job';
import {todayInKualaLumpur,timeInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
let b:Base,admin:SessionContext,groupId:string;
const today=todayInKualaLumpur(),start=today.slice(0,4)+'-01-01',origin='https://contract-system-fixture.invalid';
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional actual People Ops owner',${randomUUID()+'@system.test'}) returning id`);await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};
 await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+b.tenantId},${randomUUID()},${admin.userId!}::uuid)`);
 await v9Setup(admin);const cfg=(await v9Workspace(admin)).config!;groupId=randomUUID();await v9SaveConfig(admin,cfg.revision,{...cfg,groups:[...cfg.groups,{id:groupId,name:'Actual native People Ops',members:[admin.userId!],limit:0}],peopleOpsGroup:groupId});
 await owner.db.execute(sql`insert into contract_shared_settings(tenant_id,company_id,fallback_group_id,posting_group_id,updated_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,${groupId},${groupId},${admin.userId!}::uuid)`);
});
async function admit(){return owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id','',true)`;const [row]=await tx<{id:string}[]>`select app.contract_shared_system_enqueue('contract_schedule',${randomUUID()}::uuid,jsonb_build_object('day',${today}::text),'morning',${today}::date) as id`;return row.id;});}
async function finish(max=200){for(let n=0;n<max;n++){const [row]=await owner.client<{active:number;failed:number}[]>`select count(*) filter(where state in('queued','preparing','running','finalizing'))::int as active,count(*) filter(where state='failed')::int as failed from bulk_job where tenant_id=${b.tenantId}::uuid and kind in('contract_schedule','contract_scheduled_automation')`;if(row.failed){const failed=await owner.client`select kind,state,error from bulk_job where tenant_id=${b.tenantId}::uuid and state='failed'`;throw new Error(JSON.stringify(failed));}if(!row.active)return;await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler,contractScheduledAutomationJobHandler]});}throw new Error('Native system work did not finish');}
async function employee(){const endDate=new Date(today+'T00:00:00Z');endDate.setUTCDate(endDate.getUTCDate()+7);const end=endDate.toISOString().slice(0,10);const e=await hireEmployee(admin,{person:{fullName:'Fictional fixed-term subject',primaryEmail:randomUUID()+'@system.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end});await setEmploymentInfo(admin,{employmentId:e.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});return e;}
async function workflow(event='beforeContractEnd',days=7,repeat=false){const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Actual native reminder',description:'Fictional native timer fixture',status:'live',required:false,trigger:{event,days,repeat,workdays:false},skipWhen:'decided',conditions:[],steps:[{id:'actual-notice',type:'notify',to:[{kind:'group',groupId}],cc:[],conditions:[],params:{subject:'Contract reminder for {{employee.name}}',body:'Please review {{employee.name}}.\n{{case.link}}'}}]};await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Actual native timer fixture'});return workflow;}
it('uses the HR date owner across UTC midnight and distinct idempotency keys for daily repeats',()=>{
 const at=new Date('2026-11-16T23:59:00Z');expect(todayInKualaLumpur(at)).toBe('2026-11-17');expect(timeInKualaLumpur(at)).toBe('07:59');expect(timeInKualaLumpur(new Date('2026-11-17T00:00:00Z'))).toBe('08:00');
 const base={trigger:{repeat:false}} as AutomationWorkflow,event={trigger:'beforeContractEnd',occurrence:'period:actual',today:'2026-11-17'};expect(automationEventKey(base,event,'2026-11-17')).toBe(automationEventKey(base,{...event,today:'2026-11-18'},'2026-11-17'));expect(automationEventKey({...base,trigger:{...base.trigger,repeat:true}},event,'2026-11-17')).not.toBe(automationEventKey({...base,trigger:{...base.trigger,repeat:true}},{...event,today:'2026-11-18'},'2026-11-17'));
});
it('opens a real no-case period and queues a protected native reminder without a human actor; replay preserves one run/mail',async()=>{
 const e=await employee(),wf=await workflow(),id=await admit();await finish();
 const [job]=await owner.client<BulkJobRow[]>`select * from bulk_job where id=${id}::uuid`;expect(job).toMatchObject({created_by:null,state:'completed',context:{tenantId:b.tenantId,roles:[]}});await expect(bulkJobContext(owner.client,job)).rejects.toThrow('access');
 const cases=await owner.client`select c.id,t.kind from contract_case c join contract_term t on t.id=c.term_id where c.tenant_id=${b.tenantId}::uuid and c.employment_id=${e.employmentId}::uuid`;expect(cases).toHaveLength(1);expect(cases[0].kind).toBe('fixed_term');
 const events=await owner.client`select actor_type,actor_user_id,actor_person_id from contract_shared_event where tenant_id=${b.tenantId}::uuid`;expect(events).toHaveLength(2);expect(events.every(event=>event.actor_type==='system'&&event.actor_user_id===null&&event.actor_person_id===null)).toBe(true);
 const runs=await owner.client`select id,status from automation_run where tenant_id=${b.tenantId}::uuid and workflow_id=${wf.id}::uuid`;expect(runs).toHaveLength(1);expect(runs[0].status).toBe('done');
 const [mail]=await owner.client`select id,payload,created_by from automation_email_delivery where tenant_id=${b.tenantId}::uuid`;expect(mail).toBeTruthy();expect(mail.created_by).toBeNull();expect(mail.payload.context.systemJobId).toBeTruthy();expect(mail.payload.context.recipientPeople[admin.userId!]).toBe(admin.personId);
 const token=randomUUID();await owner.client`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${mail.id}::uuid`;const [target]=await owner.client`select app.automation_email_target(${mail.id}::uuid,${token}::uuid,${origin}) as value`;expect(target.value).not.toBeNull();
 expect(await admit()).toBe(id);await finish();expect(await owner.client`select id from automation_run where tenant_id=${b.tenantId}::uuid`).toHaveLength(1);expect(await owner.client`select id from automation_email_delivery where tenant_id=${b.tenantId}::uuid`).toHaveLength(1);
 expect(await owner.client`select id from personnel_posting where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);expect(await owner.client`select id from contract_shared_approval where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);
});
it('refuses human capture, app admission, bad null creator kinds, absent capability and mutated system inputs',async()=>{
 await expect(withTenant(admin,tx=>enqueueBulkJobTx(tx,admin,{kind:'contract_schedule',input:{day:today}}))).rejects.toBeTruthy();
 const code=async(fn:()=>Promise<unknown>)=>{try{await fn();return 'ok';}catch(error){return pgSqlState(error);}};
 expect(await code(()=>withTenant(admin,tx=>tx.execute(sql`select app.contract_shared_schedule_admit()`)))).toBe('42501');
 expect(await code(()=>owner.client`insert into bulk_job(tenant_id,kind,created_by,context,operation_key,exclusive_key,input) values(${b.tenantId}::uuid,'contract_preview',null,'{}'::jsonb,${randomUUID()}::uuid,'forged','{}'::jsonb)`))).not.toBe('ok');
 const id=await admit();const [held]=await owner.client`select app.contract_shared_system_job_held(${id}::uuid) as ok`;expect(held.ok).toBe(false);
 await owner.client`update bulk_job set input='{"day":"1900-01-01"}'::jsonb where id=${id}::uuid`;await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler]});const [failed]=await owner.client`select state,error from bulk_job where id=${id}::uuid`;expect(failed.state).toBe('failed');expect(failed.error).toContain('integrity');expect(await owner.client`select id from contract_case where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);
});
it('sends the actual paged flagged-case digest only to authorized real People Ops members',async()=>{
 const e=await employee();await admit();let c:{id:string}|undefined;for(let i=0;i<10&&!c;i++){await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler,contractScheduledAutomationJobHandler]});[c]=await owner.client<{id:string}[]>`select id from contract_case where tenant_id=${b.tenantId}::uuid and employment_id=${e.employmentId}::uuid`;}expect(c).toBeTruthy();
 await owner.client`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{flags}','["no_workflow"]'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${b.tenantId}::uuid and case_id=${c!.id}::uuid`;
 await finish();const mails=await owner.client`select id,payload from automation_email_delivery where tenant_id=${b.tenantId}::uuid`;expect(mails).toHaveLength(1);expect(mails[0].payload.mail.body).toContain('Fictional fixed-term subject');expect(mails[0].payload.mail.body).toContain('no workflow');expect(JSON.stringify(mails[0].payload)).not.toMatch(/salaryCents|healthDocument|bank/);
 const token=randomUUID();await owner.client`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${mails[0].id}::uuid`;const [target]=await owner.client`select app.automation_email_target(${mails[0].id}::uuid,${token}::uuid,${origin}) as value`;expect(target.value).not.toBeNull();expect(target.value.payload.linkPath).toContain('attention=true');
});
