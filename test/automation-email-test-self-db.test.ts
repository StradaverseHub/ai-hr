import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {v9Setup} from '../packs/lifecycle/service';
import {saveAutomationEmailTemplate,testAutomationEmail} from '../packs/automation/service';
import {saveContractSharedMember,saveContractSharedRole} from '../packs/contracts/service';
import {deliverAutomationEmails} from '../core/automation-email-delivery';
import type {Tx} from '../db/client';
import {automationEmailBodyDoc} from '../lib/automation/email';
const ORIGIN='https://template-test.invalid';
let b:Base,admin:SessionContext,editor:SessionContext,memberId:string,templateId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional template administrator',${randomUUID()+'@template.invalid'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where id=${b.adminUserId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);
 const [subject]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional template editor',${randomUUID()+'@template.invalid'}) returning id`);
 const userId=await createAppUser(b.tenantId,subject.id,'employee');editor={...admin,userId,personId:subject.id,roles:['employee'],grants:undefined};
 const roleId=randomUUID();memberId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:'Template editor only',permissions:['templates'],expectedRevision:0});
 await saveContractSharedMember(admin,{id:memberId,roleId,userId,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
 await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${ORIGIN+'/auth/'+b.tenantId},${randomUUID()},${editor.userId}::uuid)`);
 templateId=randomUUID();const body='Dear {{employee.name}}. New start: {{contract.newStart}}. Open {{case.link}}';
 await saveAutomationEmailTemplate(editor,{template:{id:templateId,module:'contract_staff',name:'Fictional test',active:false,subject:'Contract for {{employee.name}}',body,bodyDoc:automationEmailBodyDoc({body}),cc:[{kind:'person',userId:admin.userId!}]},expectedRevision:0,retired:false,reason:'A saved inactive template can be tested explicitly'});
});
async function queue(requestId=randomUUID()){
 return testAutomationEmail(editor,{templateId,revision:1,sample:'complete',requestId});
}
async function lease(id:string){const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${id}::uuid`);return token;}
async function target(id:string,token:string){return (await owner.db.execute<{value:{bindings:unknown[];payload:{mail:{to:string[];cc:string[];subject:string;body:string;richBody:{values:Record<string,string>}}}}|null}>(sql`select app.automation_email_target(${id}::uuid,${token}::uuid,${ORIGIN}) as value`))[0].value;}
describe('Saved email test addressed only to the actual template editor',()=>{
 it('freezes the saved template and fictional values, ignores default CC, and deduplicates the same request',async()=>{
  const request=randomUUID(),first=await queue(request);expect(await queue(request)).toEqual(first);
  const token=await lease(first.deliveryId),view=await target(first.deliveryId,token);
  expect(view?.payload.mail.to).toEqual([editor.userId]);expect(view?.payload.mail.cc).toEqual([]);expect(view?.payload.mail.subject).toBe('[TEST] Contract for Alex Tan');
  expect(view?.payload.mail.body).toContain('2027-01-01');expect(view?.payload.mail.body).not.toContain('Fictional template editor');expect(view?.payload.mail.richBody.values['case.link']).toBe('/automation/templates');
  expect(await target(first.deliveryId,randomUUID())).toBeNull();
  const [{count}]=await owner.db.execute<{count:string}>(sql`select count(*)::text as count from automation_email_delivery where tenant_id=${b.tenantId}::uuid`);expect(count).toBe('1');
 });
 it('uses the canonical start and receipt protocol and never replays a started message after a lost receipt',async()=>{
  const {deliveryId}=await queue(),token=await lease(deliveryId),view=await target(deliveryId,token);expect(view).not.toBeNull();
  const proof={bindings:view!.bindings,addresses:['fictional-self@template.invalid'],relayRevision:'fixture'};
  const [started]=await owner.db.execute<{ok:boolean}>(sql`select app.automation_email_start(${deliveryId}::uuid,${token}::uuid,${ORIGIN},${JSON.stringify(proof)}::jsonb) as ok`);expect(started.ok).toBe(true);
  expect(await target(deliveryId,token)).toBeNull();
  await owner.db.execute(sql`select app.automation_email_finish(${deliveryId}::uuid,${token}::uuid,'uncertain','uncertain')`);
  await expect(owner.db.execute(sql`update automation_email_delivery set started_at=null,status='queued' where id=${deliveryId}::uuid`)).rejects.toThrow();
 });
 it('invalidates a queued test after permission revocation',async()=>{
  const first=await queue(),token=await lease(first.deliveryId);expect(await target(first.deliveryId,token)).not.toBeNull();
  await owner.db.execute(sql`update contract_access_member set revoked_at=now() where tenant_id=${b.tenantId}::uuid and id=${memberId}::uuid`);
  expect(await target(first.deliveryId,token)).toBeNull();
  await expect(queue()).rejects.toMatchObject({code:'forbidden'});
 });
 it('cancels queued tests when the named human disappears or the account is rebound to another person',async()=>{
  const first=await queue(),token=await lease(first.deliveryId);
  await owner.db.execute(sql`update person set full_name='' where tenant_id=${b.tenantId}::uuid and id=${editor.personId}::uuid`);
  expect(await target(first.deliveryId,token)).toBeNull();
  await owner.db.execute(sql`update person set full_name='Fictional template editor' where tenant_id=${b.tenantId}::uuid and id=${editor.personId}::uuid`);
  const second=await queue(),secondToken=await lease(second.deliveryId);
  const [other]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Different fictional person',${randomUUID()+'@template.invalid'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${other.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${editor.userId}::uuid`);
  expect(await target(second.deliveryId,secondToken)).toBeNull();
 });
 it('delivers the queued self-test through the real sweep without a fictitious case company',async()=>{
  const {deliveryId}=await queue();const runner={...admin,userId:undefined,personId:undefined,roles:[],grants:undefined};let calls=0;
  const connection={withTenant:<T>(ctx:SessionContext,work:(tx:Tx)=>Promise<T>)=>owner.withTenant(ctx,work)};
  const result=await deliverAutomationEmails(runner,connection,async request=>{
   calls++;const view=await target(request.deliveryId,request.leaseToken);expect(view?.payload.mail.to).toEqual([editor.userId]);expect(view?.payload.mail.cc).toEqual([]);
   const [{ok}]=await owner.db.execute<{ok:boolean}>(sql`select app.automation_email_start(${request.deliveryId}::uuid,${request.leaseToken}::uuid,${ORIGIN},${JSON.stringify({bindings:view!.bindings,addresses:['fictional-self@template.invalid'],relayRevision:'fixture'})}::jsonb) as ok`);expect(ok).toBe(true);
   await owner.db.execute(sql`select app.automation_email_finish(${request.deliveryId}::uuid,${request.leaseToken}::uuid,'sent',null)`);return {outcome:'sent',error:null};
  });expect(result).toMatchObject({attempted:1,sent:1,cancelled:0});expect(calls).toBe(1);
  const [{status}]=await owner.db.execute<{status:string}>(sql`select status from automation_email_delivery where id=${deliveryId}::uuid`);expect(status).toBe('sent');
  await deliverAutomationEmails(runner,connection,async()=>{throw Error('A sent self-test must not replay');});
 });
 it('refuses stale revisions and arbitrary recipient inputs without creating mail',async()=>{
  await expect(testAutomationEmail(editor,{templateId,revision:2,sample:'complete',requestId:randomUUID()})).rejects.toMatchObject({code:'forbidden'});
  await expect(testAutomationEmail(editor,{templateId,revision:1,sample:'complete',requestId:randomUUID(),to:[admin.userId]})).rejects.toMatchObject({code:'invalid'});
  const [{count}]=await owner.db.execute<{count:string}>(sql`select count(*)::text as count from automation_email_delivery where tenant_id=${b.tenantId}::uuid`);expect(count).toBe('0');
  await expect(withTenant(editor,tx=>tx.execute(sql`insert into automation_email_delivery(tenant_id,module,subject_id,mail_key,payload,created_by) values(${b.tenantId}::uuid,'contract_staff',${templateId}::uuid,'fake-test','{}'::jsonb,${editor.userId}::uuid)`))).rejects.toThrow();
 });
});
