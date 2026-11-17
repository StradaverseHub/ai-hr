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
import {runBulkJobTick,bulkJobContext,type BulkJobHandler} from '../core/bulk-job-worker';
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
async function finish(max=200,handlers:readonly BulkJobHandler[]=[contractScheduleJobHandler,contractScheduledAutomationJobHandler]){for(let n=0;n<max;n++){const [row]=await owner.client<{active:number;failed:number}[]>`select count(*) filter(where state in('queued','preparing','running','finalizing'))::int as active,count(*) filter(where state='failed')::int as failed from bulk_job where tenant_id=${b.tenantId}::uuid and kind in('contract_schedule','contract_scheduled_automation')`;if(row.failed){const failed=await owner.client`select kind,state,error from bulk_job where tenant_id=${b.tenantId}::uuid and state='failed'`;throw new Error(JSON.stringify(failed));}if(!row.active)return;if(!await runBulkJobTick(owner.client,{handlers}))await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Native system work did not finish');}
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
 expect(await code(()=>owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id','',true)`;await tx`insert into bulk_job(tenant_id,kind,created_by,context,operation_key,exclusive_key,input) values(${b.tenantId}::uuid,'contract_preview',null,'{}'::jsonb,${randomUUID()}::uuid,'forged',jsonb_build_object('previewId',${randomUUID()}::text))`;}))).toBe('42501');
 const id=await admit();const held=await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.bulk_job',${id},true)`;return (await tx<{ok:boolean}[]>`select app.contract_shared_system_job_held(${id}::uuid) as ok`)[0];});expect(held.ok).toBe(false);
 await owner.client`update bulk_job set input='{"day":"1900-01-01"}'::jsonb where id=${id}::uuid`;await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler]});const [failed]=await owner.client`select state,error from bulk_job where id=${id}::uuid`;expect(failed.state).toBe('failed');expect(failed.error).toContain('integrity');expect(await owner.client`select id from contract_case where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);
});
it('sends the actual paged flagged-case digest only to authorized real People Ops members',async()=>{
 const e=await employee();await admit();let c:{id:string}|undefined;for(let i=0;i<10&&!c;i++){await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler,contractScheduledAutomationJobHandler]});[c]=await owner.client<{id:string}[]>`select id from contract_case where tenant_id=${b.tenantId}::uuid and employment_id=${e.employmentId}::uuid`;}expect(c).toBeTruthy();
 await owner.client`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{flags}','["no_workflow"]'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${b.tenantId}::uuid and case_id=${c!.id}::uuid`;
 await finish();const mails=await owner.client`select id,payload from automation_email_delivery where tenant_id=${b.tenantId}::uuid`;expect(mails).toHaveLength(1);expect(mails[0].payload.mail.body).toContain('Fictional fixed-term subject');expect(mails[0].payload.mail.body).toContain('no workflow');expect(JSON.stringify(mails[0].payload)).not.toMatch(/salaryCents|healthDocument|bank/);
 const token=randomUUID();await owner.client`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${mails[0].id}::uuid`;const [target]=await owner.client`select app.automation_email_target(${mails[0].id}::uuid,${token}::uuid,${origin}) as value`;expect(target.value).not.toBeNull();expect(target.value.payload.linkPath).toContain('attention=true');
 const config=(await v9Workspace(admin)).config!;await v9SaveConfig(admin,config.revision,{...config,groups:config.groups.map(group=>group.id===groupId?{...group,members:[]}:group)});expect((await owner.client`select app.automation_email_target(${mails[0].id}::uuid,${token}::uuid,${origin}) as value`)[0].value).toBeNull();
});

