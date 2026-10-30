/** @vitest-environment jsdom */
/** Authored UNRUN. Source owners issue real view proofs; trusted source replay alone is mocked.
 * Parent must separately verify the human_review_required-only mounting condition. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en'}));
// Imported catalogues initialize normally; including them in the hoisted declaration accesses
// Vitest's transformed import binding before initialization and prevents every suite case running.
const copies:Record<string,typeof en>={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>{const value=copies[state.locale].assistant.workspace.jobs[key as keyof typeof en.assistant.workspace.jobs];if(typeof value!=='string')throw Error('Missing handoff translation');return value;}}));
vi.mock('../core/module-agent-releases',()=>({readGovernedSpecialistToolResultTx:vi.fn(),reopenGovernedModuleReadJobTx:vi.fn()}));
vi.mock('../core/assistant-tools',()=>({toolsFor:()=>[]}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:vi.fn()}));
import {loadGovernedSpecialistToolJob,type CanonicalModuleJobView} from '../core/workspace-module-jobs';
import {readGovernedSpecialistToolResultTx} from '../core/module-agent-releases';
import {moduleHumanActionHandoffs} from '../lib/ai/module-human-handoffs';
import {executeCanonicalSpecialist,compactSpecialistWork} from '../lib/ai/module-specialists';
import {MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';
import {assistantSourceDigest} from '../lib/ai/assistant-disclosure';
import type {SessionContext,Tx} from '../db/client';
import {ConversationReviewLinks} from '../components/assistant/conversation-review-links';
const ctx:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user',personId:'fictional-person',roles:['employee'],grants:[{role:'employee',companyId:null}]},jobId='00000000-0000-4000-8000-000000000001';
async function issued(module:AgentModuleCode='employees',humanActions:unknown=moduleHumanActionHandoffs(module)){
 const data=module==='employees'?{rows:[{employeeCode:'PRIVATE-RECORD',company:'PRIVATE-COMPANY',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}:module==='payroll'?{rows:[{id:'00000000-0000-4000-8000-000000000002',payPeriod:'2026-01',company:'PRIVATE-COMPANY',gross:'100.00',deductions:'0.00',net:'100.00',currency:'MYR',runType:'regular',runSeq:1}],truncated:false}:module==='claims'?{hasEmployment:true,claims:[],truncated:false}:module==='assistant'?{capabilities:[]}:{rows:[],truncated:false};
 const source={module,capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1],scope:'current-caller',data},configuration={kind:'canonical_specialist_v1' as const,module,playbook:'canonical_domain_v1' as const},assessment=executeCanonicalSpecialist(configuration,source),outcome={ok:true as const,...source,humanActions:humanActions==='omit'?undefined:humanActions,specialistWork:compactSpecialistWork(assessment,{mode:'baseline',version:0,configuration})};
 vi.mocked(readGovernedSpecialistToolResultTx).mockResolvedValue({outcome,assessment} as Awaited<ReturnType<typeof readGovernedSpecialistToolResultTx>>);
 // The owner contains each card's source replay in a SAVEPOINT. Replay itself is mocked above, so this
 // transaction double only runs the savepoint callback with itself; it grants and skips nothing.
 const savepointTx={transaction:async(run:(tx:Tx)=>Promise<unknown>)=>run(savepointTx as unknown as Tx)};
 return loadGovernedSpecialistToolJob(ctx,savepointTx as unknown as Tx,{module},jobId,assistantSourceDigest(outcome));
}
async function show(views:readonly CanonicalModuleJobView[],principal=ctx){return render(await ConversationReviewLinks({views,ctx:principal}));}
beforeEach(()=>{state.locale='en';vi.clearAllMocks();});afterEach(cleanup);
describe('current-source human review links',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('%s labels an actual returned handoff with existing review and module copy',async locale=>{
  state.locale=locale;const view=await issued(),shown=await show([view]),copy=copies[locale].assistant.workspace.jobs,link=screen.getAllByRole('link',{name:`${copy.reviewAction} — ${copy.module_employees}`})[0];expect(link.getAttribute('href')).toBe('/admin/personnel/import');expect(link.className).toContain('min-h-11');expect(link.className).toContain('focus-visible:ring-2');expect(shown.container.textContent).toContain(copy.humanReviewNote);expect(shown.container.textContent).not.toMatch(/PRIVATE-|submit automatically/i);expect(shown.container.querySelector('form')).toBeNull();
 });
 it('deduplicates exact module/route across issued views and duplicate action routes',async()=>{
  const employees=await issued(),again=await issued(),claims=await issued('claims');await show([employees,again,claims,claims]);const links=screen.getAllByRole('link');expect(links.map(link=>link.getAttribute('href'))).toEqual(['/admin/personnel/import','/assistant/compensation','/assistant/workforce-profile','/assistant/bank','/assistant/emergency-contacts','/assistant/family','/assistant/qualifications','/assistant/employee-drafts','/assistant/claims']);
 });
 it('rejects copied and cross-caller views before disclosing even another valid handoff',async()=>{
  const original=await issued();for(const input of [{views:[JSON.parse(JSON.stringify(original)) as CanonicalModuleJobView],principal:ctx},{views:[original],principal:{...ctx,userId:'other'}},{views:[original,JSON.parse(JSON.stringify(original)) as CanonicalModuleJobView],principal:ctx}]){const shown=await show(input.views,input.principal);expect(shown.container.textContent).toBe('');expect(screen.queryByRole('link')).toBeNull();shown.unmount();}
 });
 it('does not infer a link from the global catalogue when the actual read returned no handoff',async()=>{const view=await issued('employees','omit');const shown=await show([view]);expect(shown.container.textContent).toBe('');expect(screen.queryByRole('link')).toBeNull();});
 it('refuses foreign, parameterized or model-provided route metadata through the actual source owner',async()=>{
  for(const route of ['/assistant/claims','/admin/personnel/import?confirm=true','https://outside.invalid/effect','javascript:alert(1)']){const declared=moduleHumanActionHandoffs('employees'),view=await issued('employees',declared.map(row=>({...row,route})));expect(view.state).toBe('unavailable');const shown=await show([view]);expect(screen.queryByRole('link')).toBeNull();expect(shown.container.textContent).toBe('');shown.unmount();}
 });
 it('does not convert a genuine original-record link into a human action handoff',async()=>{const view=await issued('payroll','omit');expect(view.state).toBe('ready');if(view.state!=='ready')throw Error('Missing actual payroll fixture');expect(view.presentation.cards.some(card=>card.href?.startsWith('/me/payslip/')&&card.linkPurpose!=='human_review')).toBe(true);const shown=await show([view]);expect(screen.queryByRole('link')).toBeNull();expect(shown.container.textContent).toBe('');});
 it('returns no footer for an empty source set or a module without actual human-review cards',async()=>{
  for(const views of [[],[await issued('assistant')]]){const shown=await show(views);expect(screen.queryByRole('link')).toBeNull();expect(shown.container.textContent).toBe('');shown.unmount();}
 });
});
