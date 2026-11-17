import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {saveAutomationEmailTemplate,uploadAutomationEmailAsset,saveAutomationWorkflow,newAutomationRun,sqlAutomationRunStore,automationEmailBodyDoc,type AutomationWorkflow} from '../packs/automation/service';
import {prepareProbationEmailAssetSource} from '../core/automation-email-asset-proof';
import {automationEmailAssetKey} from '../lib/automation-email-asset-proof';
import {emitProbationEventTx,probationAutomationCaseTx} from '../core/probation-automation';
import type {AutomationRichEmailBody} from '../lib/automation-email-content';
const origin='https://asset-proof.example.test',master='ab'.repeat(32);
let f:Awaited<ReturnType<ReturnType<typeof probationOutcomeFixture>['recordedConfirm']>>,tenantId:string,templateId:string,workflow:AutomationWorkflow,assetId:string;
const doc=automationEmailBodyDoc({body:'Fictional information'});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');tenantId=b.tenantId;f=await probationOutcomeFixture(b,adminCtx(b)).recordedConfirm();
 vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);vi.stubEnv('AUTH_SESSION_KEY',master);
 await owner.db.execute(sql`insert into app.automation_email_asset_verifier(singleton,secret) values(true,${automationEmailAssetKey(master)}) on conflict(singleton) do update set secret=excluded.secret`);
 templateId=randomUUID();const template={id:templateId,module:'probation' as const,name:'Fictional file email',active:true,subject:'Information',body:'Fictional information',bodyDoc:doc,cc:[{kind:'person' as const,userId:f.admin.userId!}]};
 await saveAutomationEmailTemplate(f.admin,{template,retired:false,expectedRevision:0,reason:'Fictional native template'});
 const asset=await uploadAutomationEmailAsset(f.admin,{templateId,module:'probation',revision:1,kind:'file',name:'information.txt',content:Buffer.from('Fictional information')});assetId=asset.id;
 await saveAutomationEmailTemplate(f.admin,{template:{...template,assets:[asset]},retired:false,expectedRevision:1,reason:'Include actual uploaded file'});
 workflow={id:randomUUID(),module:'probation',name:'Fictional asset workflow',description:'',status:'live',required:false,trigger:{event:'lowResult',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:templateId}}]};
 await saveAutomationWorkflow(f.admin,{workflow,expectedRevision:0,reason:'Reviewed fictional workflow'});
 for(const userId of[f.staff.userId,f.admin.userId!,f.manager.userId])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+tenantId},${randomUUID()},${userId}::uuid)`);
});
type Input={subjectId:string;key:string;to:string[];cc:string[];subject:string;body:string;richBody:AutomationRichEmailBody};
function words(runId:string):Input{return {subjectId:f.ids.caseId,key:runId+':email',to:[f.staff.userId],cc:[f.admin.userId!],subject:'Information',body:'Fictional information',richBody:{doc,values:{},sourceTemplate:{id:templateId,revision:2}}};}
async function start(tx:Tx){const run=newAutomationRun({id:randomUUID(),workflow,revision:1,subjectId:f.ids.caseId,eventKey:'lowResult|'+randomUUID(),skipped:null,at:new Date().toISOString()});await sqlAutomationRunStore(tx).start(run);return run.id;}
async function queue(tx:Tx,input:ReturnType<typeof words>){
 const array=(ids:string[])=>'{'+ids.join(',')+'}';
 return tx.execute<{result:{queued:number}}>(sql`select app.automation_email_queue_rich('probation',${input.subjectId}::uuid,${input.key},${array(input.to)}::uuid[],${array(input.cc)}::uuid[],${input.subject},${input.body},${JSON.stringify(input.richBody)}::jsonb) as result`);
}
describe('Probation attachment runtime custody',()=>{
 it('refuses cold case readers, unverifiable proof and recipient/body/template/revision/transaction tampering',async()=>{
  const [rights]=await withTenant(f.manager.ctx,tx=>tx.execute<{run:boolean;templates:boolean}>(sql`select app.automation_can_run('probation',${f.ids.caseId}::uuid) as run,app.automation_can_manage('probation','templates') as templates`));expect(rights).toEqual({run:true,templates:false});
  await expect(withTenant(f.manager.ctx,tx=>tx.execute(sql`select secret from app.automation_email_asset_verifier`))).rejects.toThrow();
  await expect(withTenant(f.manager.ctx,async tx=>{const id=await start(tx);await queue(tx,words(id));})).rejects.toMatchObject({cause:{code:'42501',message:'Shared email attachments require the configured runtime verifier and an exact admitted workflow intent'}});
  for(const mutate of[
   (input:ReturnType<typeof words>)=>({...input,to:[f.manager.userId]}),
   (input:ReturnType<typeof words>)=>({...input,body:'Changed message'}),
   (input:ReturnType<typeof words>)=>({...input,richBody:{...input.richBody,values:{'employee.name':'Another person'}}}),
   (input:ReturnType<typeof words>)=>({...input,richBody:{...input.richBody,sourceTemplate:{id:randomUUID(),revision:2}}}),
   (input:ReturnType<typeof words>)=>({...input,richBody:{...input.richBody,sourceTemplate:{id:templateId,revision:1}}}),
  ])await expect(withTenant(f.manager.ctx,async tx=>{
   const input=words(await start(tx)),admitted=await prepareProbationEmailAssetSource(tx,f.manager.ctx,input);expect(admitted).not.toBeNull();
   await queue(tx,mutate({...input,richBody:admitted!}));
  })).rejects.toThrow();
  let replay:ReturnType<typeof words>|null=null;
  await withTenant(f.manager.ctx,async tx=>{const input=words(await start(tx)),richBody=await prepareProbationEmailAssetSource(tx,f.manager.ctx,input);replay={...input,richBody:richBody!};});
  await expect(withTenant(f.manager.ctx,tx=>queue(tx,replay!))).rejects.toMatchObject({cause:{code:'42501',message:'Shared email attachments require the configured runtime verifier and an exact admitted workflow intent'}});
  expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${tenantId}::uuid`)).toHaveLength(0);
 });
 it('freezes native bytes only for the admitted run and stops materialization after recipient person binding changes',async()=>{
  const [{result}]=await withTenant(f.manager.ctx,async tx=>{const input=words(await start(tx)),richBody=await prepareProbationEmailAssetSource(tx,f.manager.ctx,input);return queue(tx,{...input,richBody:richBody!});});expect(result.queued).toBe(1);
  const [mail]=await owner.db.execute<{id:string;assets:{id:string}[];protected:boolean}>(sql`select id,payload->'mail'->'delivery'->'assets' as assets,(payload->'context'->>'assetProtected')::boolean as protected from automation_email_delivery where tenant_id=${tenantId}::uuid`);expect(mail.assets.map(a=>a.id)).toEqual([assetId]);expect(mail.protected).toBe(true);
  const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' where id=${mail.id}::uuid`);
  const files=await owner.db.execute<{id:string;bytes:string}>(sql`select * from app.automation_email_assets(${mail.id}::uuid,${token}::uuid,${origin})`);expect(files).toHaveLength(1);expect(Buffer.from(files[0].bytes,'base64').toString()).toBe('Fictional information');
  const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${tenantId}::uuid,'Fictional replacement identity',${randomUUID()+'@assets.example.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where id=${f.staff.userId}::uuid`);
  expect(await owner.db.execute(sql`select * from app.automation_email_assets(${mail.id}::uuid,${token}::uuid,${origin})`)).toHaveLength(0);
 });
 it('starts attached mail only with the exact private materialization and refuses a replaced proof',async()=>{
  await withTenant(f.manager.ctx,async tx=>{const input=words(await start(tx)),richBody=await prepareProbationEmailAssetSource(tx,f.manager.ctx,input);await queue(tx,{...input,richBody:richBody!});});
  const [mail]=await owner.db.execute<{id:string}>(sql`select id from automation_email_delivery where tenant_id=${tenantId}::uuid`),token=randomUUID();
  await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' where id=${mail.id}::uuid`);
  const [{target,materialized}]=await owner.db.execute<{target:{bindings:unknown[]};materialized:unknown}>(sql`select app.automation_email_target(${mail.id}::uuid,${token}::uuid,${origin}) as target,app.automation_email_materialization(${mail.id}::uuid,${token}::uuid,${origin}) as materialized`);expect(materialized).not.toBeNull();
  const proof={bindings:target.bindings,addresses:target.bindings.map((_,i)=>`fictional${i}@assets.example.test`),relayRevision:'fixture',sharedMaterialization:materialized};
  await expect(withTenant(f.manager.ctx,tx=>tx.execute(sql`select app.automation_email_start_before_materialization(${mail.id}::uuid,${token}::uuid,${origin},${JSON.stringify(proof)}::jsonb)`))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(withTenant(f.manager.ctx,tx=>tx.execute(sql`select app.automation_email_materialization(${mail.id}::uuid,${token}::uuid,${origin})`))).rejects.toMatchObject({cause:{code:'42501'}});
  const [{denied}]=await owner.db.execute<{denied:boolean}>(sql`select app.automation_email_start(${mail.id}::uuid,${token}::uuid,${origin},${JSON.stringify({...proof,sharedMaterialization:{version:1}})}::jsonb) as denied`);expect(denied).toBe(false);
  const [{allowed}]=await owner.db.execute<{allowed:boolean}>(sql`select app.automation_email_start(${mail.id}::uuid,${token}::uuid,${origin},${JSON.stringify(proof)}::jsonb) as allowed`);expect(allowed).toBe(true);
  expect(await owner.db.execute(sql`select * from app.automation_email_assets(${mail.id}::uuid,${token}::uuid,${origin})`)).toHaveLength(0);
 });
 it('holds a real shared-runtime asset step with a setup message while no verifier is installed',async()=>{
  await owner.db.execute(sql`delete from app.automation_email_asset_verifier`);
  const ctx={...f.admin,userId:undefined,personId:undefined,roles:[],grants:undefined} as SessionContext;
  const result=await owner.withTenant(ctx,async tx=>{const record=await probationAutomationCaseTx(tx,f.ids.caseId);return emitProbationEventTx(tx,ctx,{record:record!,trigger:'lowResult',occurrence:randomUUID(),facts:{partId:f.ids.part,partType:3}});});
  expect(result.runs).toHaveLength(1);expect(result.runs[0]).toMatchObject({status:'failed',failure:expect.stringContaining('Set up shared email attachment verification')});
  expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${tenantId}::uuid`)).toHaveLength(0);
 });
});
