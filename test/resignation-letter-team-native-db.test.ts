/** Team-native authorization: real generated documents, actual principals, immutable pinned routes. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {prepareResignationProofTx} from '../core/resignation-proof';
import {resignationRuntimeKey,signResignationRuntime} from '../lib/resignation-runtime-proof';
import {actResignationLetter,generateResignationLetter,regenerateResignationLetter,reconcileResignationLetter,resignationLetterCapabilities,type ResignationLetter,type ResignationLetterAction,type GenerateResignationLetterInput} from '../core/resignation-letter';
let b:Base,employee:SessionContext,manager:SessionContext,fyi:SessionContext,id:string,employmentId:string,data:Record<string,unknown>,participants:string[];
const master='6'.repeat(64),day='2027-06-30';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','disabled');
 vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://resignation.example.test');vi.stubEnv('AUTH_SESSION_KEY',master);
 await owner.db.execute(sql`delete from app.resignation_runtime_state`);await owner.db.execute(sql`delete from app.resignation_runtime_verifier`);
 await owner.db.execute(sql`insert into app.resignation_runtime_verifier(singleton,secret) values(true,${resignationRuntimeKey(master)})`);
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional resigning employee',primaryEmail:randomUUID()+'@resignation.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});employmentId=hired.employmentId;
 employee={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee']};
 const person=async(name:string)=>{const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@resignation.test'}) returning id`);return{tenantId:b.tenantId,userId:await createAppUser(b.tenantId,p.id,'employee'),personId:p.id,roles:['employee']} as SessionContext;};
 manager=await person('Fictional assigned manager');fyi=await person('Fictional FYI partner');participants=[employee.userId!,manager.userId!,fyi.userId!];id=randomUUID();
 await owner.db.execute(sql`insert into resignation_request(id,tenant_id,employment_id,person_id,last_working_day,reason) values(${id}::uuid,${b.tenantId}::uuid,${employmentId}::uuid,${employee.personId}::uuid,${day},'Moving home')`);
 await setModule(b.tenantId,'lifecycle','active');
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
function letterInput():GenerateResignationLetterInput{
 return {id:randomUUID(),kind:'retention',tenantId:b.tenantId,companyId:b.companyId,subjectId:id,employeeUserId:employee.userId!,caseOwnerId:manager.userId!,personIds:{[employee.userId!]:employee.personId!,[manager.userId!]:manager.personId!,[fyi.userId!]:fyi.personId!},generatedOn:'2026-11-16',generatedAt:'2026-11-16T04:00:00Z',facts:{caseType:'Resignation'},values:{'employee.name':'Fictional employee','resignation.lastDay':day},template:{id:'tpl-off',name:'Fictional retention',module:'off',type:'Letter',rules:{},retired:false,currentVersion:1,hrStep:'before',employeeAck:true,versions:[{version:1,state:'published',at:'2026-11-16T04:00:00Z',by:manager.userId!,fields:[],blocks:[{id:'text',type:'text',section:'',text:'Last working day {resignation.lastDay}'},{id:'team-signature',type:'signature',section:'',text:'',role:'step:team-sign'},{id:'signature',type:'signature',section:'',text:'',role:'step:employee-sign'}],routing:[{id:'owner-review',order:1,action:'review',who:{kind:'people',userIds:[manager.userId!,fyi.userId!]},owner:true},{id:'team-sign',order:2,action:'sign',who:{kind:'people',userIds:[manager.userId!,fyi.userId!]},owner:false},{id:'employee-sign',order:3,action:'sign',who:{kind:'employee'},owner:false}]}]},context:{employeeUserId:employee.userId!,directSuperiorUserId:manager.userId!,facts:{},routing:()=>null,groupMembers:()=>null,choose:ids=>ids[0]??null,fallback:null,describe:()=> 'Fictional holder'}};
}
function realLetter():ResignationLetter{return generateResignationLetter(letterInput()).letter;}
function act(letter:ResignationLetter,ctx:SessionContext,action:ResignationLetterAction){return actResignationLetter(letter,{id:randomUUID(),documentRevision:letter.revision,actor:{userId:ctx.userId!,personId:ctx.personId!,name:'Fictional verified actor',at:new Date().toISOString(),today:'2026-11-16'},action}).letter;}

it('allows any frozen current team member to review and sign while retaining the chosen route',async()=>{
 let letter=realLetter();const route=structuredClone(letter.document.route);
 data={...data,decision:null,letters:[letter]};await seedJourney('offer');
 await withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'});letter=act(letter,fyi,{type:'complete',stepId:'owner-review'});data={...data,letters:[letter]};await save(tx,fyi,data,'offer');});
 expect(letter.history.at(-1)).toMatchObject({actorId:fyi.userId,actorPersonId:fyi.personId,stepId:'owner-review',action:'reviewed'});
 await withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Verified teammate',consent:true},2);letter=act(letter,fyi,{type:'complete',stepId:'team-sign',signature:'Verified teammate',consent:true});data={...data,letters:[letter]};await save(tx,fyi,data,'offer',2);});
 expect(letter.history.at(-1)).toMatchObject({actorId:fyi.userId,actorPersonId:fyi.personId,stepId:'team-sign',action:'signed'});
 expect(letter.document.route).toEqual(route);expect(await persisted()).toMatchObject({revision:3});
});
it('denies a future member, a nonmember and stale or cross-principal signing admission',async()=>{
 const letter=realLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');const original=await persisted();
 await nativeRefusal(withTenant(employee,tx=>begin(tx,employee,{type:'openLetter',documentId:letter.id,documentRevision:letter.revision})),'42501');
 await nativeRefusal(withTenant(employee,tx=>begin(tx,employee,{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'})),'42501');
 await nativeRefusal(withTenant(fyi,tx=>begin(tx,fyi,{type:'letterAction',documentId:letter.id,documentRevision:letter.revision+1,action:'review'})),'42501');
 let replay:{payload:string;signature:string}|undefined;
 await withTenant(fyi,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select txid_current()::text id`);replay=signResignationRuntime({operation:'begin',caseId:id,revision:1,command:{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'},args:{}},{tenantId:b.tenantId,userId:fyi.userId!,personId:fyi.personId!,transactionId:row.id},master);});
 for(const actor of[fyi,manager])await nativeRefusal(withTenant(actor,tx=>tx.execute(sql`select app.resignation_journey_admit(${replay!.payload},${replay!.signature})`)),'42501');
 expect(await persisted()).toEqual(original);
});
it('rejects frozen team, Person and pinned route rewrites even with a valid derived save proof',async()=>{
 const letter=realLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');const original=await persisted();
 const mutations=[(l:ResignationLetter)=>{l.teamSteps!['owner-review'].memberIds.push(employee.userId!);},(l:ResignationLetter)=>{l.teamSteps!['owner-review'].personIds[fyi.userId!]=employee.personId!;},(l:ResignationLetter)=>{l.document.route.steps[0]!.holderId=fyi.userId!;}];
 for(const mutate of mutations){const changed=structuredClone(letter);mutate(changed);await nativeRefusal(withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'openLetter',documentId:letter.id,documentRevision:letter.revision});await save(tx,fyi,{...data,letters:[changed]},'offer');}),'42501');expect(await persisted()).toEqual(original);}
});
it('sets first-on-it on Open, preserves it on another Open and still lets the teammate act',async()=>{
 let letter=realLetter();const taskId=letter.id+':owner-review';data={...data,decision:null,letters:[letter],tasks:[{id:taskId,userIds:[manager.userId,fyi.userId],team:true}],progress:{}};await seedJourney('offer');
 const progress={[taskId]:{status:'progress',onIt:{id:manager.userId,name:'First teammate'}}};
 await withTenant(manager,async tx=>{await begin(tx,manager,{type:'openLetter',documentId:letter.id,documentRevision:letter.revision});letter=act(letter,manager,{type:'open'});data={...data,letters:[letter],progress};await save(tx,manager,data,'offer');});
 await withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'openLetter',documentId:letter.id,documentRevision:letter.revision},2);letter=act(letter,fyi,{type:'open'});data={...data,letters:[letter]};await save(tx,fyi,data,'offer',2);});
 const original=await persisted();expect(original?.data.progress).toEqual(progress);
 await nativeRefusal(withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'taskProgress',taskId,status:'progress'},3);await save(tx,fyi,{...data,progress:{[taskId]:{status:'progress',onIt:{id:fyi.userId,name:'Replacement'}}}},'offer',3);}),'42501');expect(await persisted()).toEqual(original);
 await withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'review'},3);const reviewed=act(letter,fyi,{type:'complete',stepId:'owner-review'});await save(tx,fyi,{...data,letters:[reviewed]},'offer',3);});
 expect((await persisted())?.data.progress).toEqual(progress);
});
it('rejects relinked member identities and invented signature actors without changing stored evidence',async()=>{
 let letter=act(realLetter(),manager,{type:'complete',stepId:'owner-review'});data={...data,decision:null,letters:[letter],tasks:[{id:letter.id+':team-sign',userIds:[manager.userId,fyi.userId],team:true}]};await seedJourney('offer');const original=await persisted();
 const completed=act(letter,fyi,{type:'complete',stepId:'team-sign',signature:'Verified teammate',consent:true});const forged=structuredClone(completed);forged.history.at(-1)!.actorPersonId=employee.personId!;
 await nativeRefusal(withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Verified teammate',consent:true});await save(tx,fyi,{...data,letters:[forged]},'offer');}),'42501');expect(await persisted()).toEqual(original);
 await owner.db.execute(sql`update app_user set person_id=${employee.personId}::uuid where id=${fyi.userId}::uuid`);
 const relinked={...fyi,personId:employee.personId};await nativeRefusal(withTenant(relinked,tx=>begin(tx,relinked,{type:'letterAction',documentId:letter.id,documentRevision:letter.revision,action:'sign',signature:'Verified teammate',consent:true})),'42501');await nativeRefusal(withTenant(relinked,tx=>begin(tx,relinked,{type:'taskProgress',taskId:letter.id+':team-sign',status:'progress'})),'42501');expect(await persisted()).toEqual(original);
});
it('permits a teammate to open released evidence but refuses to rewrite its frozen content',async()=>{
 let letter=act(realLetter(),manager,{type:'complete',stepId:'owner-review'});letter=act(letter,fyi,{type:'complete',stepId:'team-sign',signature:'Verified teammate',consent:true});letter=act(letter,employee,{type:'open'});letter=act(letter,employee,{type:'complete',stepId:'employee-sign',signature:'Verified employee',consent:true});expect(letter.state).toBe('released');data={...data,decision:null,letters:[letter]};await seedJourney('retained');const original=await persisted();
 const changed=act(letter,fyi,{type:'open'});changed.mergeValues['resignation.lastDay']='2099-01-01';
 await nativeRefusal(withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'openLetter',documentId:letter.id,documentRevision:letter.revision});await save(tx,fyi,{...data,letters:[changed]},'retained');}),'42501',/Released letter evidence/);expect(await persisted()).toEqual(original);
 await withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'openLetter',documentId:letter.id,documentRevision:letter.revision});await save(tx,fyi,{...data,letters:[act(letter,fyi,{type:'open'})]},'retained');});expect(await persisted()).toMatchObject({revision:2});
});

it('rejects Review or Approve evidence forged during an Open, including future owner steps',async()=>{
 const letter=realLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');const original=await persisted();
 const reviewed=act(letter,fyi,{type:'complete',stepId:'owner-review'});
 for(const action of['reviewed','approved'] as const){for(const stepId of['owner-review','team-sign']){const forged=structuredClone(reviewed);forged.history.at(-1)!.action=action;forged.history.at(-1)!.stepId=stepId;forged.document.actions.at(-1)!.action=action;forged.document.actions.at(-1)!.stepId=stepId;await nativeRefusal(withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'openLetter',documentId:letter.id,documentRevision:letter.revision});await save(tx,fyi,{...data,letters:[forged]},'offer');}),'42501',/Review and approval evidence/);expect(await persisted()).toEqual(original);}}
});
