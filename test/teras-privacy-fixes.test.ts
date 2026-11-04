/** ADR-0169 §5.1 privacy review (November 2026) — the disclosure defects the draft review package found, each
 * pinned on fictional data with a scripted model and fictional tools (no database, no provider). */
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {HARNESS_SPEC} from '../core/harness/spec';
import {HARNESS_TEST_ONLY,PersonSideHistory,routeReply,runTurn,type ModelHistoryMessage,type TurnOptions} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';
import {identifiersIn,screenIdentifiers} from '../core/harness/reply-checks';
import {outcomeRecordFromTrace,storedTrace} from '../core/harness/trace-persistence';
import type {ToolRun} from '../core/harness/tools';
import {FICTIONAL,fakeTools} from './harness-ratchet/fake-tools';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';

const employee:SessionContext={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',personId:'00000000-0000-4000-8000-0000000000cc',
 roles:['employee'],grants:[{role:'employee',companyId:null}]};
const SCOPE={companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'};
type Outputs=Partial<Record<string,(input:Record<string,unknown>)=>ToolRun>>;
async function turn(question:string,script:readonly ScriptStep[],extra:Partial<TurnOptions>&{outputs?:Outputs}={}){
 const {provider,dispatched}=fakeTools({outputs:extra.outputs}),model=scriptedModel(script),memory=extra.memory??new InMemoryTaskMemoryStore();
 const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:employee,conversationId:'conversation-p',question,scope:SCOPE,model,memory,tools:provider,...extra});
 return{result,model,dispatched,memory};
}
const sent=(model:ReturnType<typeof scriptedModel>)=>JSON.stringify(model.requests.map(request=>request.messages));

describe('defect 1: module work rows disclose only declared fields',()=>{
 it('removes undeclared fields and employee codes, and withholds other people\'s names, at any depth',()=>{
  const ledger=new DisclosureLedger('me');
  const {value,applied}=discloseToolOutput('my_module_work','module_work',{module:'org',capability:'org.read',scope:'current-caller',
   data:{rows:[{employmentId:FICTIONAL.ownEmployment,company:FICTIONAL.company,employeeCode:'FX-0042',privateNote:'Fictional undeclared note',tags:['Fictional undeclared tag'],
    reportingLines:[{lineType:'administrative',name:'Fictional Manager Rahim',employeeCode:'FX-0099'}]}],truncated:false},humanActions:[]},ledger);
  const text=JSON.stringify(value);
  for(const leak of ['FX-0042','FX-0099','Fictional Manager Rahim','Fictional undeclared note','Fictional undeclared tag',FICTIONAL.ownEmployment])expect(text,leak).not.toContain(leak);
  expect(text).toContain(FICTIONAL.company);expect(text).toContain('administrative');
  expect(applied.undeclared).toEqual(expect.arrayContaining(['capability','scope','data.rows[0].privateNote','data.rows[0].tags[0]']));
  expect(applied.removed).toEqual(expect.arrayContaining(['data.rows[0].employeeCode','data.rows[0].reportingLines[0].employeeCode']));
  expect([...ledger.texts.values()].map(row=>row.value)).toEqual(['Fictional Manager Rahim']);
 });
 it('never sends a module row\'s code or name through a turn, and restores the name for the person',async()=>{
  const {result,model}=await turn('Who is my manager in the org module?',[{calls:[{name:'my_module_work',args:{module:'org'}}]},{final:{reply:'Your manager is {{T1}}.'}}]);
  expect(sent(model)).not.toContain('FX-0042');expect(sent(model)).not.toContain('FX-0099');
  expect(sent(model)).not.toContain('Fictional Manager Rahim');expect(sent(model)).not.toContain('Fictional undeclared note');
  expect(result.reply).toBe('Your manager is Fictional Manager Rahim.');
 });
});

describe('defect 2: suggest_action\'s pending choice is declared',()=>{
 const pending:ToolRun={ok:true,suggestion:{action:'approvals.leave.decide',reviewRoute:'/assistant/approvals',inlineCard:true},content:{suggested:true,action:'approvals.leave.decide',reviewRoute:'/assistant/approvals',inlineCard:true,
  pending:[{request:1,applicant:'Fictional Applicant Aina',leaveType:'Annual Leave',days:3,starts:'next_week',startDate:'2026-11-09',endDate:'2026-11-11'},
   {request:2,applicant:'Fictional Applicant Farid',leaveType:'Medical Leave',days:1,starts:'this_week',startDate:'2026-11-04',endDate:'2026-11-04'}],note:'List them by number.'}};
 it('sends an ordinal and minimal labels, never a name, exact date or health-indicative type; the person sees them restored',async()=>{
  const {result,model}=await turn('Please approve the leave waiting for me.',[{calls:[{name:'suggest_action',args:{action:'leave.apply'}}]},
   {final:{reply:'Request 1: {{T1}}, Annual Leave, 3 days from {{T2}}. Request 2: {{T4}}, {{T5}}. Which number?',mode:'clarify'}}],
   // The system text names today: pinned, so a fixture date is never today's (run 41675926061 ran on 2026-11-04 in Kuala Lumpur).
   {outputs:{suggest_action:()=>pending},clock:()=>new Date('2026-11-02T04:00:00Z')});
  const text=sent(model);
  for(const leak of ['Fictional Applicant','2026-11-09','2026-11-11','2026-11-04','Medical Leave'])expect(text,leak).not.toContain(leak);
  for(const kept of ['\\"request\\":1','\\"request\\":2','Annual Leave','next_week','\\"days\\":3'])expect(text,kept).toContain(kept);
  expect(result.reply).toBe('Request 1: Fictional Applicant Aina, Annual Leave, 3 days from 2026-11-09. Request 2: Fictional Applicant Farid, Medical Leave. Which number?');
  expect(result.trace.disclosure.find(row=>row.tool==='suggest_action')?.entity).toBe('suggested_action');
 });
});

