/** Genuine current-period system origin, actual human Form completion, same leased job and restricted OneHR sender. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,it,expect,vi} from 'vitest';
import {sql} from 'drizzle-orm';
const auth=vi.hoisted(()=>({origin:'https://system-mail.example.test',send:vi.fn()}));
// Only external Auth/relay credentials and SMTP are fictional. All capability/queue/Form/kernel SQL is real.
vi.mock('../lib/internal-auth/config',async original=>({...await original<typeof import('../lib/internal-auth/config')>(),internalSelected:()=>true,internalConfig:()=>({origin:auth.origin,key:'ab'.repeat(32)}),internalIssuer:(tenant:string)=>auth.origin+'/auth/'+tenant}));
vi.mock('../lib/internal-auth/active-relay',()=>({readLifecycleRelayTx:async()=>({revision:'fixture',senderName:'OneHR',relay:{config:{from:'noreply@system-mail.example.test',fromName:'OneHR'}}})}));
vi.mock('../lib/internal-auth/store',async original=>({...await original<typeof import('../lib/internal-auth/store')>(),admittedAuthSql:{},readRecord:async(_:unknown,key:string)=>{const[tenant,user]=key.slice('credential:'.length).split('/');return {subject:tenant+'/'+user,tenantId:tenant,issuer:auth.origin+'/auth/'+tenant,email:user+'@system-mail.example.test'};}}));
vi.mock('../lib/internal-auth/service',async original=>({...await original<typeof import('../lib/internal-auth/service')>(),InternalAuthError:class extends Error{},assertActiveCredential:async(_:unknown,credential:{subject:string})=>({app_user_id:credential.subject.split('/')[1]})}));
vi.mock('../lib/internal-auth/smtp',()=>({sendSmtp:auth.send}));
import {client} from '../db/client';
import {closeAll,migrateTestDb,owner,createAppUser} from './harness';
import {fixture,letters,saveAnswers,actForm} from './helpers/contract-document-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../packs/automation/service';
import {contractScheduleJobHandler,contractScheduledAutomationJobHandler} from '../packs/contracts/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {internalAutomationMail} from '../lib/internal-auth/automation-mail';
import {todayInKualaLumpur} from '../lib/hr-date';
beforeAll(migrateTestDb);afterAll(closeAll);
it('resumes a genuine current SYSTEM before-end email after actual HR Form completion in the same original job and admits the restricted sender',async()=>{
 auth.send.mockResolvedValue(undefined);
 const today=todayInKualaLumpur(),f=await fixture('renew',false,{start:today.slice(0,4)+'-01-01',end:today});
 const employeeUser=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
 for(const user of [employeeUser,f.admin.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${auth.origin+'/auth/'+f.b.tenantId},${f.b.tenantId+'/'+user},${user}::uuid)`);
 await owner.db.execute(sql`insert into contract_shared_settings(tenant_id,company_id,fallback_group_id,posting_group_id,updated_by) values(${f.b.tenantId}::uuid,${f.b.companyId}::uuid,${f.groupId},${f.groupId},${f.admin.userId}::uuid) on conflict(tenant_id,company_id) do update set fallback_group_id=excluded.fallback_group_id,posting_group_id=excluded.posting_group_id`);
 const documentId=String(f.workflow.steps[0].params.letterTemplateId);
 await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Actual system reminder Form',description:'Current native period only',rules:{},blocks:[{id:'intro',type:'text',text:'For {Full name}.',section:''},{id:'fields',type:'fields',text:'',section:'main'}],fields:[{id:'hrChoice',label:'HR confirmation',type:'select',owner:'hr',pmKey:null,required:true,sensitive:false,options:['Yes','No'],section:'main',when:null}],routing:[{id:'hr-review',order:1,action:'review',owner:true,who:{kind:'group',groupId:f.groupId}},{id:'hr-sign',order:2,action:'sign',owner:false,who:{kind:'group',groupId:f.groupId}},{id:'employee-sign',order:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:1,publish:true,retired:false});
 const emailId=randomUUID();await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Actual before-end Form email',active:true,subject:'Current system reminder',body:'Review the current Form. {{case.link}}',cc:[],documentIds:[documentId]},expectedRevision:0,retired:false,reason:'Actual current-period system email fixture'});
 const emailStep=randomUUID();await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,trigger:{event:'beforeContractEnd',days:0,repeat:false,workdays:false},skipWhen:'decided',steps:[{id:emailStep,type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:1,reason:'Actual date-triggered system email and Form'});
 await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true)`;await tx`select app.contract_shared_system_enqueue('contract_schedule',${randomUUID()}::uuid,jsonb_build_object('day',${today}::text),'morning',${today}::date)`;});
 const tick=async()=>{await runBulkJobTick(owner.client,{handlers:[contractScheduleJobHandler,contractScheduledAutomationJobHandler]});expect(await owner.db.execute(sql`select id,kind,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`)).toEqual([]);};
 type Pin={id:string;jobId:string;eventId:string;runId:string};let pin:Pin|undefined;
 for(let n=0;n<60&&!pin;n++){await tick();[pin]=await owner.db.execute<Pin>(sql`select p.id,o.job_id as "jobId",o.origin_event_id as "eventId",p.workflow_run_id as "runId" from contract_shared_email_document_step p join app.contract_email_prerequisite_origin o on o.tenant_id=p.tenant_id and o.pin_id=p.id join automation_run r on r.tenant_id=p.tenant_id and r.id=p.workflow_run_id and r.status='waiting' and r.waiting_for=p.id where p.tenant_id=${f.b.tenantId}::uuid and p.case_id=${f.caseId}::uuid`);}
 if(!pin)throw new Error('The actual system email did not reach its native pinned Form wait');
 const original=pin,[letter]=await letters(f);expect(letter.purpose).toBe('email');
 const[origin]=await owner.db.execute<{kind:string;creator:string|null;context:unknown;state:string;actor:string;user:string|null;person:string|null;trigger:string}>(sql`select j.kind,j.created_by creator,j.context,j.state,e.actor_type actor,e.actor_user_id as "user",e.actor_person_id person,e.trigger_event trigger from bulk_job j join contract_shared_event e on e.tenant_id=j.tenant_id and e.id=${original.eventId}::uuid where j.id=${original.jobId}::uuid`);
 expect(origin).toEqual({kind:'contract_scheduled_automation',creator:null,context:{tenantId:f.b.tenantId,roles:[]},state:'finalizing',actor:'system',user:null,person:null,trigger:'beforeContractEnd'});
 expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${emailId}`)).toHaveLength(0);
 // The original job must actually enter the durable kernel wait, not finish early or spawn a human replacement.
 await tick();expect((await owner.db.execute<{state:string}>(sql`select state from bulk_job where id=${original.jobId}::uuid`))[0].state).toBe('finalizing');
 await saveAnswers(f.admin,letter.id,{hrChoice:'Yes'});await actForm(f.admin,letter.id,'reviewed');expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 await actForm(f.admin,letter.id,'signed');
 const[callback]=await owner.db.execute<{jobId:string;rootId:string;actor:string;user:string;person:string}>(sql`select e.job_id as "jobId",e.root_event_id as "rootId",e.actor_type actor,e.actor_user_id as "user",e.actor_person_id person from contract_shared_event e join app.contract_email_prerequisite_resume r on r.tenant_id=e.tenant_id and r.event_id=e.id where e.tenant_id=${f.b.tenantId}::uuid and r.pin_id=${original.id}::uuid`);
 expect(callback).toEqual({jobId:original.jobId,rootId:original.eventId,actor:'user',user:f.admin.userId,person:f.admin.personId});
 await new Promise(resolve=>setTimeout(resolve,2100));
 for(let n=0;n<40;n++){await tick();if((await owner.db.execute<{state:string}>(sql`select state from bulk_job where id=${original.jobId}::uuid`))[0].state==='completed')break;}
 const[job]=await owner.db.execute<{state:string;creator:string|null;context:unknown}>(sql`select state,created_by creator,context from bulk_job where id=${original.jobId}::uuid`);expect(job).toEqual({state:'completed',creator:null,context:{tenantId:f.b.tenantId,roles:[]}});
 const[root]=await owner.db.execute<{actor:string;user:string|null;person:string|null;processed:boolean}>(sql`select actor_type actor,actor_user_id as "user",actor_person_id person,processed_at is not null processed from contract_shared_event where id=${original.eventId}::uuid`);expect(root).toEqual({actor:'system',user:null,person:null,processed:true});
 const deliveries=await owner.db.execute<{id:string;creator:string|null;documents:{id:string;contentRevision:number;contentHash:string}[]}>(sql`select id,created_by creator,payload->'mail'->'delivery'->'documents' documents from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${emailId}`);expect(deliveries).toHaveLength(1);expect(deliveries[0].creator).toBeNull();expect(deliveries[0].documents[0]).toMatchObject({id:letter.id,contentRevision:expect.any(Number),contentHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
 expect(await owner.db.execute(sql`select event_id from app.contract_email_prerequisite_resume where tenant_id=${f.b.tenantId}::uuid and pin_id=${original.id}::uuid and completed_at is not null and continued_at is not null`)).toHaveLength(1);
 expect(await owner.db.execute(sql`select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);expect(await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid`)).toHaveLength(0);
 const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' where id=${deliveries[0].id}::uuid`);
 expect((await client`select current_user as role,app.current_tenant_id() tenant`)[0]).toEqual({role:'ai_hr_app',tenant:null});
 expect(await internalAutomationMail({deliveryId:deliveries[0].id,leaseToken:token},auth.send)).toEqual({outcome:'sent',error:null});expect(auth.send).toHaveBeenCalledOnce();expect(auth.send).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({to:employeeUser+'@system-mail.example.test',html:expect.stringContaining('/lifecycle/contracts/letters/'+letter.id)}));
 expect(await internalAutomationMail({deliveryId:deliveries[0].id,leaseToken:token},auth.send)).toMatchObject({outcome:'skipped'});expect(auth.send).toHaveBeenCalledOnce();
 // Genuine kernel/Form/PDF/sender fixtures need load headroom; no external SMTP is used.
},180000);
