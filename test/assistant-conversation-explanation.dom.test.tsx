/** @vitest-environment jsdom */
/** Authored UNRUN. Actual view owners issue all proofs; only trusted source readers are mocked.
 * This does not prove browser experience, native authorization or provider explanation quality. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en',outcome:{} as unknown}));
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viCopy};
function text(namespace:string,key:string,args:Record<string,string|number>={}){let value:unknown=copies[state.locale];for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];if(typeof value!=='string')throw Error('Missing existing explanation translation');return value.replace(/\{(\w+)\}/g,(_whole,field:string)=>String(args[field]??''));}
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>(key:string,args?:Record<string,string|number>)=>text(namespace,key,args)}));
vi.mock('../core/module-agent-releases',()=>({reopenGovernedModuleReadJobTx:vi.fn(),readGovernedSpecialistToolResultTx:vi.fn()}));
vi.mock('../core/assistant-tools',()=>({toolsFor:()=>[{spec:{name:'leave_entitlement_explain'},module:'leave',run:async()=>state.outcome}]}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:async(_ctx:unknown,_module:unknown,consume:(read:unknown)=>Promise<unknown>)=>consume({})}));
import {loadCanonicalToolJob,loadGovernedWorkspaceJobTx,type CanonicalModuleJobView} from '../core/workspace-module-jobs';
import {reopenGovernedModuleReadJobTx} from '../core/module-agent-releases';
import {assistantSourceDigest} from '../lib/ai/assistant-disclosure';
import {MODULE_AGENT_CAPABILITIES} from '../lib/ai/module-agents';
import {executeCanonicalSpecialist,compactSpecialistWork} from '../lib/ai/module-specialists';
import {ENTITLEMENT_STATUS_LABEL_KEY,ENTITLEMENT_STATUS_TIP_KEY} from '../lib/entitlement-status';
import type {AssistantAnswerExplanation} from '../lib/ai/assistant-answer-explanations';
import type {AssistantReadSession} from '../core/assistant-read-session';
import type {SessionContext,Tx} from '../db/client';
import {ConversationExplanation} from '../components/assistant/conversation-explanation';
const ctx:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user',personId:'fictional-person',roles:['employee'],grants:[{role:'employee',companyId:null}]};
const locales=['en','ms','zh','ta','th','vi'];
function outcome(status='no_eligibility_match',withheld=false){return{ok:true,asOf:'2026-10-01',employments:[{employmentId:'fictional-own-employment',company:'Canonical company',leaveType:'Annual',cycleStart:'2026-01-01',withheld,entitlementStatus:status,entitlementTemplateName:null,carryForwardExpiryDate:null,displayEntitlementDays:0,currentYearEntitlement:0,broughtForward:0,adjustments:0,totalEntitlement:0,takenThisCycle:0,pendingApproval:0,forfeitedThisCycle:0,totalAvailable:0,eligibility:{verdict:'no_match',activeAtDate:true,usesUndatedAxis:true,rules:[{id:'PRIVATE-LINEAGE',name:'Canonical scheme',state:'in_force',tested:true,validFrom:'2026-01-01',validTo:null,tableName:'PRIVATE-TABLE',failingAxis:'employmentTypes',failingAxisValue:'PRIVATE-AXIS-VALUE',failsOnCombination:false},{id:'PRIVATE-TEAM',name:'Canonical team scheme',state:'in_force',tested:true,validFrom:'2026-01-01',validTo:null,tableName:null,failingAxis:'orgTeam',failingAxisValue:'PRIVATE-TEAM-VALUE',failsOnCombination:false},{id:'PRIVATE-COMBINATION',name:'Combined scheme',state:'in_force',tested:true,validFrom:'2026-01-01',validTo:null,tableName:null,failingAxis:null,failsOnCombination:true},{id:'PRIVATE-OLD',name:'Prior scheme',state:'expired',tested:false,validFrom:'2024-01-01',validTo:'2025-12-31',tableName:null,failingAxis:null,failsOnCombination:false},{id:'PRIVATE-FUTURE',name:'Future scheme',state:'not_yet',tested:false,validFrom:'2027-01-01',validTo:null,tableName:null,failingAxis:null,failsOnCombination:false}]}}]};}
async function leave(source:unknown=outcome()){state.outcome=source;return loadCanonicalToolJob(ctx,'leave_entitlement_explain',{},assistantSourceDigest(source),{} as AssistantReadSession);}
function explanations(view:CanonicalModuleJobView){if(view.state!=='ready'||!view.answerExplanations?.length)throw Error('Actual canonical source owner must attach explanations before proof issuance');return view.answerExplanations;}
function clause(view:CanonicalModuleJobView,code:string){const found=explanations(view).find(row=>row.code===code);if(!found)throw Error('Missing genuine canonical clause');return found;}
async function show(view:CanonicalModuleJobView,explanation:AssistantAnswerExplanation,principal=ctx){return render(await ConversationExplanation({view,explanation,ctx:principal}));}
beforeEach(()=>{state.locale='en';vi.clearAllMocks();});afterEach(cleanup);
describe('source-owned conversational explanation display',()=>{
 it.each(locales)('%s renders exact canonical status and tip without inferring a verdict from zero',async locale=>{
  state.locale=locale;
  for(const status of ['not_generated','zero_entitlement','earning_method_missing','capped_by_max_balance','earned_accrual'] as const){const view=await leave(outcome(status)),shown=await show(view,clause(view,`leave_status:${status}`));expect(shown.container.textContent).toContain(text('me.leaveBalanceTable',ENTITLEMENT_STATUS_LABEL_KEY[status]));const tip=ENTITLEMENT_STATUS_TIP_KEY[status];if(tip)expect(shown.container.textContent).toContain(text('me.leaveBalanceTable',tip));expect(shown.container.textContent).not.toContain(text('leave.breakdown','eligibilityRulesTitle'));expect(shown.container.querySelector('a')).toBeNull();shown.unmount();}
 });
 it.each(locales)('%s renders only selected known eligibility clauses, exact dates and translated axis names',async locale=>{
  state.locale=locale;const view=await leave();
  for(const code of ['leave_eligibility:no_match','leave_eligibility:undated_axes','leave_rule:in_force','leave_rule:expired','leave_rule:not_yet']){const selected=clause(view,code),shown=await show(view,selected);expect(screen.queryByRole('status')).toBeNull();const content=shown.container.textContent!;
   if(code==='leave_rule:in_force'){expect(content).toContain('Canonical scheme');expect(content).toContain(text('leave.breakdown','eligibilityWhyAxis',{axis:text('admin.leave.adjustmentsCriteria','employmentType')}));expect(content).toContain('Canonical team scheme');expect(content).toContain(text('leave.breakdown','eligibilityWhyAxis',{axis:text('admin.profileOptions.category','team')}));expect(content).toContain(text('leave.breakdown','eligibilityWhyCombination'));expect(content).not.toContain('orgTeam');}
   if(code==='leave_rule:expired')expect(content).toContain(text('leave.breakdown','eligibilityStateExpired',{date:'2025-12-31'}));
   if(code==='leave_rule:not_yet')expect(content).toContain(text('leave.breakdown','eligibilityStateNotYet',{date:'2027-01-01'}));
   expect(content).not.toContain('PRIVATE-');expect(content).not.toContain('employmentTypes');expect(shown.container.querySelector('a')).toBeNull();shown.unmount();
  }
 });
 it.each(locales)('%s shows the first three actual tested rules and keeps all remaining rule detail in a closed native disclosure',async locale=>{
  state.locale=locale;const source=outcome(),original=source.employments[0].eligibility.rules[0];
  source.employments[0].eligibility.rules=Array.from({length:6},(_,index)=>({...original,id:`PRIVATE-LINEAGE-${index+1}`,name:`Canonical rule ${index+1}`,failingAxisValue:'PRIVATE-STORED-AXIS'}));
  const view=await leave(source),selected=clause(view,'leave_rule:in_force'),shown=await show(view,selected);
  expect(screen.queryByRole('status')).toBeNull();const root=shown.container.firstElementChild!;
  const details=root.querySelector('details') as HTMLDetailsElement;expect(details).not.toBeNull();expect(details.open).toBe(false);expect(details.hasAttribute('open')).toBe(false);
  expect(details.querySelector('summary')?.textContent).toBe(text('assistant.workspace.conversation','moreRules',{count:3}));
  expect(details.querySelector('summary')?.className).toContain('min-h-11');expect(details.querySelector('summary')?.className).toContain('focus-visible:ring-2');
  expect([...root.querySelectorAll(':scope > p')].map(row=>row.querySelector('span')?.textContent)).toEqual(['Canonical rule 1','Canonical rule 2','Canonical rule 3']);
  expect([...details.querySelectorAll('p')].map(row=>row.querySelector('span')?.textContent)).toEqual(['Canonical rule 4','Canonical rule 5','Canonical rule 6']);
  for(const row of root.querySelectorAll('p')){expect(row.textContent).toContain(text('leave.breakdown','eligibilityStateInForce'));expect(row.textContent).toContain(text('leave.breakdown','eligibilityWhyAxis',{axis:text('admin.leave.adjustmentsCriteria','employmentType')}));}
  expect(root.textContent).not.toContain('PRIVATE-');expect(root.textContent).not.toContain('employmentTypes');expect(root.querySelector('a')).toBeNull();
 });
 it('refuses copied views, copied descriptors, other callers and equal-looking descriptors from another source',async()=>{
  const original=await leave(),selected=clause(original,'leave_status:no_eligibility_match'),other=await leave();
  for(const input of [{view:JSON.parse(JSON.stringify(original)) as CanonicalModuleJobView,explanation:selected,principal:ctx},{view:original,explanation:JSON.parse(JSON.stringify(selected)) as AssistantAnswerExplanation,principal:ctx},{view:original,explanation:selected,principal:{...ctx,userId:'another-user'}},{view:original,explanation:clause(other,'leave_status:no_eligibility_match'),principal:ctx}]){const shown=await show(input.view,input.explanation,input.principal);expect(screen.getByRole('status').textContent).toBe(text('assistant.workspace.conversation','unavailable'));expect(shown.container.textContent).not.toContain('Canonical scheme');shown.unmount();}
 });
 it('does not borrow eligibility from another card, withheld source or non-match status',async()=>{
  const original=await leave(),selected=clause(original,'leave_rule:in_force');
  const two=outcome();two.employments.push({...two.employments[0],employmentId:'other-own-employment',company:'Other company'});const second=await leave(two),secondDescriptor=explanations(second).find(row=>row.card===1&&row.code==='leave_rule:in_force')!;
  for(const [view,descriptor] of [[original,secondDescriptor],[await leave(outcome('no_eligibility_match',true)),selected],[await leave(outcome('not_generated')),selected]] as const){const shown=await show(view,descriptor);expect(screen.getByRole('status').textContent).toBe(text('assistant.workspace.conversation','unavailable'));expect(shown.container.textContent).not.toContain('Canonical scheme');shown.unmount();}
 });
 it.each(locales)('%s uses actual specialist assessment findings and diagnostic state/record only',async locale=>{
  state.locale=locale;const module='employees' as const,source={module,capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1],scope:'current-caller',data:{rows:[{employeeCode:'PRIVATE-REC',company:'PRIVATE-COMPANY',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}},candidate={kind:'canonical_specialist_v1' as const,module,playbook:'canonical_followup_v1' as const},assessment=executeCanonicalSpecialist(candidate,source);
  vi.mocked(reopenGovernedModuleReadJobTx).mockResolvedValue({jobId:'00000000-0000-4000-8000-000000000001',results:[source],specialists:[{module,assessment,work:compactSpecialistWork(assessment,{mode:'promoted',version:1,configuration:candidate})}],mode:'promoted',changedSinceRun:false,feedbackOutcome:null} as Awaited<ReturnType<typeof reopenGovernedModuleReadJobTx>>);
  const reopened=await loadGovernedWorkspaceJobTx(ctx,{} as Tx,'00000000-0000-4000-8000-000000000001');if(reopened.state!=='ready')throw Error('Canonical replay unavailable');const view=reopened.views[0];
  const finding=clause(view,'specialist_finding:employment_active'),shownFinding=await show(view,finding);expect(shownFinding.container.textContent).toBe(text('assistant.workspace.specialistFindings','employment_active'));shownFinding.unmount();
  const followup=clause(view,'specialist_followup:check_employment'),shown=await show(view,followup);expect(shown.container.textContent).toContain(text('assistant.workspace.specialists','diagnosticState_recorded'));expect(shown.container.textContent).toContain(text('assistant.workspace.specialists','diagnosticRecord',{n:1}));expect(shown.container.textContent).not.toMatch(/PRIVATE-|check_employment|rows\[|https?:/);expect(shown.container.querySelector('a')).toBeNull();
 });
});
