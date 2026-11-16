/** Direct ai_hr_app attacks. Owner setup arranges fictional native state; application mutations use real engine output. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {prepareResignationProofTx} from '../core/resignation-proof';
import {resignationRuntimeKey,signResignationRuntime} from '../lib/resignation-runtime-proof';
import {actResignationLetter,generateResignationLetter,regenerateResignationLetter,reconcileResignationLetter,type ResignationLetter,type ResignationLetterAction,type GenerateResignationLetterInput} from '../core/resignation-letter';
let b:Base,employee:SessionContext,manager:SessionContext,fyi:SessionContext,id:string,employmentId:string,data:Record<string,unknown>,participants:string[];
const master='6'.repeat(64),day='2027-06-30';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');
 vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://resignation.example.test');vi.stubEnv('AUTH_SESSION_KEY',master);
 await owner.db.execute(sql`delete from app.resignation_runtime_state`);await owner.db.execute(sql`delete from app.resignation_runtime_verifier`);
 await owner.db.execute(sql`insert into app.resignation_runtime_verifier(singleton,secret) values(true,${resignationRuntimeKey(master)})`);
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional resigning employee',primaryEmail:randomUUID()+'@resignation.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});employmentId=hired.employmentId;
 employee={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee']};
 const person=async(name:string)=>{const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@resignation.test'}) returning id`);return{tenantId:b.tenantId,userId:await createAppUser(b.tenantId,p.id,'employee'),personId:p.id,roles:['employee']} as SessionContext;};
 manager=await person('Fictional assigned manager');fyi=await person('Fictional FYI partner');participants=[employee.userId!,manager.userId!,fyi.userId!];id=randomUUID();
 await owner.db.execute(sql`insert into resignation_request(id,tenant_id,employment_id,person_id,last_working_day,reason) values(${id}::uuid,${b.tenantId}::uuid,${employmentId}::uuid,${employee.personId}::uuid,${day},'Moving home')`);
 data={facts:{employmentId,personId:employee.personId,companyId:b.companyId,basicSalary:'6400'},lastWorkingDay:day,reason:'Moving home',decision:{id:randomUUID(),to:[manager.userId],watch:[fyi.userId],choices:'both',canComment:true},offer:null,decidedBy:null,letters:[],releasedDocuments:[],waits:[],tasks:[],comments:[],progress:{}};
 await seedJourney();
});
async function seedJourney(stage='decision'){
 await owner.db.execute(sql`insert into resignation_journey(tenant_id,id,employment_id,company_id,person_id,stage,data,participant_ids,submitted_on) values(${b.tenantId}::uuid,${id}::uuid,${employmentId}::uuid,${b.companyId}::uuid,${employee.personId}::uuid,${stage},${JSON.stringify(data)}::jsonb,${'{'+participants.join(',')+'}'}::uuid[],'2026-11-16') on conflict(tenant_id,id) do update set stage=excluded.stage,data=excluded.data`);
}
const begin=(tx:Tx,ctx:SessionContext,command:Record<string,unknown>,revision=1)=>prepareResignationProofTx(tx,ctx,{operation:'begin',caseId:id,revision,command,args:{}});
async function save(tx:Tx,ctx:SessionContext,next:Record<string,unknown>,stage='decision',revision=1){
 const args={id,revision,action:'runner',stage,data:next,participants,offboarding:null};await prepareResignationProofTx(tx,ctx,{operation:'save',caseId:id,args});
 const[r]=await tx.execute<{revision:number}>(sql`select app.resignation_journey_save(${id}::uuid,${revision},'runner',${stage},${JSON.stringify(next)}::jsonb,${'{'+participants.join(',')+'}'}::uuid[],null) as revision`);return r.revision;
}

async function nativeRefusal(work:Promise<unknown>,code:string,message?:RegExp){
 let failure:unknown;try{await work;}catch(error){failure=error;}
 expect(failure,'native command must refuse').toBeDefined();expect(pgSqlState(failure)).toBe(code);
 if(message)expect(pgErrorChain(failure).find(link=>link.code===code)?.message).toMatch(message);
}
async function persisted(){const[row]=await owner.db.execute<{revision:number;stage:string;data:Record<string,unknown>;participants:string[];offboarding:string|null}>(sql`select revision,stage,data,participant_ids as participants,offboarding_case_id::text as offboarding from resignation_journey where tenant_id=${b.tenantId}::uuid and id=${id}::uuid`);return row;}
it('refuses naked employee/FYI writes, forged signature state, arbitrary recipients and raw private reads',async()=>{
 const original=await persisted();
 for(const ctx of[employee,fyi]){
  expect(await withTenant(ctx,tx=>tx.execute(sql`select data from resignation_journey where id=${id}::uuid`))).toHaveLength(0);
  await nativeRefusal(withTenant(ctx,tx=>tx.execute(sql`select app.resignation_journey_context(${employmentId}::uuid,${id}::uuid)`)),'42501');
  await nativeRefusal(withTenant(ctx,tx=>tx.execute(sql`select app.resignation_journey_save(${id}::uuid,1,'runner','retained',${JSON.stringify({...data,offer:{basicSalary:'99999'},letters:[{document:{actions:[{actorId:manager.userId,action:'signed'}]}}]})}::jsonb,${'{'+ctx.userId+'}'}::uuid[],null)`)),'42501');
  await nativeRefusal(withTenant(ctx,tx=>begin(tx,ctx,{type:'accept',lastWorkingDay:day,replacementNeeded:false})),'42501');
 }
 await nativeRefusal(withTenant(employee,tx=>tx.execute(sql`select * from app.resignation_runtime_verifier`)),'42501',/permission denied/);
 await nativeRefusal(withTenant(employee,tx=>tx.execute(sql`delete from app.resignation_runtime_state`)),'42501',/permission denied/);expect(await persisted()).toEqual(original);
});
it('refuses self-decider seeds even with a valid service custody proof',async()=>{
 await owner.db.execute(sql`delete from resignation_journey where id=${id}::uuid`);
 const seed={...data,decision:{to:[employee.userId],watch:[]}};
 await nativeRefusal(withTenant(employee,async tx=>{await prepareResignationProofTx(tx,employee,{operation:'create',caseId:id,args:{id,data:seed,participants:[employee.userId]}});await tx.execute(sql`select app.resignation_journey_create(${id}::uuid,${JSON.stringify(seed)}::jsonb,${'{'+employee.userId+'}'}::uuid[])`);}),'42501',/seed/);expect(await persisted()).toBeUndefined();
});
it('binds exact payload, actor, transaction, tenant and revision; missing verifier fails closed',async()=>{
 const original=await persisted();
 await nativeRefusal(withTenant(manager,tx=>begin(tx,manager,{type:'accept',lastWorkingDay:day,replacementNeeded:false},2)),'40001');
 let replay:{payload:string;signature:string}|undefined;
 await withTenant(manager,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select txid_current()::text id`);replay=signResignationRuntime({operation:'read',caseId:id,args:{mode:'case',caseId:id}},{tenantId:b.tenantId,userId:manager.userId!,personId:manager.personId!,transactionId:row.id},master);});
 await nativeRefusal(withTenant(manager,tx=>tx.execute(sql`select app.resignation_journey_admit(${replay!.payload},${replay!.signature})`)),'42501');
 await nativeRefusal(withTenant(fyi,tx=>tx.execute(sql`select app.resignation_journey_admit(${replay!.payload},${replay!.signature})`)),'42501');
 await nativeRefusal(withTenant(manager,async tx=>{await begin(tx,manager,{type:'accept',lastWorkingDay:day,replacementNeeded:false});const next={...data,lastWorkingDay:day,replacementNeeded:false};await prepareResignationProofTx(tx,manager,{operation:'save',caseId:id,args:{id,revision:1,action:'runner',stage:'accepted',data:next,participants,offboarding:null}});await tx.execute(sql`select app.resignation_journey_save(${id}::uuid,1,'runner','retained',${JSON.stringify(next)}::jsonb,${'{'+participants.join(',')+'}'}::uuid[],null)`);}),'42501');
 await owner.db.execute(sql`delete from app.resignation_runtime_verifier`);
 await nativeRefusal(withTenant(manager,tx=>begin(tx,manager,{type:'accept',lastWorkingDay:day,replacementNeeded:false})),'42501',/not provisioned/);expect(await persisted()).toEqual(original);
});
it('lets an assigned manager accept, protects the scalar command and keeps legacy termination pending',async()=>{
 await withTenant(manager,async tx=>{await begin(tx,manager,{type:'accept',lastWorkingDay:day,replacementNeeded:false});await save(tx,manager,{...data,decision:null,replacementNeeded:false,decidedBy:{id:manager.userId,name:'Fictional assigned manager'}},'accepted');});
 const[row]=await owner.db.execute<{stage:string;status:string;terminated:string|null}>(sql`select j.stage,r.status,e.terminated_on::text terminated from resignation_journey j join resignation_request r on r.id=j.id join employment e on e.id=j.employment_id where j.id=${id}::uuid`);expect(row).toEqual({stage:'accepted',status:'pending',terminated:null});
 const[proofState]=await owner.db.execute<{aggregate:boolean;unusedBegin:boolean}>(sql`select exists(select 1 from app.resignation_runtime_state where tenant_id=${b.tenantId}::uuid and actor=${manager.userId} and payload ? 'initialData') as aggregate,exists(select 1 from app.resignation_runtime_state where tenant_id=${b.tenantId}::uuid and actor=${manager.userId} and kind='proof:begin') as "unusedBegin"`);expect(proofState).toEqual({aggregate:false,unusedBegin:false});
 await nativeRefusal(withTenant(adminCtx(b),tx=>tx.execute(sql`update resignation_request set status='accepted' where id=${id}::uuid`)),'42501',/completed clearance/);
 await nativeRefusal(withTenant(employee,tx=>tx.execute(sql`update resignation_request set last_working_day='2027-07-01' where id=${id}::uuid`)),'42501',/authorized journey/);expect(await persisted()).toMatchObject({stage:'accepted',revision:2,data:{lastWorkingDay:day}});
});
function letterInput():GenerateResignationLetterInput{
 return {id:randomUUID(),kind:'retention',tenantId:b.tenantId,companyId:b.companyId,subjectId:id,employeeUserId:employee.userId!,caseOwnerId:manager.userId!,generatedOn:'2026-11-16',generatedAt:'2026-11-16T04:00:00Z',facts:{caseType:'Resignation'},values:{'employee.name':'Fictional employee','resignation.lastDay':day},template:{id:'tpl-off',name:'Fictional retention',module:'off',type:'Letter',rules:{},retired:false,currentVersion:1,hrStep:'before',employeeAck:true,versions:[{version:1,state:'published',at:'2026-11-16T04:00:00Z',by:manager.userId!,fields:[],blocks:[{id:'text',type:'text',section:'',text:'Last working day {resignation.lastDay}'},{id:'signature',type:'signature',section:'',text:'',role:'step:employee-sign'}],routing:[{id:'owner-review',order:1,action:'review',who:{kind:'people',userIds:[manager.userId!]},owner:true},{id:'employee-sign',order:2,action:'sign',who:{kind:'employee'},owner:false}]}]},context:{employeeUserId:employee.userId!,directSuperiorUserId:manager.userId!,facts:{},routing:()=>null,groupMembers:()=>null,choose:ids=>ids[0]??null,fallback:null,describe:()=> 'Fictional holder'}};
}
function realLetter():ResignationLetter{return generateResignationLetter(letterInput()).letter;}
function act(letter:ResignationLetter,ctx:SessionContext,action:ResignationLetterAction){return actResignationLetter(letter,{id:randomUUID(),documentRevision:letter.revision,actor:{userId:ctx.userId!,personId:ctx.personId!,name:'Fictional verified actor',at:new Date().toISOString(),today:'2026-11-16'},action}).letter;}
it('accepts a real pending employee signature after opening and supports owner recall/correction',async()=>{
 let l=act(realLetter(),manager,{type:'complete',stepId:'owner-review'});data={...data,decision:null,offer:{position:'Fictional role',jobGrade:'G2',basicSalary:'6800',effectiveDate:day,justification:'Retain'},letters:[l]};await seedJourney('offer');
 const unopened=await persisted();
 for(const command of [{type:'letterAction',documentId:l.id,documentRevision:l.revision,action:'sign',signature:'Fictional employee',consent:true},{type:'sendBack',documentId:l.id,documentRevision:l.revision,reason:'Review this offer'},{type:'declineOffer',documentId:l.id,documentRevision:l.revision},{type:'updateLetter',documentId:l.id,documentRevision:l.revision}]){
  await nativeRefusal(withTenant(employee,tx=>begin(tx,employee,command)),'42501',/not currently assigned/);expect(await persisted()).toEqual(unopened);
 }
 await withTenant(manager,async tx=>{await begin(tx,manager,{type:'recall',documentId:l.id,documentRevision:l.revision});l=act(l,manager,{type:'recall'});data={...data,letters:[l]};await save(tx,manager,data,'retention');});
 expect(l.state).toBe('owner');
 const corrected='2027-07-01';await withTenant(manager,async tx=>{await begin(tx,manager,{type:'updateLetter',documentId:l.id,documentRevision:l.revision,lastWorkingDay:corrected},2);l=reconcileResignationLetter(l,{'employee.name':'Fictional employee','resignation.lastDay':corrected}).letter;data={...data,lastWorkingDay:corrected,letters:[l]};await save(tx,manager,data,'retention',2);});
 await withTenant(manager,async tx=>{await begin(tx,manager,{type:'resendLetter',documentId:l.id,documentRevision:l.revision},3);l=act(l,manager,{type:'resend'});data={...data,letters:[l]};await save(tx,manager,data,'retention',3);});
 await withTenant(manager,async tx=>{await begin(tx,manager,{type:'letterAction',documentId:l.id,documentRevision:l.revision,action:'review'},4);l=act(l,manager,{type:'complete',stepId:'owner-review'});data={...data,letters:[l]};await save(tx,manager,data,'offer',4);});
 await withTenant(employee,async tx=>{await begin(tx,employee,{type:'openLetter',documentId:l.id,documentRevision:l.revision},5);l=act(l,employee,{type:'open'});data={...data,letters:[l]};await save(tx,employee,data,'offer',5);});
 await withTenant(employee,async tx=>{await begin(tx,employee,{type:'letterAction',documentId:l.id,documentRevision:l.revision,action:'sign',signature:'Fictional employee',consent:true},6);l=act(l,employee,{type:'complete',stepId:'employee-sign',signature:'Fictional employee',consent:true});data={...data,letters:[l]};await save(tx,employee,data,'retained',6);});
 expect(l.state).toBe('released');expect(l.history.filter(a=>a.action==='signed').map(a=>a.actorId)).toEqual([employee.userId]);
});
it('refuses invented effective signing receipts even after admitting the legitimate employee action',async()=>{
 let l=act(realLetter(),manager,{type:'complete',stepId:'owner-review'});l=act(l,employee,{type:'open'});data={...data,decision:null,letters:[l]};await seedJourney('offer');
 const original=await persisted();
 const completed=act(l,employee,{type:'complete',stepId:'employee-sign',signature:'Fictional employee',consent:true});
 const forged=structuredClone(completed);forged.document.actions[forged.document.actions.length-1].actorId=manager.userId!;
 await nativeRefusal(withTenant(employee,async tx=>{await begin(tx,employee,{type:'letterAction',documentId:l.id,documentRevision:l.revision,action:'sign',signature:'Fictional employee',consent:true});await save(tx,employee,{...data,letters:[forged]},'retained');}),'42501',/immutable action evidence/);
 const wrongActor=structuredClone(completed);wrongActor.history[wrongActor.history.length-1].actorId=manager.userId!;
 await nativeRefusal(withTenant(employee,async tx=>{await begin(tx,employee,{type:'letterAction',documentId:l.id,documentRevision:l.revision,action:'sign',signature:'Fictional employee',consent:true});await save(tx,employee,{...data,letters:[wrongActor]},'retained');}),'42501',/current verified actor/);expect(await persisted()).toEqual(original);
});
it('closes direct legacy submission after managed activation and accepts only the exact pre-admitted employee seed',async()=>{
 await owner.db.execute(sql`delete from resignation_journey where id=${id}::uuid`);await owner.db.execute(sql`update resignation_request set status='withdrawn' where id=${id}::uuid`);id=randomUUID();
 const workflowId=randomUUID(),definition={id:workflowId,module:'off',name:'Fictional submission decision',description:'',status:'live',required:true,trigger:{event:'submitted',days:0,workdays:false,repeat:false},conditions:[],skipWhen:'caseClosed',steps:[{id:'decision',type:'requestDecision',to:[{kind:'person',userId:manager.userId}],cc:[],conditions:[],params:{choices:'both'}}]};
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${workflowId}::uuid,1,'off','live',true,${JSON.stringify(definition)}::jsonb,'Fictional cutover fixture',${b.adminUserId}::uuid)`);
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${workflowId}::uuid,2,'off','paused',true,${JSON.stringify({...definition,status:'paused'})}::jsonb,'Fictional paused after cutover',${b.adminUserId}::uuid)`);
 await nativeRefusal(withTenant(employee,tx=>tx.execute(sql`insert into resignation_request(id,tenant_id,employment_id,person_id,last_working_day,reason) values(${id}::uuid,${b.tenantId}::uuid,${employmentId}::uuid,${employee.personId}::uuid,${day},'Moving home')`)),'42501',/managed resignation journey/);expect(await persisted()).toBeUndefined();
 data={...data,decision:null};
 await withTenant(employee,async tx=>{await prepareResignationProofTx(tx,employee,{operation:'create',caseId:id,args:{id,data,participants}});await tx.execute(sql`insert into resignation_request(id,tenant_id,employment_id,person_id,last_working_day,reason) values(${id}::uuid,${b.tenantId}::uuid,${employmentId}::uuid,${employee.personId}::uuid,${day},'Moving home')`);await tx.execute(sql`select app.resignation_journey_create(${id}::uuid,${JSON.stringify(data)}::jsonb,${'{'+participants.join(',')+'}'}::uuid[])`);});
 const[stored]=await owner.db.execute<{stage:string}>(sql`select stage from resignation_journey where id=${id}::uuid`);expect(stored.stage).toBe('decision');
});
it('regenerates only an unsigned waiting owner letter from its current published version',async()=>{
 let l=act(realLetter(),manager,{type:'complete',stepId:'owner-review'});const input=letterInput();input.id=l.id;input.template.currentVersion=2;input.template.versions.push({...structuredClone(input.template.versions[0]),version:2,blocks:input.template.versions[0].blocks.map(block=>block.id==='text'?{...block,text:'Updated template wording'}:block)});
 const workflowId=randomUUID(),runId=randomUUID();await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,templates:[input.template],groups:[]})}::jsonb)`);
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${workflowId}::uuid,1,'off','live',true,'{"trigger":{"event":"retention"},"steps":[{"id":"generate","type":"generateDocument"}]}'::jsonb,'Fictional generating workflow',${b.adminUserId}::uuid)`);
 await owner.db.execute(sql`insert into automation_run(tenant_id,id,module,workflow_id,workflow_revision,subject_id,event_key,trigger_event,status,step_cursor,waiting_for) values(${b.tenantId}::uuid,${runId}::uuid,'off',${workflowId}::uuid,1,${id}::uuid,'retention:fixture','retention','waiting',1,${l.id}::uuid)`);
 data={...data,decision:null,letters:[l],waits:[{id:randomUUID(),kind:'letter',runId,documentId:l.id}]};await seedJourney('offer');
 await nativeRefusal(withTenant(employee,tx=>begin(tx,employee,{type:'regenerateLetter',documentId:l.id,documentRevision:l.revision})),'42501');
 await withTenant(manager,async tx=>{await begin(tx,manager,{type:'regenerateLetter',documentId:l.id,documentRevision:l.revision});l=regenerateResignationLetter(l,{documentRevision:l.revision,actor:{userId:manager.userId!,personId:manager.personId!,name:'Fictional assigned manager',at:new Date().toISOString(),today:'2026-11-16'},generation:input}).letter;data={...data,letters:[l]};await save(tx,manager,data,'retention');await save(tx,manager,data,'retention',2);});
 expect(l.templateVersion).toBe(2);expect(l.generatedOn).toBe('2026-11-16');expect(l.document.actions).toEqual([]);
 const[targetProof]=await owner.db.execute<{count:number;keys:string[]}>(sql`select jsonb_array_length(payload->'initialData'->'letters') as count,array(select jsonb_object_keys(payload->'initialData')) as keys from app.resignation_runtime_state where tenant_id=${b.tenantId}::uuid and actor=${manager.userId} and kind=${'intent:'+id}`);expect(targetProof).toEqual({count:1,keys:['letters']});
 l=act(l,manager,{type:'complete',stepId:'owner-review'});l=act(l,employee,{type:'open'});l=act(l,employee,{type:'complete',stepId:'employee-sign',signature:'Fictional employee',consent:true});data={...data,letters:[l]};await seedJourney('retained');
 await nativeRefusal(withTenant(manager,tx=>begin(tx,manager,{type:'regenerateLetter',documentId:l.id,documentRevision:l.revision},3)),'42501');
});
it('enforces request/employment/company and clearance reference invariants',async()=>{
 const original=await persisted();const other=randomUUID();await owner.db.execute(sql`insert into company(id,tenant_id,legal_name) values(${other}::uuid,${b.tenantId}::uuid,'Fictional other company')`);
 await nativeRefusal(owner.db.execute(sql`update resignation_journey set company_id=${other}::uuid where id=${id}::uuid`),'23503');
 await nativeRefusal(owner.db.execute(sql`update resignation_journey set offboarding_case_id=${randomUUID()}::uuid where id=${id}::uuid`),'23503');
 await nativeRefusal(withTenant(employee,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select txid_current()::text id`);const p=signResignationRuntime({operation:'read',caseId:id,args:{mode:'case',caseId:id}},{tenantId:randomUUID(),userId:employee.userId!,personId:employee.personId!,transactionId:row.id},master);await tx.execute(sql`select app.resignation_journey_admit(${p.payload},${p.signature})`);}),'42501');expect(await persisted()).toEqual(original);
});

it('classifies only reverse-linked managed clearance for native operators and real owner workers',async()=>{
 const clearance=randomUUID(),impostor=randomUUID(),legacy=randomUUID();
 const clearanceData=(caseId:string,managed:boolean)=>({version:9,id:caseId,module:'off',state:caseId===clearance?'pending':'closed',facts:{company:b.companyId,employmentId},...(managed?{resignationSourceCaseId:id}:{})});
 for(const[caseId,managed]of[[clearance,true],[impostor,true],[legacy,false]] as const)await owner.db.execute(sql`insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,'off',${'OFB9-'+caseId},${JSON.stringify(clearanceData(caseId,managed))}::jsonb)`);
 await owner.db.execute(sql`update resignation_journey set offboarding_case_id=${clearance}::uuid where id=${id}::uuid`);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:1,groups:[],access:{onboarding:[],offboarding:[b.adminUserId]}})}::jsonb) on conflict(tenant_id) do update set data=excluded.data`);
 const classified=(tx:Tx,caseId=clearance)=>tx.execute<{managed:boolean}>(sql`select app.resignation_offboarding_case_managed(${caseId}::uuid) managed`);
 expect((await withTenant(adminCtx(b),tx=>classified(tx)))[0].managed).toBe(true);
 for(const caseId of[impostor,legacy,randomUUID()])expect((await withTenant(adminCtx(b),tx=>classified(tx,caseId)))[0].managed).toBe(false);
 expect((await withTenant(employee,tx=>classified(tx)))[0].managed).toBe(false);
 expect((await withTenant(employee,async tx=>{await tx.execute(sql`select set_config('app.user_id','',true),set_config('app.resignation_handoff',${id},true)`);return classified(tx);}))[0].managed).toBe(false);
 const worker:SessionContext={tenantId:b.tenantId,roles:[]};
 expect((await owner.withTenant(worker,tx=>classified(tx)))[0].managed).toBe(true);
 expect((await owner.withTenant(worker,async tx=>{await tx.execute(sql`set local role ai_hr_app`);return classified(tx);}))[0].managed).toBe(false);
 await owner.db.execute(sql`delete from app.resignation_runtime_verifier`);
 expect((await withTenant(adminCtx(b),tx=>classified(tx,legacy)))[0].managed).toBe(false);
});

it('allows a configured account-only HR decider while rejecting employee self-decision',async()=>{
 const userId=await createAppUser(b.tenantId,null,'employee'),account:SessionContext={tenantId:b.tenantId,userId,roles:['employee']};participants.push(userId);data={...data,decision:{id:randomUUID(),to:[userId,employee.userId],watch:[],choices:'both',canComment:false}};await seedJourney();
 await owner.db.execute(sql`update resignation_journey set participant_ids=${'{'+participants.join(',')+'}'}::uuid[] where id=${id}::uuid`);
 await nativeRefusal(withTenant(employee,tx=>begin(tx,employee,{type:'accept',lastWorkingDay:day,replacementNeeded:false})),'42501',/not currently assigned/);
 await withTenant(account,async tx=>{await begin(tx,account,{type:'accept',lastWorkingDay:day,replacementNeeded:false});await prepareResignationProofTx(tx,account,{operation:'context',caseId:id,args:{employmentId,caseId:id}});const[context]=await tx.execute<{data:{users:{id:string;personId:string|null;name:string}[]}}>(sql`select app.resignation_journey_context(${employmentId}::uuid,${id}::uuid) data`);expect(context.data.users.find(u=>u.id===userId)).toEqual({id:userId,personId:null,name:'Assigned account'});await save(tx,account,{...data,decision:null,replacementNeeded:false,decidedBy:{id:userId,name:'Assigned account'}},'accepted');});
 expect(await persisted()).toMatchObject({stage:'accepted',revision:2,data:{decidedBy:{id:userId}}});
});
