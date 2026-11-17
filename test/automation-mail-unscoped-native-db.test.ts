/** Real restricted native capability path and canonical workflow/documents; only Auth credentials/relay and SMTP are fictional. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
const auth=vi.hoisted(()=>({origin:'https://private-mail.example.test',send:vi.fn(),changedUser:false}));
vi.mock('../lib/internal-auth/config',async original=>({...await original<typeof import('../lib/internal-auth/config')>(),internalSelected:()=>true,internalConfig:()=>({origin:auth.origin,key:'ab'.repeat(32)}),internalIssuer:(tenant:string)=>auth.origin+'/auth/'+tenant}));
vi.mock('../lib/internal-auth/active-relay',()=>({readLifecycleRelayTx:async()=>({revision:'fixture',senderName:'OneHR',relay:{config:{from:'noreply@private-mail.example.test',fromName:'OneHR'}}})}));
vi.mock('../lib/internal-auth/store',async original=>({...await original<typeof import('../lib/internal-auth/store')>(),admittedAuthSql:{},readRecord:async(_:unknown,key:string)=>{const [tenant,user]=key.slice('credential:'.length).split('/');return {subject:tenant+'/'+user,tenantId:tenant,issuer:auth.origin+'/auth/'+tenant,email:user+'@private-mail.example.test'};}}));
vi.mock('../lib/internal-auth/service',async original=>({...await original<typeof import('../lib/internal-auth/service')>(),InternalAuthError:class extends Error{},assertActiveCredential:async(_:unknown,credential:{subject:string})=>({app_user_id:auth.changedUser?randomUUID():credential.subject.split('/')[1]})}));
vi.mock('../lib/internal-auth/smtp',()=>({sendSmtp:auth.send}));
import {client,withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,owner,createAppUser} from './harness';
import {fixture,submit,review,letters,finish} from './helpers/contract-document-fixture';
import {saveAutomationWorkflow,saveAutomationEmailTemplate,uploadAutomationEmailAsset,automationEmailBodyDoc} from '../packs/automation/service';
import {readContractSharedLetter,actContractSharedLetter} from '../packs/contracts/service';
import {internalAutomationMail} from '../lib/internal-auth/automation-mail';
let f:Awaited<ReturnType<typeof fixture>>,employee:SessionContext;
const deliver=(request:{deliveryId:string;leaseToken:string})=>internalAutomationMail({deliveryId:request.deliveryId,leaseToken:request.leaseToken},auth.send);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(()=>{vi.clearAllMocks();auth.changedUser=false;auth.send.mockResolvedValue(undefined);});
async function ready(){
 f=await fixture('renew');const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');employee={...f.admin,userId,personId:f.employee.personId,roles:['employee'],grants:undefined};
 for(const user of [userId,f.admin.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${auth.origin+'/auth/'+f.b.tenantId},${f.b.tenantId+'/'+user},${user}::uuid)`);
 const email=randomUUID(),body='Your personal document and information file.';
 const template={id:email,module:'contract_staff' as const,name:'Actual native attachment fixture',active:true,subject:'Your document',body,bodyDoc:automationEmailBodyDoc({body}),cc:[]};
 await saveAutomationEmailTemplate(f.admin,{template,expectedRevision:0,retired:false,reason:'Fictional native sender fixture'});
 const asset=await uploadAutomationEmailAsset(f.admin,{templateId:email,module:'contract_staff',revision:1,kind:'file',name:'information.txt',content:Buffer.from('Fictional actual native file')});
 await saveAutomationEmailTemplate(f.admin,{template:{...template,assets:[asset],documentIds:[String(f.workflow.steps[0].params.letterTemplateId)]},expectedRevision:1,retired:false,reason:'Actual uploaded receipt and published document'});
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,steps:[...f.workflow.steps,{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:email}}]},expectedRevision:1,reason:'Send the actual generated document'});
 await submit(f,'renew');const [letter]=await letters(f);await review(f,letter.id);
 const view=await readContractSharedLetter(employee,letter.id);expect(view.pendingAction?.kind).toBe('sign');
 await actContractSharedLetter(employee,{id:letter.id,actionId:randomUUID(),stepId:view.pendingAction!.stepId,revision:view.contentRevision,hash:view.contentHash!,action:'signed',method:'typed',value:'Fictional employee',consent:true});
 const events=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='letterReleased'`);for(const event of events)await finish(event.job,employee,'contract_automation');
 const [delivery]=await owner.db.execute<{id:string;documents:{id:string;contentRevision:number;contentHash:string}[]}>(sql`select id,payload->'mail'->'delivery'->'documents' as documents from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${email}`);expect(delivery).toBeTruthy();expect(delivery.documents[0]).toMatchObject({id:letter.id,contentRevision:expect.any(Number),contentHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
 const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' where id=${delivery.id}::uuid`);
 return {deliveryId:delivery.id,leaseToken:token,letterId:letter.id};
}
describe('actual unscoped restricted OneHR sender',()=>{
 it('delivers the real queued full native document metadata and uploaded bytes without tenant GUC or owner credentials',async()=>{
  const request=await ready();const [role]=await client`select current_user as role,app.current_tenant_id() as tenant`;expect(role).toEqual({role:'ai_hr_app',tenant:null});
  expect(await deliver(request)).toEqual({outcome:'sent',error:null});
  expect(auth.send).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({to:employee.userId+'@private-mail.example.test',html:expect.stringContaining('/lifecycle/contracts/letters/'+request.letterId),attachments:[expect.objectContaining({filename:'information.txt',bytes:Buffer.from('Fictional actual native file')})]}));
  expect(await deliver(request)).toMatchObject({outcome:'skipped'});expect(auth.send).toHaveBeenCalledOnce();
 },120000);
 it('refuses bad, stale, foreign, changed-user, changed-person and changed-route capabilities before SMTP',async()=>{
  const request=await ready();
  for(const bad of [{...request,leaseToken:randomUUID()},{...request,deliveryId:randomUUID()}]){expect(await deliver(bad)).toMatchObject({outcome:'skipped'});expect((await client`select app.automation_email_materialization(${bad.deliveryId}::uuid,${bad.leaseToken}::uuid,${auth.origin}) as proof`)[0].proof).toBeNull();}
  expect((await client`select app.automation_email_materialization(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'https://foreign.example.test') as proof`)[0].proof).toBeNull();
  auth.changedUser=true;expect(await deliver(request)).toMatchObject({error:'recipientChanged'});auth.changedUser=false;
  await owner.db.execute(sql`update automation_email_delivery set lease_until=now()-interval '1 second' where id=${request.deliveryId}::uuid`);expect(await deliver(request)).toMatchObject({outcome:'skipped'});
  await owner.db.execute(sql`update automation_email_delivery set lease_until=now()+interval '2 minutes' where id=${request.deliveryId}::uuid`);
  const [other]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Fictional changed identity',${randomUUID()+'@private-mail.example.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${other.id}::uuid where id=${employee.userId}::uuid`);expect(await deliver(request)).toMatchObject({outcome:'skipped'});
  await owner.db.execute(sql`update app_user set person_id=${employee.personId}::uuid where id=${employee.userId}::uuid`);
  // The application cannot rewrite a released canonical route to bypass recipient checks.
  await expect(withTenant(employee,tx=>tx.execute(sql`update document_signing_document set data=jsonb_set(data,'{route,steps}','[]'::jsonb) where tenant_id=${f.b.tenantId}::uuid and subject_id=${request.letterId}::uuid`))).rejects.toThrow();
  expect(auth.send).not.toHaveBeenCalled();
  await expect(withTenant(employee,tx=>tx.execute(sql`select app.automation_email_start_before_materialization(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${auth.origin},'{}'::jsonb)`))).rejects.toMatchObject({cause:{code:'42501'}});
 },120000);
});