it('keeps native provenance, input, kind, tenant, live lease and status fences inside actual held units, and retries a transient preparation',async()=>{
 const id=await admit();let prepared=0,checked=false;
 const handler={...contractScheduleJobHandler,systemOwner:{...contractScheduleJobHandler.systemOwner!,async prepare(job:BulkJobRow,unit:Parameters<NonNullable<typeof contractScheduleJobHandler.systemOwner>['prepare']>[1]){
  if(!prepared++)throw Object.assign(new Error('Fictional retryable admission conflict'),{code:'40001'});
  await unit.ownerTx(async tx=>{
   const held=async()=>(await tx<{ok:boolean}[]>`select app.contract_shared_system_job_held(${id}::uuid) as ok`)[0].ok;
   expect(await held()).toBe(true);await tx`select set_config('app.bulk_job',${randomUUID()},true)`;expect(await held()).toBe(false);await tx`select set_config('app.bulk_job',${id},true)`;
   const [original]=await tx<{cap:string;lease:Date;state:string;input:unknown}[]>`select current_setting('app.bulk_job_capability') as cap,lease_expires_at as lease,state,input from bulk_job where id=${id}::uuid`;
   await tx`select set_config('app.bulk_job_capability',${'0'.repeat(64)},true)`;expect(await held()).toBe(false);await tx`select set_config('app.bulk_job_capability',${original.cap},true)`;
   await tx`select set_config('app.tenant_id',${randomUUID()},true)`;expect(await held()).toBe(false);await tx`select set_config('app.tenant_id',${b.tenantId},true)`;
   await tx`update bulk_job set lease_expires_at=now()-interval '1 second' where id=${id}::uuid`;expect(await held()).toBe(false);await tx`update bulk_job set lease_expires_at=${original.lease} where id=${id}::uuid`;
   await tx`update bulk_job set state='completed' where id=${id}::uuid`;expect(await held()).toBe(false);await tx`update bulk_job set state=${original.state} where id=${id}::uuid`;
   await tx`update bulk_job set kind='contract_scheduled_automation' where id=${id}::uuid`;expect(await held()).toBe(false);await tx`update bulk_job set kind='contract_schedule' where id=${id}::uuid`;
   await tx`update bulk_job set input='{"day":"1900-01-01"}'::jsonb where id=${id}::uuid`;expect(await held()).toBe(false);await tx`update bulk_job set input=${JSON.stringify(original.input)}::jsonb where id=${id}::uuid`;
   expect(await held()).toBe(true);checked=true;
  });return contractScheduleJobHandler.systemOwner!.prepare(job,unit);
 }}};
 for(let n=0;n<100;n++){const [job]=await owner.client`select state from bulk_job where id=${id}::uuid`;if(job.state==='completed')break;if(!await runBulkJobTick(owner.client,{handlers:[handler]}))await new Promise(resolve=>setTimeout(resolve,20));}
 expect(checked).toBe(true);expect(prepared).toBe(2);expect((await owner.client`select state from bulk_job where id=${id}::uuid`)[0].state).toBe('completed');
});
it('processes a real 70-company/1,000-employment native morning cohort through the kernel without a saved human principal',async()=>{
 await owner.db.execute(sql`with companies as(insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Morning company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name),departments as(insert into department(tenant_id,company_id,name) select ${b.tenantId}::uuid,id,'Morning department' from companies returning id,company_id),settings as(insert into contract_shared_settings(tenant_id,company_id,fallback_group_id,posting_group_id,updated_by) select ${b.tenantId}::uuid,id,${groupId},${groupId},${admin.userId!}::uuid from companies),numbered as materialized(select c.id,d.id as department_id,row_number() over(order by c.legal_name) as n from companies c join departments d on d.company_id=c.id),fixture as materialized(select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,c.id as company_id,c.department_id from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1),people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Morning employee '||lpad(n::text,4,'0'),'morning-'||n||'@system.test' from fixture),employments as(insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number) select employment_id,${b.tenantId}::uuid,person_id,company_id,${start}::date,'MORNING-'||n,${start}::date,(${today}::date+60),4 from fixture) insert into assignment(id,tenant_id,employment_id,company_id,department_id,employment_type,valid_from) select gen_random_uuid(),${b.tenantId}::uuid,employment_id,company_id,department_id,'contract',${start}::date from fixture`);
 const id=await admit();for(let n=0;n<2400;n++){const [job]=await owner.client`select state,error from bulk_job where id=${id}::uuid`;if(job.state==='failed')throw new Error(job.error);if(job.state==='completed')break;await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler]});}
 expect((await owner.client`select state from bulk_job where id=${id}::uuid`)[0].state).toBe('completed');
 const [counts]=await owner.client`select count(*)::int as cases,count(distinct company_id)::int as companies from contract_case where tenant_id=${b.tenantId}::uuid`;expect(counts).toEqual({cases:1000,companies:70});
 expect((await owner.client`select count(*)::int as count from contract_shared_event where tenant_id=${b.tenantId}::uuid and actor_type='system' and actor_user_id is null and actor_person_id is null`)[0].count).toBe(1000);
 expect((await owner.client`select count(*)::int as count from bulk_job where tenant_id=${b.tenantId}::uuid and kind='contract_scheduled_automation' and created_by is null`)[0].count).toBe(1000);
 expect(await owner.client`select id from personnel_posting where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);
 // Hosted43999497531 measured36.2s for1,000 native periods;120s gives more than3x headroom.
},120000);

it('pages more than 100 authorized digest recipients through the same native job without dropping people',async()=>{
 const records=await owner.client<{id:string}[]>`with fixture as materialized(select n,gen_random_uuid() as person_id,gen_random_uuid() as user_id from generate_series(1,105) n),people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Fictional digest operator '||n,'digest-'||n||'@system.test' from fixture),users as(insert into app_user(id,tenant_id,workos_user_id,person_id) select user_id,${b.tenantId}::uuid,'digest-fixture-'||user_id::text,person_id from fixture),roles as(insert into role_assignment(tenant_id,app_user_id,role,company_id) select ${b.tenantId}::uuid,user_id,'hr_admin',${b.companyId}::uuid from fixture),identities as(insert into app_external_identity(issuer,subject,app_user_id) select ${origin+'/auth/'+b.tenantId},user_id::text,user_id from fixture) select user_id as id from fixture order by user_id`;
 const config=(await v9Workspace(admin)).config!;await v9SaveConfig(admin,config.revision,{...config,groups:config.groups.map(group=>group.id===groupId?{...group,members:records.map(record=>record.id)}:group)});
 const e=await employee();await admit();let caseId:string|undefined;for(let n=0;n<10&&!caseId;n++){await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler,contractScheduledAutomationJobHandler]});caseId=(await owner.client`select id from contract_case where tenant_id=${b.tenantId}::uuid and employment_id=${e.employmentId}::uuid`)[0]?.id;}expect(caseId).toBeTruthy();
 await owner.client`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{flags}','["sent_back"]'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${b.tenantId}::uuid and case_id=${caseId}::uuid`;await finish();
 const mails=await owner.client<{recipient:string;body:string}[]>`select payload->'mail'->'to'->>0 as recipient,payload->'mail'->>'body' as body from automation_email_delivery where tenant_id=${b.tenantId}::uuid order by recipient`;
 expect(mails).toHaveLength(105);expect(mails.map(mail=>mail.recipient)).toEqual(records.map(record=>record.id));expect(mails.every(mail=>mail.body.includes('Fictional fixed-term subject'))).toBe(true);
 expect(await owner.client`select mail_key from app.contract_system_digest where tenant_id=${b.tenantId}::uuid`).toHaveLength(2);
});

