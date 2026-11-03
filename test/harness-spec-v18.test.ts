/** Spec v18 (AI v2 Phase 1, the consolidation before the owner's approval packet): every line queued by slices 2 and 3,
 * the hr-new-hire fix (run 41588270355, -21) and the follow-up capability offer. The deterministic parts, one test per
 * rule: the version and its digest; each new line once, word for word, with nothing left of the text it replaces; the
 * instruction size; the fixed sensitive reply naming the private case route only where it is set up; and the catalogue
 * offered in code for an answer to the previous turn's numbered question (task memory's pending question), and only
 * then. v19 (the one further adjustment after run 41612993488) narrows the import line to an import whose mode is
 * prepare, with its page, and offers "add a new employee" as one employee's page or draft action; this file pins both.
 * Scripted model and fictional tools; no provider, no database. Whether a model follows the text is measured by the
 * scored evaluation (test/assistant-smart-eval.eval.test.ts). */
import {describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {HARNESS_TEST_ONLY,payViewNoteFor,routeReply,runTurn} from '../core/harness/runner';
import {DESTINATION_PURPOSE,PAY_VIEW_PAGES,PAY_VIEW_PURPOSE} from '../lib/product-context/destinations';
import {advanceMemory,CHOICE_QUESTION,emptyMemory,InMemoryTaskMemoryStore,memoryNote} from '../core/harness/memory';
import type {ToolBinding,ToolProvider} from '../core/harness/tools';
import {PRODUCT_CAPABILITIES_SPEC} from '../core/product-context/capability-catalogue';
import {PRIVATE_CASE_START_PATH} from '../core/private-case-route';
import {CAPABILITY_INTENT_REVISION} from '../lib/product-context/capability-intent';
import {fakeTools} from './harness-ratchet/fake-tools';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';

const employee:SessionContext={tenantId:'00000000-0000-4000-8000-0000000000aa',userId:'00000000-0000-4000-8000-0000000000bb',personId:'00000000-0000-4000-8000-0000000000cc',
 roles:['employee'],grants:[{role:'employee',companyId:null}]};
const SCOPE={companyId:'00000000-0000-4000-8000-0000000000dd',locale:'en'};
const instructions=HARNESS_SPEC.instructions as readonly string[];
const count=(pattern:RegExp)=>instructions.filter(line=>pattern.test(line)).length;
const line=(start:string)=>{const found=instructions.filter(row=>row.startsWith(start));expect(found,start).toHaveLength(1);return found[0];};

describe('spec v18',()=>{
 it('is version 20 (v19\'s defects fixed) with its digest recorded, and every earlier digest is kept',()=>{
  expect(HARNESS_SPEC.version).toBe(20);expect(HARNESS_SPEC_DIGESTS[20]).toBe(harnessSpecDigest());
  expect(HARNESS_SPEC_DIGESTS[20]).toBe('87f846496918cf773ce778eefb288b1a41bf4c518d8e1463b9aa4d91755bda04');
  expect(HARNESS_SPEC_DIGESTS[19]).toBe('44e9708772ac71c0fcdc29b117769b34424fb21f4d5e1f45d1a3fe4795046b7c');
  expect(HARNESS_SPEC_DIGESTS[18]).toBe('7802392d1738b72c2035ff25c2009c07e559c865ca4fb6cb3bb30493dfd99759');
  expect(HARNESS_SPEC_DIGESTS[17]).toBe('818c217a300e529088f03f66042c57dc00de21be787a802a60ed2cf84692e3a8');
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]);
 });
 it('adds under 1,500 characters of instructions to v17\'s 5,216 for the eight queued rules (v19: 6,673)',()=>{
  // v13 sent 6,148 characters and each model call slowed (run 41577698046); v18 folds slices 2 and 3 into 24 lines, the new
  // ones short because each tool's own description carries its detail.
  expect(instructions).toHaveLength(24);
  expect(instructions.join(' ').length).toBeLessThanOrEqual(6700);
 });
});

