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


function formLetter():ResignationLetter{
 const input=letterInput(),version=input.template.versions[0]!;
 input.values['employee.salary']='6400';version.fields=[{id:'hr-note',label:'HR note',type:'text',owner:'hr',pmKey:null,required:true,sensitive:false,options:[],section:'local',when:null},{id:'hr-detail',label:'HR detail',type:'text',owner:'hr',pmKey:null,required:false,sensitive:false,options:[],section:'local',when:{field:'hr-note',value:'Show'}},{id:'employee-note',label:'Employee note',type:'text',owner:'employee',pmKey:null,required:false,sensitive:false,options:[],section:'local',when:null},{id:'hr-source-check',label:'Check sourced salary',type:'text',owner:'hr',pmKey:null,required:false,sensitive:false,options:[],section:'local',when:{field:'salary',value:'6400'}},{id:'salary',label:'Salary',type:'number',owner:'pmLocked',pmKey:'employee.salary',required:false,sensitive:true,options:[],section:'local',when:null}];
 version.blocks.push({id:'local-fields',type:'fields',section:'local',text:''});return generateResignationLetter(input).letter;
}
it('admits assigned HR local fields and atomically enabled conditional values, preserving Personnel sources',async()=>{
 const letter=formLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');
 const values={'hr-note':'Show','hr-detail':'A verified local detail','hr-source-check':'Checked mapped source'};
 await withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values});const changed=act(letter,fyi,{type:'fields',values});await save(tx,fyi,{...data,letters:[changed]},'offer');});
 expect(await persisted()).toMatchObject({revision:2,data:{letters:[{fieldValues:values,mergeValues:values}]}});
});
it('preserves earlier local edits and evaluates a later conditional edit against the old parent value',async()=>{
 let letter=formLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');
 await withTenant(fyi,async tx=>{const values={'hr-note':'Show'};await begin(tx,fyi,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values});letter=act(letter,fyi,{type:'fields',values});data={...data,letters:[letter]};await save(tx,fyi,data,'offer');});
 await withTenant(fyi,async tx=>{const values={'hr-detail':'Second edit retains the first'};await begin(tx,fyi,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values},2);letter=act(letter,fyi,{type:'fields',values});data={...data,letters:[letter]};await save(tx,fyi,data,'offer',2);});
 expect(await persisted()).toMatchObject({revision:3,data:{letters:[{fieldValues:{'hr-note':'Show','hr-detail':'Second edit retains the first'}}]}});
});
it('denies unknown, mapped, wrong-owner, hidden and future-recipient form writes',async()=>{
 const letter=formLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');const original=await persisted();
 for(const values of[{unknown:'injected'},{salary:'999999'},{'employee-note':'wrong owner'},{'hr-detail':'still hidden'}]){await nativeRefusal(withTenant(fyi,tx=>begin(tx,fyi,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values})),'42501');expect(await persisted()).toEqual(original);}
 await nativeRefusal(withTenant(employee,tx=>begin(tx,employee,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values:{'employee-note':'too early'}})),'42501');expect(await persisted()).toEqual(original);
});
it('refuses field-definition, wrong-value and Personnel-source rewrites under a valid field command',async()=>{
 const letter=formLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');const original=await persisted(),values={'hr-note':'Show'};
 const valid=act(letter,fyi,{type:'fields',values});
 const mutations=[(l:ResignationLetter)=>{l.fields[0]!.owner='employee';},(l:ResignationLetter)=>{l.fieldValues!['hr-note']='different';},(l:ResignationLetter)=>{l.mergeValues['employee.salary']='999999';}];
 for(const mutate of mutations){const changed=structuredClone(valid);mutate(changed);await nativeRefusal(withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values});await save(tx,fyi,{...data,letters:[changed]},'offer');}),'42501');expect(await persisted()).toEqual(original);}
});
it('cannot turn a local field edit into a case decision or completed signature',async()=>{
 const letter=formLetter();data={...data,decision:null,letters:[letter]};await seedJourney('offer');const original=await persisted(),values={'hr-note':'Show'},changed=act(letter,fyi,{type:'fields',values});
 for(const stage of['retained','leaving','accepted','decision','retention']){await nativeRefusal(withTenant(fyi,async tx=>{await begin(tx,fyi,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values});await save(tx,fyi,{...data,letters:[changed]},stage);}),'42501',/cannot complete/);expect(await persisted()).toEqual(original);}
});
it('uses the pinned Start Offboarding reason and denies arbitrary reason, step or run overrides',async()=>{
 const workflowId=randomUUID(),runId=randomUUID(),definition={trigger:{event:'accepted'},steps:[{id:'start-exit',type:'startOffboarding',params:{exitReason:'Contract end'}}]};
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${workflowId}::uuid,1,'off','live',true,${JSON.stringify(definition)}::jsonb,'Pinned exit reason',${b.adminUserId}::uuid),(${b.tenantId}::uuid,${workflowId}::uuid,2,'off','live',true,${JSON.stringify({trigger:definition.trigger,steps:[{id:'start-exit',type:'startOffboarding',params:{exitReason:'Termination'}}]})}::jsonb,'Later draft must not replace pinned reason',${b.adminUserId}::uuid)`);
 await owner.db.execute(sql`insert into automation_run(tenant_id,id,module,workflow_id,workflow_revision,subject_id,event_key,trigger_event,status) values(${b.tenantId}::uuid,${runId}::uuid,'off',${workflowId}::uuid,1,${id}::uuid,'exit-reason-fixture','accepted','running')`);
 const admitted={type:'accept',lastWorkingDay:day,replacementNeeded:false},baseNext={...data,decision:null,replacementNeeded:false},start={runId,stepId:'start-exit',exitReason:'Contract end'},original=await persisted();
 for(const invalid of[{...start,exitReason:'Termination'},{...start,stepId:'another-step'},{...start,runId:randomUUID()}]){await nativeRefusal(withTenant(manager,async tx=>{await begin(tx,manager,admitted);await save(tx,manager,{...baseNext,offboardingStart:invalid},'accepted');}),'42501',/pinned workflow step/);expect(await persisted()).toEqual(original);}
 await withTenant(manager,async tx=>{await begin(tx,manager,admitted);await save(tx,manager,{...baseNext,offboardingStart:start},'accepted');const[projection]=await tx.execute<{intent:{type:string;employmentId:string}}>(sql`select app.resignation_offboarding_intent(${id}::uuid) intent`);expect(projection.intent).toMatchObject({type:'Contract end',employmentId});});
});
it('allows offer to return to retention when employee local edits invalidate a prior signature',async()=>{
 let letter=formLetter();letter=act(letter,fyi,{type:'fields',values:{'hr-note':'Show'}});letter=act(letter,manager,{type:'complete',stepId:'owner-review'});letter=act(letter,fyi,{type:'complete',stepId:'team-sign',signature:'Prior verified signature',consent:true});letter=act(letter,employee,{type:'open'});
 data={...data,decision:null,letters:[letter]};await seedJourney('offer');const values={'employee-note':'New employee detail'},changed=act(letter,employee,{type:'fields',values});
 expect(changed.revision).toBeGreaterThan(letter.revision);expect(changed.document.actions.some(a=>a.action==='signed')).toBe(false);
 await withTenant(employee,async tx=>{await begin(tx,employee,{type:'saveLetterFields',documentId:letter.id,documentRevision:letter.revision,values});await save(tx,employee,{...data,letters:[changed]},'retention');});
 expect(await persisted()).toMatchObject({revision:2,stage:'retention'});
});