it('continues as the system after the real setup operator is archived, using independently active recipients',async()=>{
 const [recipient]=await owner.client<{userId:string;personId:string}[]>`with person_row as(insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional independent People Ops recipient',${randomUUID()+'@system.test'}) returning id),user_row as(insert into app_user(tenant_id,workos_user_id,person_id) select ${b.tenantId}::uuid,${'independent-'+randomUUID()},id from person_row returning id,person_id),role_row as(insert into role_assignment(tenant_id,app_user_id,role,company_id) select ${b.tenantId}::uuid,id,'hr_admin',${b.companyId}::uuid from user_row),identity_row as(insert into app_external_identity(issuer,subject,app_user_id) select ${origin+'/auth/'+b.tenantId},id::text,id from user_row) select id as "userId",person_id as "personId" from user_row`;
 const cfg=(await v9Workspace(admin)).config!;await v9SaveConfig(admin,cfg.revision,{...cfg,groups:cfg.groups.map(group=>group.id===groupId?{...group,members:[admin.userId!,recipient.userId]}:group)});
 await employee();await workflow();await admit();await owner.client`update app_user set archived_at=now() where tenant_id=${b.tenantId}::uuid and id=${admin.userId!}::uuid`;await finish();
 const mails=await owner.client`select payload from automation_email_delivery where tenant_id=${b.tenantId}::uuid`;expect(mails).toHaveLength(1);expect(mails[0].payload.mail.to).toEqual([recipient.userId]);expect(mails[0].payload.context.recipientPeople[recipient.userId]).toBe(recipient.personId);
 expect((await owner.client`select count(*)::int as count from contract_shared_event where tenant_id=${b.tenantId}::uuid and (actor_user_id is not null or actor_person_id is not null)`)[0].count).toBe(0);
});
it('holds already admitted scheduled automation when the actual native period changes before execution',async()=>{
 const e=await employee();await workflow();const id=await admit();for(let n=0;n<30;n++){if((await owner.client`select state from bulk_job where id=${id}::uuid`)[0].state==='completed')break;await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler]});}
 await owner.client`update employment set contract_end_date=contract_end_date+1 where tenant_id=${b.tenantId}::uuid and id=${e.employmentId}::uuid`;
 await runBulkJobTick(owner.client,{handlers:[contractScheduledAutomationJobHandler]});expect((await owner.client`select count(*)::int as count from bulk_job where tenant_id=${b.tenantId}::uuid and kind='contract_scheduled_automation' and state='failed'`)[0].count).toBe(1);
 expect(await owner.client`select id from automation_email_delivery where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);expect(await owner.client`select id from personnel_posting where tenant_id=${b.tenantId}::uuid`).toHaveLength(0);
});

it('admits digest mail only inside its genuine held tenant/case/receipt/exact-key frame',async()=>{
 const e=await employee();await admit();let caseId:string|undefined;for(let n=0;n<10&&!caseId;n++){await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler]});caseId=(await owner.client`select id from contract_case where tenant_id=${b.tenantId}::uuid and employment_id=${e.employmentId}::uuid`)[0]?.id;}
 await owner.client`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{flags}','["no_workflow"]'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${b.tenantId}::uuid and case_id=${caseId}::uuid`;
 let checked=0;
 const handler:BulkJobHandler<never>={...contractScheduleJobHandler,systemOwner:{...contractScheduleJobHandler.systemOwner!,async finalize(job,unit){return contractScheduleJobHandler.systemOwner!.finalize(job,{...unit,ownerTx:fn=>unit.ownerTx(async tx=>{
  const outcome=await fn(tx);const [key]=await tx<{key:string|null}[]>`select nullif(current_setting('app.contract_digest',true),'') as key`;
  if(key.key){
   const allowed=async(id:string)=>(await tx<{ok:boolean}[]>`select app.contract_shared_digest_held(${id}::uuid) as ok`)[0].ok;
   expect(await allowed(caseId!)).toBe(true);expect(await allowed(randomUUID())).toBe(false);
   await tx`select set_config('app.contract_digest','wrong-key',true)`;expect(await allowed(caseId!)).toBe(false);expect((await tx<{ok:boolean}[]>`select app.automation_can_run('contract_staff',${caseId}::uuid) as ok`)[0].ok).toBe(false);await tx`select set_config('app.contract_digest',${key.key},true)`;
   await tx`select set_config('app.bulk_job',${randomUUID()},true)`;expect(await allowed(caseId!)).toBe(false);await tx`select set_config('app.bulk_job',${job.id},true)`;
   expect(await allowed(caseId!)).toBe(true);checked++;
  }return outcome;
 })});}}};
 await finish(200,[handler,contractScheduledAutomationJobHandler]);expect(checked).toBeGreaterThan(0);expect(await owner.client`select id from automation_email_delivery where tenant_id=${b.tenantId}::uuid`).toHaveLength(1);
});