describe('the rules v18 folds in, one each',()=>{
 it('workforce metrics: workforce_metrics; a withheld group is never 0; overtime is hours and leave is days, never pay or money',()=>{
  expect(line('Headcount, joiners')).toBe('Headcount, joiners, leavers, turnover, overtime and leave liability come from workforce_metrics: a withheld group is too small to report, never 0; overtime is hours and leave is days, never pay or money.');
  expect(count(/workforce_metrics/)).toBe(1);
 });
 it('"Why?": the three explainers, their figures quoted exactly and only the causes they list; the pay rule names them as its one exception',()=>{
  expect(line('Why the person')).toBe('Why the person\'s own pay changed, a payslip deduction or a claim limit: call explain_pay_difference, explain_payslip_statutory or explain_claim_limit, quote its figures exactly and name only the causes it lists.');
  // The pay rule above it no longer contradicts the explainers.
  expect(line('Individual pay never reaches you')).toMatch(/^Individual pay never reaches you, so never give or estimate anyone's pay beyond what the explainers below show of the person's own payslips\. /);
  expect(instructions.findIndex(row=>row.startsWith('Individual pay'))).toBeLessThan(instructions.findIndex(row=>row.startsWith('Why the person')));
 });
 it('time off in lieu: its card; no credit or pay stated; no First Schedule agreement asked for, given or recorded',()=>{
  expect(line('Time off in lieu')).toBe('Time off in lieu is its card (toil.replacement.request): never state a credit or pay, or ask for, give or record a First Schedule agreement; only the person agrees, on the card.');
 });
 it('imports: prepare_import for an import whose mode is prepare, "Yes, I can import that here." with its page, the file never read, no row or value listed, nothing said imported',()=>{
  expect(line('An import whose mode is prepare')).toBe('An import whose mode is prepare is prepared with prepare_import: start "Yes, I can import that here.", ask for the file and link its import page. You never read the file: never list its rows or values or say anything was imported.');
  expect(count(/Yes, I can import that here/)).toBe(1);
 });
 it('approver decisions: the two decision actions; the request and the decision never the model\'s; several are listed and asked',()=>{
  expect(line('Approver decisions')).toBe('Approver decisions on claims or attendance are prepared with approvals.claim.decide or approvals.attendance.decide. Never choose the request or the decision: when several wait, list them numbered and ask.');
 });
 it('hr-new-hire: one new employee is its page or the draft action, never only an import; a listed employee-records option includes adding one; a numbered answer picks',()=>{
  expect(line('For "can you …?"')).toBe('For "can you …?", "can I …?" or a request that could mean several things this person can do (such as "help me import data"), call product_capabilities (with a kind or area if clear), never for facts or status. If their words point to one entry ("import my employees" or "import new hires" is the employee import), start with "Yes" and act on it without asking: its card, or its page. "Add a new employee" or "a new hire" is one employee: offer adding them on the employee page or activating a new-hire draft, never only an import. If several fit, start with "Yes, I can …" and ask one short question (mode clarify) numbering at most five, as listed (most common first; employee records include adding one employee), then "Something else"; never guess. An answer such as "2" or "the second one" picks that entry. If none fits, a setup task, even "can you help me set up …", gets short steps from product_guidance and its page; anything else is not available to them here.');
  // clarify is a mode the model may finish with, so the pending question is recorded.
  expect(HARNESS_SPEC.offer.finalModes).toContain('clarify');
 });
 it('private cases: the Feedback rule points to the case route, which the model never reads',()=>{
  expect(line('Feedback (/feedback)')).toBe('Feedback (/feedback) is product feedback to the software team. Never send anyone there about a person, their conduct, a workplace concern or a personal matter: for those, tell them to contact their HR team directly or, where product_destinations lists it, start a private case with HR, which you never read.');
 });
});