describe('defect 3: history is the model-side transcript',()=>{
 it('never sends a figure banded on turn 1 exactly in any later model request',async()=>{
  const memory=new InMemoryTaskMemoryStore();
  const first=await turn('What was my net pay?',[{calls:[{name:'my_payslip_summary',args:{limit:1}}]},{final:{reply:'Your net pay was RM {{F3}}.'}}],{memory});
  expect(first.result.reply).toBe('Your net pay was RM 4422.25.');
  expect(first.result.personTurn.at(-1)?.content).toBe('Your net pay was RM 4422.25.');
  expect(JSON.stringify(first.result.modelTurn)).not.toContain('4422.25');
  const second=await turn('Is that more than last month?',[{final:{reply:'I can only see one payslip.'}}],{memory,history:first.result.modelTurn});
  let history:readonly ModelHistoryMessage[]=[...first.result.modelTurn,...second.result.modelTurn];
  const third=await turn('Thanks.',[{final:{reply:'You are welcome.'}}],{memory,history});
  for(const model of [second.model,third.model]){expect(model.requests.length).toBeGreaterThan(0);expect(sent(model)).not.toContain('4422.25');}
  expect(sent(second.model)).toContain('between 2000 and 5000');
  history=[...history,...third.result.modelTurn];expect(JSON.stringify(history)).not.toContain('4422.25');
 });
 it('refuses a person-side transcript as history',async()=>{
  await expect(turn('And last month?',[{final:{reply:'Ok.'}}],{history:[{role:'assistant',content:'Your net pay was RM 4422.25.'} as never]})).rejects.toBeInstanceOf(PersonSideHistory);
 });
});

describe('defect 4: identifiers are screened on the way in',()=>{
 it('matches the gaps the review found, and a phone number is not a bank account',()=>{
  expect(identifiersIn('passport a12345678')).toEqual(['passport']);expect(identifiersIn('IC 900101 14 5678')).toEqual(['ic']);
  expect(identifiersIn('IC 900101-14-5678')).toEqual(['ic']);expect(identifiersIn('EPF no 12345678')).toEqual(['epf']);
  expect(identifiersIn('SOCSO number 123456789')).toEqual(['socso']);expect(identifiersIn('call 0123456789')).toEqual(['phone']);
  expect(identifiersIn('call +60 12-345 6789')).toEqual(['phone']);expect(identifiersIn('mail fictional.person@example.test')).toEqual(['email']);
  expect(identifiersIn('account 12345678901234')).toEqual(['bank_account']);
  expect(screenIdentifiers('You have 17.25 days; net RM 4,422.25 on 2026-11-03, {{F1}} (at least 100000), ref-12.').count).toBe(0);
  expect(screenIdentifiers('IC 900101-14-5678 or 0123456789')).toEqual({text:'IC [ic removed] or [phone removed]',count:2,kinds:['ic','phone']});
 });
 it('screens the question, the history, the task-memory goal and tool output before any model request, counting only',async()=>{
  const memory=new InMemoryTaskMemoryStore();
  const values=['900101-14-5678','0123456789','fictional.person@example.test','a12345678','EPF no 87654321'];
  const first=await turn('My IC is 900101-14-5678 and phone 0123456789: how much leave do I have?',[{calls:[{name:'product_guidance',args:{query:'leave'}}]},{final:{reply:'Ok.'}}],
   {memory,outputs:{product_guidance:()=>({ok:true,content:[{title:'Contact',section:'Email fictional.person@example.test, quoting EPF no 87654321.',href:'/leave'}]})}});
  const second=await turn('And passport a12345678?',[{final:{reply:'Ok.'}}],{memory,history:first.result.modelTurn});
  for(const model of [first.model,second.model])for(const value of values)expect(sent(model),value).not.toContain(value);
  expect((await memory.load(employee.tenantId,employee.userId!,'conversation-p'))?.goal).toBe('My IC is [ic removed] and phone [phone removed]: how much leave do I have?');
  expect(first.result.trace.screening).toEqual({question:2,history:0,memory:0,tools:2,kinds:['ic','phone','email','epf']});
  expect(second.result.trace.screening).toMatchObject({question:1,history:0,memory:0});
  for(const value of values)expect(JSON.stringify([first.result.trace,second.result.trace]),value).not.toContain(value);
 });
});

