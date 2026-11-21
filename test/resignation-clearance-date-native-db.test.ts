/** Team-native authorization: real generated documents, actual principals, immutable pinned routes. */
import * as M from '../lib/lifecycle-v9-model';
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


let clearanceId:string,letter:ResignationLetter,clearance:M.Case;
const correctedDay='2027-07-10';
beforeEach(async()=>{
 const input=letterInput(),routing=input.template.versions[0]!.routing!;routing.find(s=>s.id==='team-sign')!.order=1;routing.find(s=>s.id==='owner-review')!.order=2;
 letter=act(generateResignationLetter(input).letter,fyi,{type:'complete',stepId:'team-sign',signature:'Prior effective signature',consent:true});
 data={...data,decision:null,letters:[letter]};await seedJourney('accepted');clearanceId=randomUUID();
 clearance={version:9,id:clearanceId,module:'off',revision:1,state:'submitted',resignationSourceCaseId:id,facts:{company:b.companyId,employmentId,personId:employee.personId,noticeDate:'2027-06-01',lastDay:day},revokeMode:'lastday',revokeDate:day,returnAnchor:day,review:{ready:true},finalFigures:{salary:'private'},log:[],tasks:[{id:'open',status:'todo',due:-2,opens:-4,dueOn:'2027-06-28',opensOn:'2027-06-26',assignee:manager.userId,group:'unchanged'},{id:'done',status:'done',due:0,opens:null,dueOn:day,opensOn:null,assignee:fyi.userId}],items:[{id:'relative',status:'todo',dueDay:-1,method:'manual',dueOn:'2027-06-29',assignee:fyi.userId,group:'unchanged'},{id:'absolute',status:'todo',dueDay:null,method:'rr',dueOn:'2027-07-05',assignee:manager.userId},{id:'legacy',status:'todo',dueOn:day},{id:'resolved',status:'done',dueDay:-1,dueOn:'2027-06-29'},{id:'not-returned',status:'notReturned',dueDay:-1,dueOn:'2027-06-29'}]} as unknown as M.Case;
 await owner.db.execute(sql`insert into lc_v9_case(id,tenant_id,company_id,employment_id,module,number,data) values(${clearanceId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,'off','OFF-CORRECTION',${JSON.stringify(clearance)}::jsonb)`);
 await owner.db.execute(sql`update resignation_journey set offboarding_case_id=${clearanceId}::uuid where id=${id}::uuid`);
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,'{"version":9,"groups":[],"templates":[],"emails":[]}'::jsonb)`);
});
async function admittedCorrection(tx:Tx,ctx:SessionContext){
 await begin(tx,ctx,{type:'updateLetter',documentId:letter.id,documentRevision:letter.revision,lastWorkingDay:correctedDay});
 const changed=reconcileResignationLetter(letter,{...letter.mergeValues,'resignation.lastDay':correctedDay}).letter;
 const next={...data,lastWorkingDay:correctedDay,letters:[changed]},args={id,revision:1,action:'runner',stage:'accepted',data:next,participants,offboarding:clearanceId};
 await prepareResignationProofTx(tx,ctx,{operation:'save',caseId:id,args});await tx.execute(sql`select app.resignation_journey_save(${id}::uuid,1,'runner','accepted',${JSON.stringify(next)}::jsonb,${'{'+participants.join(',')+'}'}::uuid[],${clearanceId}::uuid)`);
}
async function dateIntent(tx:Tx,ctx:SessionContext){
 await prepareResignationProofTx(tx,ctx,{operation:'context',caseId:id,args:{mode:'offboardingDateCorrection',journeyId:id,oldLastDay:day,newLastDay:correctedDay}});
 const[row]=await tx.execute<{intent:{row?:{data:M.Case};blocked?:string;employmentDateSource?:Record<string,unknown>}}>(sql`select app.resignation_offboarding_date_intent(${id}::uuid,${day}::date,${correctedDay}::date) intent`);return row.intent;
}
function projected(actor:SessionContext):M.Case{const next=structuredClone(clearance);M.synchronizeResignationLastDay(next,day,correctedDay,correctedDay,{actor:{id:actor.userId!,name:'Fictional FYI partner'},now:new Date().toISOString(),nextId:randomUUID});next.revision=2;return next;}
async function dateStore(tx:Tx,ctx:SessionContext,next:M.Case,revision=1){
 await prepareResignationProofTx(tx,ctx,{operation:'context',caseId:id,args:{mode:'offboardingDateCorrectionSave',journeyId:id,revision,oldLastDay:day,newLastDay:correctedDay,data:JSON.parse(JSON.stringify(next))}});
 await tx.execute(sql`select app.resignation_offboarding_date_store(${id}::uuid,${revision},${day}::date,${correctedDay}::date,${JSON.stringify(next)}::jsonb)`);
}
async function nativeCase(){const[row]=await owner.db.execute<{revision:number;data:M.Case}>(sql`select revision,data from lc_v9_case where id=${clearanceId}::uuid`);return row;}
it('synchronizes only permitted open dates with actual prior signature invalidation and original revision history',async()=>{
 expect(letter.document.actions.some(a=>a.action==='signed')).toBe(true);
 expect(await withTenant(fyi,tx=>tx.execute(sql`select id from lc_v9_case where id=${clearanceId}::uuid`))).toHaveLength(0);
 await withTenant(fyi,async tx=>{await admittedCorrection(tx,fyi);const intent=await dateIntent(tx,fyi);expect(intent.row?.data.finalFigures).toBeNull();expect(intent.row?.data.review).toBeNull();expect(Object.keys(intent.employmentDateSource!)).not.toContain('basicSalary');await dateStore(tx,fyi,projected(fyi));});
 const updated=await nativeCase();expect(updated.revision).toBe(2);expect(updated.data.facts.lastDay).toBe(correctedDay);expect(updated.data.tasks[0]).toMatchObject({dueOn:'2027-07-08',opensOn:'2027-07-06',assignee:manager.userId,group:'unchanged'});expect(updated.data.tasks[1]).toEqual(clearance.tasks[1]);expect(updated.data.items.map(i=>i.dueOn)).toEqual(['2027-07-09','2027-07-05',correctedDay,'2027-06-29','2027-06-29']);
 const[revision]=await owner.db.execute<{data:M.Case;actor:string}>(sql`select data,actor_user_id::text actor from lc_v9_case_revision where case_id=${clearanceId}::uuid and revision=1`);expect(revision.data).toEqual(clearance);expect(revision.actor).toBe(fyi.userId);
});
it('denies naked proofless/nonowner calls and current-context proofs without the admitted source command',async()=>{
 const original=await nativeCase();await nativeRefusal(withTenant(employee,tx=>begin(tx,employee,{type:'updateLetter',documentId:letter.id,documentRevision:letter.revision,lastWorkingDay:correctedDay})),'42501');for(const actor of[employee,fyi]){await nativeRefusal(withTenant(actor,tx=>tx.execute(sql`select app.resignation_offboarding_date_intent(${id}::uuid,${day}::date,${correctedDay}::date)`)),'42501');await nativeRefusal(withTenant(actor,tx=>dateIntent(tx,actor)),'42501');}expect(await nativeCase()).toEqual(original);
});
it('rejects immutable facts, assignments, resolved rows, wrong relative dates and false log actors atomically',async()=>{
 const original=await nativeCase(),journey=await persisted();
 const mutations=[(c:M.Case)=>{c.facts.company=randomUUID();},(c:M.Case)=>{c.facts.personId=fyi.personId!;},(c:M.Case)=>{c.tasks[0]!.assignee=employee.userId!;},(c:M.Case)=>{c.tasks[1]!.dueOn=correctedDay;},(c:M.Case)=>{c.items[0]!.dueOn=correctedDay;},(c:M.Case)=>{c.log.at(-1)!.actor.id=manager.userId!;}];
 for(const mutate of mutations){await nativeRefusal(withTenant(fyi,async tx=>{await admittedCorrection(tx,fyi);await dateIntent(tx,fyi);const next=projected(fyi);mutate(next);await dateStore(tx,fyi,next);}),'42501');expect(await nativeCase()).toEqual(original);expect(await persisted()).toEqual(journey);}
});
it('returns closed only to the verified owner and rolls back the already-saved source correction',async()=>{
 await owner.db.execute(sql`update lc_v9_case set data=jsonb_set(data,'{state}','"cleared"'::jsonb) where id=${clearanceId}::uuid`);const before=await persisted();
 await expect(withTenant(fyi,async tx=>{await admittedCorrection(tx,fyi);expect(await dateIntent(tx,fyi)).toEqual({blocked:'closed'});throw new Error('Caller rolls back closed correction');})).rejects.toThrow('Caller rolls back');expect(await persisted()).toEqual(before);expect((await nativeCase()).data.facts.lastDay).toBe(day);
});
it('enforces clearance CAS and purpose transaction/principal binding',async()=>{
 const original=await nativeCase();await nativeRefusal(withTenant(fyi,async tx=>{await admittedCorrection(tx,fyi);await dateIntent(tx,fyi);await dateStore(tx,fyi,projected(fyi),2);}),'40001');expect(await nativeCase()).toEqual(original);
 let proof:{payload:string;signature:string}|undefined;await withTenant(fyi,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select txid_current()::text id`);proof=signResignationRuntime({operation:'context',caseId:id,args:{mode:'offboardingDateCorrection',journeyId:id,oldLastDay:day,newLastDay:correctedDay}},{tenantId:b.tenantId,userId:fyi.userId!,personId:fyi.personId!,transactionId:row.id},master);});
 for(const actor of[fyi,manager])await nativeRefusal(withTenant(actor,tx=>tx.execute(sql`select app.resignation_journey_admit(${proof!.payload},${proof!.signature})`)),'42501');expect(await nativeCase()).toEqual(original);
});

it('refuses a broken reverse source link without committing either date',async()=>{
 await owner.db.execute(sql`update lc_v9_case set data=jsonb_set(data,'{resignationSourceCaseId}',${JSON.stringify(randomUUID())}::jsonb) where id=${clearanceId}::uuid`);const oldCase=await nativeCase(),oldJourney=await persisted();
 await nativeRefusal(withTenant(fyi,async tx=>{await admittedCorrection(tx,fyi);await dateIntent(tx,fyi);}),'42501');expect(await nativeCase()).toEqual(oldCase);expect(await persisted()).toEqual(oldJourney);
});
