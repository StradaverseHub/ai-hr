import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type Tx} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {saveAutomationEmailTemplate,saveAutomationWorkflow,uploadAutomationEmailAsset,newAutomationRun,sqlAutomationRunStore,automationEmailBodyDoc,type AutomationWorkflow} from '../packs/automation/service';
import {convertProbationEmail} from '../lib/automation/probation-email-definition';
import {prepareProbationEmailAssetSource} from '../core/automation-email-asset-proof';
import {automationEmailAssetKey} from '../lib/automation-email-asset-proof';
const origin='https://probation-v2-custody.example.test',master='ba'.repeat(32);
let f:Awaited<ReturnType<ReturnType<typeof probationOutcomeFixture>['recordedConfirm']>>,templateId:string,assetId:string,workflow:AutomationWorkflow;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');f=await probationOutcomeFixture(b,adminCtx(b)).recordedConfirm();
 vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);vi.stubEnv('AUTH_SESSION_KEY',master);
 await owner.db.execute(sql`insert into app.automation_email_asset_verifier(singleton,secret) values(true,${automationEmailAssetKey(master)}) on conflict(singleton) do update set secret=excluded.secret`);
 templateId=randomUUID();const template={id:templateId,module:'probation' as const,name:'V2 exact fictional file',active:true,subject:'Information',body:'Fictional information',cc:[]};
 const converted=convertProbationEmail(template);if(converted.state!=='ready')throw Error('Expected fictional template conversion');
 await saveAutomationEmailTemplate(f.admin,{template:{...template,definition:converted.definition},retired:false,expectedRevision:0,reason:'Create fictional v2 source'});
 const asset=await uploadAutomationEmailAsset(f.admin,{emailId:templateId,revision:1,kind:'file',name:'fictional.txt',content:Buffer.from('Exact v2 fictional bytes')});assetId=asset.id;
 await saveAutomationEmailTemplate(f.admin,{template:{...template,definition:{...converted.definition,files:[asset]}},retired:false,expectedRevision:1,reason:'Include exact fictional receipt'});
 workflow={id:randomUUID(),module:'probation',name:'V2 actual native intent',description:'',status:'live',required:false,trigger:{event:'lowResult',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:templateId}}]};
 await saveAutomationWorkflow(f.admin,{workflow,expectedRevision:0,reason:'Create actual admitted workflow'});
 for(const user of [f.staff.userId,f.manager.userId])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+b.tenantId},${randomUUID()},${user}::uuid)`);
});
async function admitted(tx:Tx){
 const run=newAutomationRun({id:randomUUID(),workflow,revision:1,subjectId:f.ids.caseId,eventKey:'lowResult|'+randomUUID(),skipped:null,at:new Date().toISOString()});await sqlAutomationRunStore(tx).start(run);
 const render={version:2,html:'<p>Fictional information</p>',assets:[{id:assetId,kind:'file',contentHash:''}],documents:[],caseFiles:[],templateRevision:2};
 const [asset]=await tx.execute<{hash:string}>(sql`select content_hash as hash from automation_email_asset where id=${assetId}::uuid`);render.assets[0].contentHash=asset.hash;
 const [digest]=await tx.execute<{hash:string}>(sql`select encode(sha256(convert_to(${JSON.stringify(render)}::jsonb::text,'UTF8')),'hex') as hash`);
 const input={subjectId:f.ids.caseId,key:run.id+':email',to:[f.staff.userId],cc:[] as string[],subject:'Information',body:'Fictional information'};
 const source=await prepareProbationEmailAssetSource(tx,f.admin,{...input,richBody:{doc:{type:'doc',content:[]},values:{probationRichDigest:digest.hash},sourceTemplate:{id:templateId,revision:2}}});
 if(!source?.sourceProof)throw Error('Actual configured runtime must admit the fictional intent');
 return {...input,render:{...render,sourceProof:source.sourceProof}};
}
async function queue(tx:Tx,input:Awaited<ReturnType<typeof admitted>>){
 const array=(ids:string[])=>'{'+ids.join(',')+'}';
 return tx.execute<{result:{queued:number}}>(sql`select app.automation_rich_email_queue('probation',${input.subjectId}::uuid,${input.key},${array(input.to)}::uuid[],${array(input.cc)}::uuid[],${input.subject},${input.body},${templateId}::uuid,${JSON.stringify(input.render)}::jsonb) as result`);
}
async function lease(){
 const [mail]=await owner.db.execute<{id:string}>(sql`select id from automation_email_delivery where tenant_id=${f.admin.tenantId}::uuid`),token=randomUUID();
 await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' where id=${mail.id}::uuid`);
 return {id:mail.id,token};
}
describe('both shared Probation mail protocols preserve native custody',()=>{
 it('refuses missing proof, changed HTML and cross-transaction replay before any v2 disclosure',async()=>{
  await expect(withTenant(f.admin,async tx=>{const input=await admitted(tx);return queue(tx,{...input,render:{...input.render,sourceProof:{payload:'{}',signature:'0'.repeat(64)}}});})).rejects.toThrow();
  await expect(withTenant(f.admin,async tx=>{const input=await admitted(tx);return queue(tx,{...input,render:{...input.render,html:'<p>Another message</p>'}});})).rejects.toThrow();
  let replay:Awaited<ReturnType<typeof admitted>>|undefined;await withTenant(f.admin,async tx=>{replay=await admitted(tx);});
  await expect(withTenant(f.admin,tx=>queue(tx,replay!))).rejects.toThrow();
  expect(await owner.db.execute(sql`select id from automation_email_delivery where tenant_id=${f.admin.tenantId}::uuid`)).toHaveLength(0);
 });
 it('materializes exact v2 files and starts only against the current private proof',async()=>{
  const [queued]=await withTenant(f.admin,async tx=>queue(tx,await admitted(tx)));expect(queued.result.queued).toBe(1);
  const {id,token}=await lease();
  const [{target,materialized}]=await owner.db.execute<{target:{bindings:unknown[]};materialized:unknown}>(sql`select app.automation_email_target(${id}::uuid,${token}::uuid,${origin}) as target,app.probation_email_materialization(${id}::uuid,${token}::uuid,${origin}) as materialized`);expect(materialized).not.toBeNull();
  const files=await owner.db.execute<{id:string;bytes:string}>(sql`select * from app.probation_automation_email_assets(${id}::uuid,${token}::uuid,${origin})`);expect(files).toHaveLength(1);expect(files[0].id).toBe(assetId);expect(Buffer.from(files[0].bytes,'base64').toString()).toBe('Exact v2 fictional bytes');
  const proof={bindings:target.bindings,addresses:target.bindings.map((_,i)=>`fictional${i}@custody.example.test`),relayRevision:'fixture',probationMaterialization:materialized};
  const [{denied}]=await owner.db.execute<{denied:boolean}>(sql`select app.automation_email_start(${id}::uuid,${token}::uuid,${origin},${JSON.stringify({...proof,probationMaterialization:{version:2}})}::jsonb) as denied`);expect(denied).toBe(false);
  const [{allowed}]=await owner.db.execute<{allowed:boolean}>(sql`select app.automation_email_start(${id}::uuid,${token}::uuid,${origin},${JSON.stringify(proof)}::jsonb) as allowed`);expect(allowed).toBe(true);
  expect(await owner.db.execute(sql`select * from app.probation_automation_email_assets(${id}::uuid,${token}::uuid,${origin})`)).toHaveLength(0);
 });
 it('refuses v2 materialization after a recipient account changes its person identity',async()=>{
  await withTenant(f.admin,async tx=>queue(tx,await admitted(tx)));const {id,token}=await lease();
  const [{before}]=await owner.db.execute<{before:unknown}>(sql`select app.probation_email_materialization(${id}::uuid,${token}::uuid,${origin}) as before`);expect(before).not.toBeNull();
  const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.admin.tenantId}::uuid,'Another fictional identity',${randomUUID()+'@custody.example.test'}) returning id`);
  await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where id=${f.staff.userId}::uuid`);
  const [{after}]=await owner.db.execute<{after:unknown}>(sql`select app.probation_email_materialization(${id}::uuid,${token}::uuid,${origin}) as after`);expect(after).toBeNull();
  expect(await owner.db.execute(sql`select * from app.probation_automation_email_assets(${id}::uuid,${token}::uuid,${origin})`)).toHaveLength(0);
 });
 it('guards every native writer against dropping v2 or converting a shared v1 source',async()=>{
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.automation_email_template_save_full(${templateId}::uuid,'probation','Dropped source',true,'Information','Fictional information','[]'::jsonb,false,2,'Direct canonical writer',null,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb)`))).rejects.toThrow();
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.automation_email_template_save(${templateId}::uuid,'probation','Dropped legacy source',true,'Information','Fictional information','[]'::jsonb,false,2,'Direct legacy writer')`))).rejects.toThrow();
  const v1id=randomUUID(),bodyDoc=automationEmailBodyDoc({body:'Existing v1 rich body'}),v1={id:v1id,module:'probation' as const,name:'Existing v1',active:true,subject:'V1',body:'Existing v1 rich body',bodyDoc,cc:[]};
  await saveAutomationEmailTemplate(f.admin,{template:v1,retired:false,expectedRevision:0,reason:'Create actual shared v1 source'});
  const converted=convertProbationEmail(v1);if(converted.state!=='ready')throw Error('Expected conversion');
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select app.automation_rich_email_template_save(${v1id}::uuid,'probation','Conversion',true,'V1','Existing v1 rich body','[]'::jsonb,false,1,'Direct rich writer',${JSON.stringify(converted.definition)}::jsonb)`))).rejects.toThrow();
  const [unchanged]=await owner.db.execute<{revision:number;body_doc:unknown;definition:unknown}>(sql`select revision,body_doc,definition from automation_email_template_version where tenant_id=${f.admin.tenantId}::uuid and template_id=${v1id}::uuid order by revision desc limit 1`);expect(unchanged).toEqual({revision:1,body_doc:bodyDoc,definition:null});
  const [v2]=await owner.db.execute<{revision:number;definition:unknown}>(sql`select revision,definition from automation_email_template_version where tenant_id=${f.admin.tenantId}::uuid and template_id=${templateId}::uuid order by revision desc limit 1`);expect(v2.revision).toBe(2);expect(v2.definition).not.toBeNull();
 });
});
