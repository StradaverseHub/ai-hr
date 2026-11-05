/** ADR-0170 step 4 — the explainers and the setup co-pilot over their REAL native owners on fictional data.
 *
 * Each explainer returns its owner's own explanation for the caller's own record only: the released payslip's
 * stored statutory working (an unreleased run and a colleague's payslip stay invisible), the leave summary's
 * entitlement breakdown, and the day's stored attendance trace worded as the screen words it. Through the
 * harness, every returned field is declared (nothing removed as undeclared), pay figures leave only as
 * placeholders and come back exact for the person, and a turn about another person offers none of them.
 * The co-pilot answers administrators only, with counts and pages and no person. Fictional data only. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createBatch,generatePayslips} from '../core/payroll';
import {assignDefaultShift,createShift} from '../core/roster';
import {checkIn,checkOut} from '../core/attendance';
import {explainStatutory} from '../core/statutory-explain';
import {leaveEntitlementBreakdown} from '../core/read';
import {explainOwnPayslipStatutory} from '../core/explainers/statutory';
import {explainOwnLeaveEntitlement} from '../core/explainers/entitlement';
import {explainOwnAttendanceDay} from '../core/explainers/attendance';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {FOLDED_READS} from '../core/semantic-model/topic-tools';
import {nativeToolProvider} from '../core/harness/tools';
import {gateTurn} from '../lib/product-context/request-gate';
import {offerFor} from '../core/harness/runner';
import {HARNESS_SPEC} from '../core/harness/spec';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {setupCopilot,SetupCopilotRefused} from '../core/setup-copilot/copilot';
import {coverageReadiness} from '../core/product-context/coverage-readiness';
import {SETUP_STAGES} from '../core/semantic-model/entities-setup';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

const WORKDAY='2026-07-01';// a Wednesday, clocked in 20 minutes late against a 09:00 start
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-explainer-passphrase');await resetDb();base=await seedBase();
 for(const code of ['assistant','payroll','attendance','claims'])await setModule(base.tenantId,code,'active');});

async function people(){
 const admin=adminCtx(base),uniq=randomUUID().slice(0,6);
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});
 const hire=(fullName:string)=>hireEmployee(admin,{person:{fullName,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const mine=await hire('Fictional Explainer Employee'),colleague=await hire('Fictional Explainer Colleague');
 for(const [row,salary,ic] of [[mine,5000,'900101012345'],[colleague,7300,'910202023456']] as const){
  await setCompensation(admin,{employmentId:row.employmentId,basicSalary:salary,effectiveFrom:'2024-01-01'});await setStatutoryProfileMY(admin,{personId:row.personId,icNumber:ic});}
 // One released run and one left open: the open one must never be explained.
 const released=await createBatch(admin,{companyId:base.companyId,payPeriod:'2026-08'});await generatePayslips(admin,{batchId:released.batchId});await closeBatch(admin,{batchId:released.batchId});
 const open=await createBatch(admin,{companyId:base.companyId,payPeriod:'2026-09'});await generatePayslips(admin,{batchId:open.batchId});
 const shift=await createShift(admin,{name:'Fictional Day '+uniq,code:'FXD'+uniq,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]});
 await assignDefaultShift(admin,{employmentId:mine.employmentId,shiftId:shift.id});
 await checkIn(admin,{employmentId:mine.employmentId,date:WORKDAY,time:'09:20'});await checkOut(admin,{employmentId:mine.employmentId,date:WORKDAY,time:'18:30'});
 const employeeUser=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:employeeUser});
 const employee:SessionContext={...await entitledCtx(base,['employee']),userId:employeeUser,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const person=await hire('Fictional Explainer Admin');
 const adminUser=await createAppUser(base.tenantId,person.personId,'hr_admin');await grantAssistant(admin,{appUserId:adminUser});
 const hr:SessionContext={...await entitledCtx(base,['hr_admin']),userId:adminUser,personId:person.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 // The explainers worker is off by default; the group administrator switches it on so the turns below are offered it.
 await setWorkerSwitch(hr,{workerId:'explainers',enabled:true});
 return{employee,hr,mine,colleague,releasedBatch:released.batchId};
}
const turn=(ctx:SessionContext,question:string,script:readonly ScriptStep[])=>{const model=scriptedModel(script);
 return runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()}).then(result=>({result,model}));};
function lastToolResult(request:ModelRequest):unknown{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
}
type Statutory={ok:true;period:string;availablePeriods:string[];payslips:{ruleVersion:string|null;items:{key:string;employeeReported:number;employer:number;ruleKind:string;setBy:string}[]}[]};

describe('payslip statutory explainer',()=>{
 it('explains the caller\'s own released payslip from its stored working, and nothing else',async()=>{
  const {employee,mine,releasedBatch}=await people();
  const out=await explainOwnPayslipStatutory(employee,{}) as unknown as Statutory;
  expect(out.ok,JSON.stringify(out)).toBe(true);expect(out.period).toBe('2026-08');expect(out.availablePeriods).toEqual(['2026-08']);
  const [stored]=await owner.db.select({statutory:schema.payslip.statutory}).from(schema.payslip).where(and(eq(schema.payslip.employmentId,mine.employmentId),eq(schema.payslip.batchId,releasedBatch)));
  const expected=explainStatutory(stored.statutory,'regular');
  expect(out.payslips).toHaveLength(1);expect(out.payslips[0].items.map(row=>row.key)).toEqual(['epf','socso','skbbk','eis','hrdf','pcb']);
  expect(out.payslips[0].items.map(row=>[row.employeeReported,row.employer,row.ruleKind,row.setBy])).toEqual(expected.items.map(row=>[row.employeeReported,row.employer,row.ruleKind,row.provenance.source]));
  expect(out.payslips[0].items.find(row=>row.key==='epf')!.employeeReported).toBeGreaterThan(0);
  expect(out.payslips[0].ruleVersion).toBe(expected.rulesetVersion);
  const epf=await explainOwnPayslipStatutory(employee,{item:'epf'}) as unknown as Statutory;expect(epf.payslips[0].items.map(row=>row.key)).toEqual(['epf']);
  // The open run is invisible, exactly as on the employee's own payslip page.
  expect(await explainOwnPayslipStatutory(employee,{period:'2026-09'})).toMatchObject({ok:false,refusal:'no_data',availablePeriods:['2026-08']});
  expect(await explainOwnPayslipStatutory(employee,{period:'2026-13'})).toMatchObject({ok:false,refusal:'invalid_input'});
  expect(JSON.stringify(out)).not.toContain('Colleague');
 });
 it('leaves the model only placeholders and gives the person the exact figure',async()=>{
  const {employee}=await people();
  // The model writes whichever placeholder it was given for the EPF employee share.
  const placeholder=(request:ModelRequest)=>(lastToolResult(request) as {payslips:{items:{employeeReported:string}[]}[]}).payslips[0].items[0].employeeReported.split(' ')[0];
  // Spec v23: explain_why's payslip_statutory topic, disclosed under the statutory explainer's own entity.
  const {result,model}=await turn(employee,'Why is my EPF this much?',[{calls:[{name:'explain_why',args:{topic:'payslip_statutory',item:'epf'}}]},request=>({final:{reply:`Your EPF was ${placeholder(request)} this month.`}})]);
  expect(result.trace.calls.map(call=>[call.tool,call.status])).toEqual([['explain_why','ok']]);
  const disclosure=result.trace.disclosure.find(row=>row.tool==='explain_why')!;
  expect(disclosure.entity).toBe('statutory_explanation');
  expect(disclosure.undeclared).toEqual([]);expect(disclosure.removed).toEqual([]);expect(disclosure.banded.length).toBeGreaterThan(5);
  const sent=lastToolResult(model.requests[1]) as {payslips:{items:{employeeReported:string}[]}[]};
  expect(sent.payslips[0].items[0].employeeReported).toMatch(/^\{\{F\d+\}\} \(/);
  const exact=(await explainOwnPayslipStatutory(employee,{item:'epf'}) as unknown as Statutory).payslips[0].items[0].employeeReported;
  expect(result.reply).toBe(`Your EPF was ${exact} this month.`);
 });
});

describe('leave entitlement explainer',()=>{
 it('returns the leave summary\'s own breakdown for a named own leave type',async()=>{
  const {employee,mine}=await people();
  const out=await explainOwnLeaveEntitlement(employee,{leave_type:'annual'}) as unknown as {ok:true;leaveType:string;asOf:string;employments:Record<string,unknown>[];provenance:{owner:string}};
  expect(out.ok,JSON.stringify(out)).toBe(true);expect(out.leaveType).toBe('Annual Leave');expect(out.employments).toHaveLength(1);
  const owned=await leaveEntitlementBreakdown(employee,mine.employmentId,base.annualLeaveTypeId,out.asOf);
  const row=out.employments[0];
  expect(row.eligibleDays).toBe(owned!.eligibleDays);expect(row.totalEntitlement).toBe(owned!.totalEntitlement);
  expect(row.proration).toEqual(owned!.entitlement);expect(out.provenance.owner).toBe('core/read.ts#leaveEntitlementBreakdown');
  // Spec v23: the breakdown names what it does not show (nothing here), and carries no withheld flag.
  expect(row.notShown).toEqual([]);expect(row).not.toHaveProperty('withheld');
  expect(JSON.stringify(out)).not.toContain(mine.employmentId);
  expect(await explainOwnLeaveEntitlement(employee,{leave_type:'Fictional Sabbatical'})).toMatchObject({ok:false,refusal:'no_data',leaveTypes:['Annual Leave']});
 });
 it('discloses every returned field under a declared class through the harness',async()=>{
  const {employee}=await people();
  const {result}=await turn(employee,'Why do I have this many days of annual leave?',[{calls:[{name:'explain_why',args:{topic:'leave_entitlement',leave_type:'Annual Leave'}}]},{final:{reply:'It comes from your entitlement table.'}}]);
  expect(result.trace.calls[0]).toMatchObject({tool:'explain_why',status:'ok'});
  const disclosure=result.trace.disclosure[0];expect(disclosure.entity).toBe('entitlement_explanation');expect(disclosure.undeclared).toEqual([]);expect(disclosure.banded.length).toBeGreaterThan(3);
 });
});

describe('attendance day explainer',()=>{
 it('words the day\'s stored working as the screen does, in the person\'s language',async()=>{
  const {employee}=await people();
  const out=await explainOwnAttendanceDay(employee,{date:WORKDAY}) as unknown as {ok:true;flag:string;status:string;recorded:{lateMinutes:number};lateness:{minutes:number;steps:string[]};schedule:{shiftStart:string}};
  expect(out.ok,JSON.stringify(out)).toBe(true);expect(out.flag).toBe('late');expect(out.status).toBe('present');
  // The figure is the stored one (the rule may count from the end of a grace window, not the start).
  expect(out.lateness.minutes).toBe(out.recorded.lateMinutes);expect(out.lateness.minutes).toBeGreaterThan(0);expect(out.schedule.shiftStart).toBe('09:00');
  expect(out.lateness.steps).toEqual(expect.arrayContaining(['Scheduled start is 09:00.','Clocked in at 09:20.']));
  expect(out.lateness.steps.join(' ')).not.toMatch(/\{\w+\}/);
  const malay=await explainOwnAttendanceDay(employee,{date:WORKDAY},'ms') as unknown as {lateness:{steps:string[]}};
  expect(malay.lateness.steps).not.toEqual(out.lateness.steps);expect(malay.lateness.steps.join(' ')).toContain('09:20');
  expect(await explainOwnAttendanceDay(employee,{date:'2099-01-01'})).toMatchObject({ok:false,refusal:'out_of_range'});
  // A working day with no clocking: the owner returns the day itself (absent), with no stored working to explain.
  expect(await explainOwnAttendanceDay(employee,{date:'2026-07-02'})).toMatchObject({ok:true,status:'absent',explained:false,unavailableReason:'no-trace'});
  const {result}=await turn(employee,'Why was I marked late on 1 July?',[{calls:[{name:'explain_why',args:{topic:'attendance_day',date:WORKDAY}}]},{final:{reply:'You clocked in after the grace time.'}}]);
  expect(result.trace.calls[0]).toMatchObject({tool:'explain_why',status:'ok'});expect(result.trace.disclosure[0]).toMatchObject({entity:'attendance_day_explanation',undeclared:[]});
 });
 it('offers no explainer on a turn about another person',async()=>{
  const {employee}=await people();
  const {model}=await turn(employee,'Why was Fictional Explainer Colleague marked late?',[{final:{reply:'I can\'t look at another person\'s attendance.',mode:'refuse'}}]);
  const offered=model.requests[0].tools.map(tool=>tool.name);
  for(const capability of TERAS_CAPABILITIES)expect(offered).not.toContain(capability.name);
  expect(offered).not.toContain('explain_why');
 });
});

describe('setup co-pilot',()=>{
 it('gives an administrator every stage with counts and pages, never a person',async()=>{
  const {hr,employee}=await people();
  const copilot=await setupCopilot(hr,base.companyId);
  expect(copilot.stages.map(row=>row.stage)).toEqual([...SETUP_STAGES]);
  expect(copilot.stages.find(row=>row.stage==='claims_setup')!.status).toBe('no_owner');expect(copilot.gaps.map(row=>row.area)).toEqual(['claims_setup']);
  // Two of the three people have no login: they are counted, never named.
  const logins=copilot.stages.find(row=>row.stage==='employee_logins')!;
  expect(logins.blockers).toEqual([expect.objectContaining({check:'employees_without_login',count:1,page:'/admin/users'})]);
  const coverage=await coverageReadiness(hr,base.companyId);expect(coverage.logins).toMatchObject({withoutLogin:1,withoutLoginWithEmployment:1});
  const text=JSON.stringify(copilot);expect(text).not.toMatch(/Fictional Explainer|[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect(copilot.next===null||SETUP_STAGES.includes(copilot.next.stage)).toBe(true);
  await expect(setupCopilot(employee,base.companyId)).rejects.toBeInstanceOf(SetupCopilotRefused);
  const capability=TERAS_CAPABILITIES.find(row=>row.name==='setup_copilot')!;
  expect(await capability.run(employee,{},{companyId:base.companyId})).toMatchObject({ok:false,refusal:'not_permitted'});
  const {result}=await turn(hr,'What should I set up next before our first payroll?',[{calls:[{name:'setup_copilot'}]},{final:{reply:'Start with the payroll setup page.'}}]);
  expect(result.trace.calls[0].status).toBe('ok');expect(result.trace.disclosure[0].undeclared).toEqual([]);
  const {model}=await turn(employee,'What should I set up next?',[{final:{reply:'That is for your HR administrator.'}}]);
  expect(model.requests[0].tools.map(tool=>tool.name)).not.toContain('setup_copilot');
 });
});


describe('public administrative page guidance',()=>{
 it('uses literal native owners, refuses direct employee calls and repeats the Payroll gate',async()=>{
  const {hr,employee}=await people(),scope={companyId:base.companyId};
  const password=TERAS_CAPABILITIES.find(row=>row.name==='password_policy_guidance')!,corrections=TERAS_CAPABILITIES.find(row=>row.name==='correction_controls_guidance')!,organisation=TERAS_CAPABILITIES.find(row=>row.name==='organisation_tagging_guidance')!;
  for(const capability of [password,corrections,organisation]){
   expect(await capability.run(employee,{},scope)).toMatchObject({ok:false,refusal:'not_permitted'});
   const value=await capability.run(hr,{password:'FICTIONAL_PRIVATE_PASSWORD',setting:'FICTIONAL_TENANT_SETTING',payrollAmount:987654321},scope);
   expect(value.ok).toBe(true);expect(Object.keys(value).sort()).toEqual(['humanBoundary','navigation','ok','page','provenance','purpose']);
   expect(JSON.stringify(value)).not.toMatch(/FICTIONAL_PRIVATE_PASSWORD|FICTIONAL_TENANT_SETTING|987654321|Fictional Explainer|[0-9a-f]{8}-[0-9a-f]{4}-/);
  }
  expect(await password.run(hr,{},scope)).toMatchObject({page:'/admin/security-center/password-policy',humanBoundary:expect.stringContaining('group administrator'),provenance:{owner:'core/explainers/capabilities.ts#passwordPolicyGuidance'}});
  expect((await password.run(hr,{},scope)).humanBoundary).toContain('internal embedded HR login');
  expect(await corrections.run(hr,{},scope)).toMatchObject({page:'/payroll/setup/correction-controls',humanBoundary:expect.stringContaining('only a group administrator'),provenance:{owner:'core/explainers/capabilities.ts#correctionControlsGuidance'}});
  expect((await corrections.run(hr,{},scope)).humanBoundary).toContain('separately chooses');
  expect(await organisation.run(hr,{runId:'FICTIONAL_PRIVATE_RUN',digest:'FICTIONAL_SOURCE_HASH',employee:'FICTIONAL_EMPLOYEE'},scope)).toMatchObject({page:'/admin/organization/organisation-tagging',humanBoundary:expect.stringContaining('different login and Person'),provenance:{owner:'core/explainers/capabilities.ts#organisationTaggingGuidance'}});
  expect(JSON.stringify(await organisation.run(hr,{runId:'FICTIONAL_PRIVATE_RUN'},scope))).not.toContain('FICTIONAL_PRIVATE_RUN');
  await setModule(base.tenantId,'payroll','disabled');
  const disabled={...hr,entitlements:(await entitledCtx(base,['hr_admin'])).entitlements};
  expect(await corrections.run(disabled,{},scope)).toMatchObject({ok:false,refusal:'not_permitted'});
  expect((await nativeToolProvider(disabled,scope,false)).bindings.map(binding=>binding.name)).not.toContain('correction_controls_guidance');
  // Folded into product_guidance (spec v22), the topic keeps the Payroll gate: refused while Payroll is off.
  const disabledGuidance=(await nativeToolProvider(disabled,scope,false)).bindings.find(binding=>binding.name==='product_guidance')!;
  expect(await disabledGuidance.run({query:'Correction Controls',topic:'correction_controls'})).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(await disabledGuidance.run({query:'Password Policy',topic:'password_policy'})).toMatchObject({ok:true,content:{page:'/admin/security-center/password-policy'}});
  expect(await password.run(disabled,{},scope)).toMatchObject({ok:true,page:'/admin/security-center/password-policy'});
 });
 it('serves the reviewed public text as product_guidance topics, adding no tool of its own (spec v22)',async()=>{
  const {hr,employee}=await people(),scope={companyId:base.companyId};
  const admin=await nativeToolProvider(hr,scope,true),names=admin.bindings.map(binding=>binding.name);
  // Release merge: main's two guides are product_guidance topics, so they add no binding against the provider's tool
  // ceiling (test/harness-tool-ceiling.test.ts computes the worst case per role).
  expect(names).not.toContain('password_policy_guidance');expect(names).not.toContain('correction_controls_guidance');expect(names).not.toContain('organisation_tagging_guidance');
  expect(names).toContain('product_guidance');expect(new Set(names).size).toBe(names.length);
  const guidance=admin.bindings.find(binding=>binding.name==='product_guidance')!;
  expect(await guidance.run({query:'How is an organisation proposal reviewed?',topic:'organisation_tagging'})).toMatchObject({ok:true,content:{page:'/admin/organization/organisation-tagging',humanBoundary:expect.stringContaining('Guidance cannot choose mappings')}});
  expect(guidance).toMatchObject({kind:'context',entity:null});
  expect(guidance.spec.inputSchema).toMatchObject({properties:{topic:{type:'string',enum:['password_policy','correction_controls','organisation_tagging']}},required:['query']});
  const gate=gateTurn('Where are Password Policy and Correction Controls, and who confirms changes?',{sensitive:HARNESS_SPEC.sensitive.topics});
  expect(gate).toEqual({privateReads:false,actions:true,reason:'other_person'});
  const offered=offerFor(admin.bindings,gate),offeredNames=offered.map(binding=>binding.name);
  expect(offeredNames).toContain('product_guidance');
  // Spec v23: a folded read is reached through its topic tool, itself a private read; every other capability is bound as one.
  for(const capability of TERAS_CAPABILITIES.filter(row=>!row.topic))
   expect(admin.bindings.find(binding=>binding.name===(FOLDED_READS.get(capability.name)?.tool??capability.name))!.kind,capability.name).toBe('read');
  const privateReads=admin.bindings.filter(binding=>binding.kind==='read');expect(privateReads.length).toBeGreaterThan(0);
  for(const binding of privateReads)expect(offeredNames).not.toContain(binding.name);
  expect(admin.bindings.find(binding=>binding.name==='setup_copilot')!.kind).toBe('read');expect(offeredNames).not.toContain('setup_copilot');
  expect(offeredNames).not.toContain('setup_readiness');expect(offeredNames).not.toContain('company_setup');
  // An employee still reaches neither guide: the topic is refused before the owner returns anything.
  const ordinary=await nativeToolProvider(employee,scope,true),ordinaryGuidance=ordinary.bindings.find(binding=>binding.name==='product_guidance')!;
  for(const topic of ['password_policy','correction_controls','organisation_tagging'])
   expect(await ordinaryGuidance.run({query:'Where is it?',topic})).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(await guidance.run({query:'Where is it?',topic:'unlisted_topic'})).toMatchObject({ok:false,refusal:'invalid_input'});
  const {result,model}=await turn(hr,'Where are Password Policy and Correction Controls, and who confirms changes?',[
   {calls:[{name:'product_guidance',args:{query:'Password Policy',topic:'password_policy'}}]},
   {calls:[{name:'product_guidance',args:{query:'Correction Controls',topic:'correction_controls'}}]},
   {final:{reply:'An authorized human confirms each change on its native page.'}},
  ]);
  expect(result.trace.gate).toEqual({privateReads:false,actions:true,reason:'other_person'});
  expect(result.trace.offered).toContain('product_guidance');
  for(const binding of privateReads)expect(result.trace.offered).not.toContain(binding.name);
  expect(result.trace.calls.map(call=>[call.tool,call.status])).toEqual([['product_guidance','ok'],['product_guidance','ok']]);
  for(const applied of result.trace.disclosure){expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);expect(applied.banded).toEqual([]);}
  expect(lastToolResult(model.requests[1])).toMatchObject({page:'/admin/security-center/password-policy',humanBoundary:expect.stringContaining('group administrator')});
  expect(lastToolResult(model.requests[2])).toMatchObject({page:'/payroll/setup/correction-controls',humanBoundary:expect.stringContaining('separately chooses')});
 });
});