describe('the fixed sensitive reply (ADR-0173 §3)',()=>{
 it('names the private case form only where the route is set up for the caller, and never links it in the text (v20)',()=>{
  expect(HARNESS_SPEC.sensitive.contact).toEqual({label:'your HR team',caseRoute:'/me/cases/new'});
  expect(HARNESS_SPEC.sensitive.contact.caseRoute).toBe(PRIVATE_CASE_START_PATH);
  expect(routeReply(false)).toBe('For this, please contact your HR team directly. A person there can take it forward under your company\'s procedures; the AI Centre does not read it or act on it.');
  expect(routeReply()).toBe(routeReply(false));
  // v20: the route note under the reply carries the one link (components/ai-centre/conversation-reply.tsx).
  expect(routeReply(true)).toBe('For this, please contact your HR team directly, or start a private case with HR. A person there can take it forward under your company\'s procedures; the AI Centre does not read it or act on it.');
  expect(routeReply(true)).not.toContain('/me/cases/new');
 });
 it('names the AI Centre, not "the Assistant", in the route reply',()=>{
  expect(HARNESS_SPEC.sensitive.routeReply).not.toMatch(/Assistant/);expect(HARNESS_SPEC.sensitive.routeReply).toMatch(/the AI Centre/);
 });
 it('gives a routed turn with the route the link, without a model call, read or memory goal',async()=>{
  const {provider,dispatched}=fakeTools(),model=scriptedModel([]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:employee,conversationId:'conversation-v18-case',question:'I want to file a grievance against my manager.',scope:SCOPE,model,
   memory:new InMemoryTaskMemoryStore(),tools:provider,caseRouteAvailable:async()=>true});
  expect(result.reply).toBe(routeReply(true));expect(result.reply).not.toContain('](/me/cases/new)');expect(result.caseRoute).toBe(true);
  expect(model.requests).toEqual([]);expect(dispatched).toEqual([]);expect(result.memory.goal).toBeNull();
 });
});

/** A fictional product_capabilities binding beside fakeTools' own. */
function withCapabilities(base:ToolProvider):ToolProvider{
 const binding:ToolBinding={name:'product_capabilities',kind:'context',entity:'product_capability',spec:PRODUCT_CAPABILITIES_SPEC,identifierInputs:[],
  async run(){return{ok:true,content:{ok:true,entries:[],returnedRows:0,totalRows:0,note:'This person has nothing of this kind in the product.'}};}};
 return async(ctx,scope,actions)=>{const candidates=await base(ctx,scope,actions);return{...candidates,bindings:[...candidates.bindings,binding]};};
}
/** Two turns of one conversation; returns the tools each model call of the second turn was offered. */
async function followUp(first:Readonly<{question:string;final:ScriptStep}>|null,answer:string){
 const memory=new InMemoryTaskMemoryStore(),{provider}=fakeTools({}),tools=withCapabilities(provider),conversationId='conversation-v18-follow-up';
 let pending:string|null=null;
 if(first){
  const model=scriptedModel([first.final]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:employee,conversationId,question:first.question,scope:SCOPE,model,memory,tools});
  pending=result.memory.pendingQuestion;
 }
 const model=scriptedModel([{final:{reply:'Ok.',mode:'answer'}}]);
 const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:employee,conversationId,question:answer,scope:SCOPE,model,memory,tools});
 return{pending,offered:model.requests[0].tools.map(tool=>tool.name),traced:result.trace.offered,system:model.requests[0].messages[0].content};
}