describe('defect 5: minimum is narrower than full',()=>{
 it('withholds another person\'s minimum fields and a colleague\'s name, keeps full fields, and keeps the caller\'s own minimum fields exact',async()=>{
  const {result,model}=await turn('Who is away this week?',[{calls:[{name:'who_is_away',args:{from:'2026-11-02',to:'2026-11-08'}}]},{final:{reply:'{{T1}} is away from {{T3}} to {{T4}} ({{T2}}).'}}]);
  for(const leak of ['Fictional Colleague Mei','FX-0007','Medical Leave'])expect(sent(model),leak).not.toContain(leak);
  // The trusted system prompt legitimately states today's date; on5/6Nov it equals a fixture date.
  // Check every non-system message for private dates, retaining the complete name/type checks above.
  const privateMessages=JSON.stringify(model.requests.map(request=>request.messages.filter(message=>message.role!=='system')));
  for(const leak of ['2026-11-05','2026-11-06'])expect(privateMessages,leak).not.toContain(leak);
  expect(sent(model)).toContain('approved');
  expect(result.reply).toBe('Fictional Colleague Mei is away from 2026-11-05 to 2026-11-06 (Medical Leave).');
  const ledger=new DisclosureLedger('me');
  const other=JSON.stringify(discloseToolOutput('employee_profile','employment_profile',{employee:{name:'Fictional Other Person',gradeName:'G9',terminatedOn:'2026-10-31',workState:'Selangor'}},ledger).value);
  for(const leak of ['Fictional Other Person','G9','2026-10-31'])expect(other,leak).not.toContain(leak);expect(other).toContain('Selangor');
  const own=JSON.stringify(discloseToolOutput('my_leave_requests','leave_request',{rows:[{leaveType:'Annual Leave',status:'approved',startDate:'2026-11-05',endDate:'2026-11-06',days:2}]},ledger).value);
  expect(own).toContain('2026-11-05');expect(own).toContain('Annual Leave');
 });
 it('withholds health- and religion-indicative leave, claim and pay item names; ordinary names stay',()=>{
  const ledger=new DisclosureLedger('me');
  const pay=JSON.stringify(discloseToolOutput('my_pay_change','pay_change',{period:'2026-10',lines:[{code:'ZAKAT',name:'Zakat',current:50},{code:'BASIC',name:'Basic Salary',current:4000}]},ledger).value);
  expect(pay).not.toMatch(/zakat/i);expect(pay).toContain('Basic Salary');
  const claims=JSON.stringify(discloseToolOutput('my_claim_statuses','claim_status',{claims:[{claimType:'Medical Claim',status:'paid'},{claimType:'Travel',status:'paid'}]},ledger).value);
  expect(claims).not.toContain('Medical');expect(claims).toContain('Travel');
  const requests=JSON.stringify(discloseToolOutput('my_leave_requests','leave_request',{rows:[{leaveType:'Cuti Sakit',status:'approved'},{leaveType:'Maternity Leave',status:'pending'}]},ledger).value);
  expect(requests).not.toMatch(/sakit|maternity/i);
 });
});

describe('defect 6: sensitive topics never reach the model',()=>{
 it('routes medical, harassment, grievance and termination-threat turns to HR without a model call or a stored goal',async()=>{
  for(const question of ['I was diagnosed with depression last month.','My supervisor keeps making sexual comments about me.','I want to file a grievance against my manager.','My boss threatened to fire me.']){
   const {result,model,dispatched}=await turn(question,[{final:{reply:'I am sorry you are dealing with this.'}}]);
   expect(model.requests,question).toEqual([]);expect(dispatched,question).toEqual([]);expect(result.trace.budgets.steps,question).toBe(0);
   expect(result.reply,question).toBe(routeReply());expect(result.memory.goal,question).toBeNull();
   expect(JSON.stringify(result.modelTurn),question).not.toContain(question);expect(result.modelTurn[0].content).toBe(HARNESS_SPEC.history.routedQuestion);
  }
 });
});

describe('defect 7: the outcome record trace keeps kinds and counts only',()=>{
 it('stores no reply phrase, link, field path, placeholder or person id, and leaves the notice default to the owner',async()=>{
  const {result}=await turn('Apply leave for 20 November.',[{calls:[{name:'my_leave_balances'}]},{final:{reply:'Done. I have submitted the leave request at /hr/portal.',mode:'propose'}},
   {final:{reply:'You have {{F5}} days; review it on /leave.',mode:'answer'}}]);
  const stored=JSON.stringify(storedTrace(result.trace));
  for(const leak of ['submitted','/hr/portal','{{F5}}','employments[0]',employee.userId!,employee.personId!,'13.25'])expect(stored,leak).not.toContain(leak);
  expect(storedTrace(result.trace)).toMatchObject({checks:[{attempt:1,failed:['destination_links','overclaim']},{attempt:2,failed:[]}]});
  const record=outcomeRecordFromTrace(result.trace);
  expect(record.trace).toEqual(storedTrace(result.trace));expect(record.notice).toBe('not_applicable');
 });
});