describe('follow-up turns: the capability offer for an answer to the previous turn\'s numbered question',()=>{
 const asked={question:'I need some help with my leave',final:{final:{reply:'Yes, I can help. Which one?\n\n1. Apply for leave\n2. Cancel a leave request\n- Something else',mode:'clarify'}} as ScriptStep};
 it('records a clarify turn without a slot as a pending question, and the spec records the classifier revision',()=>{
  expect(HARNESS_SPEC.offer.capabilityIntentRevision).toBe(2);expect(CAPABILITY_INTENT_REVISION).toBe(2);
  const now=new Date('2026-11-03T02:00:00Z'),empty=emptyMemory(employee,'conversation-v18-unit',now);
  expect(advanceMemory(empty,{question:'help',reads:[],slot:null,mode:'clarify'},now).pendingQuestion).toBe(CHOICE_QUESTION);
  expect(advanceMemory(empty,{question:'help',reads:[],slot:'leave_type',mode:'clarify'},now).pendingQuestion).toBe('leave_type');
  expect(advanceMemory(empty,{question:'help',reads:[],slot:null,mode:'answer'},now).pendingQuestion).toBeNull();
  expect(HARNESS_SPEC.offer.finalSlots as readonly string[]).not.toContain(CHOICE_QUESTION);
  expect(memoryNote({...empty,pendingQuestion:CHOICE_QUESTION})).toBe('Task memory (advisory; records must still be read again): You last asked the person a question; their reply may answer it.');
  expect(memoryNote({...empty,pendingQuestion:'leave_type'})).toBe('Task memory (advisory; records must still be read again): You last asked the person to choose: leave_type.');
 });
 it('offers the catalogue for "2" or "the second one" after a numbered question',async()=>{
  for(const answer of ['2','the second one','2, cancel it']){
   const {pending,offered,traced,system}=await followUp(asked,answer);
   expect(pending,answer).toBe(CHOICE_QUESTION);
   expect(offered,answer).toContain('product_capabilities');expect(traced,answer).toContain('product_capabilities');
   expect(system,answer).toContain('You last asked the person a question; their reply may answer it.');
  }
 });
 it('does not offer it for the same answer with no question pending, or for an answer that is not a pick',async()=>{
  // A first turn that answered (no question), and no first turn at all.
  const answered=await followUp({question:'I need some help with my leave',final:{final:{reply:'You can apply on the leave page.',mode:'answer'}}},'2');
  expect(answered.pending).toBeNull();expect(answered.offered).not.toContain('product_capabilities');
  expect((await followUp(null,'2')).offered).not.toContain('product_capabilities');
  // A question pending, but the reply is a new fact question, not a pick.
  for(const answer of ['how much annual leave do I have?','2 days of annual leave next week']){
   const {offered}=await followUp(asked,answer);expect(offered,answer).not.toContain('product_capabilities');
  }
 });
 it('still never offers it on a gated turn, even as an answer to a pending question',async()=>{
  const {offered}=await followUp(asked,'2, Siti\'s leave balance import');
  expect(offered).not.toContain('product_capabilities');
 });
});

describe('the pay-view note says whose pay the page shows (v20, hr-salary)',()=>{
 const hrAdmin:SessionContext={tenantId:employee.tenantId,userId:'00000000-0000-4000-8000-0000000000ad',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:SCOPE.companyId}]};
 it('describes every pay-view page as other people\'s pay for payroll staff, never the person\'s own payslips',()=>{
  for(const href of PAY_VIEW_PAGES){
   expect(PAY_VIEW_PURPOSE[href],href).toMatch(/they administer/);expect(DESTINATION_PURPOSE[href],href).toMatch(/^Payroll staff: /);
   expect(PAY_VIEW_PURPOSE[href],href).not.toMatch(/^(?!.*not their own).*\btheir own payslips/);
  }
  expect(DESTINATION_PURPOSE['/payroll/individual-payslip']).toBe('Payroll staff: the payslip of any employee they administer, run by run. Not the signed-in person\'s own payslips (those are on /me/payslip).');
 });
 it('names the page with its purpose in the note for an HR administrator',()=>{
  const note=payViewNoteFor(hrAdmin,['/me/payslip','/payroll/individual-payslip'])!;
  expect(note).toBe('If they ask about this person\'s pay: they can already see it on [Individual Payslip](/payroll/individual-payslip), where they open the payslip of any employee they administer (not their own payslips). Say in one line that pay is not shown in chat and link that page.');
  expect(HARNESS_SPEC.payView.page).toContain('{purpose}');
 });
});
