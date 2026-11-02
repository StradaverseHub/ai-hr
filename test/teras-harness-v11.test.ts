/** Spec v11 — the scored evaluation's three design findings (noveri-model-comparison-20261103), with a scripted model and
 * fictional tools (no database, no provider):
 *  1. the caller is described from their own roles and grants, and that description changes nothing they are offered;
 *  2. "prepared … for you to review and confirm" passes only when the turn issued a proposal, and every claim that a
 *     change was submitted, approved, closed or done is still refused;
 *  3. a turn about another person tells a caller with payroll access where they already see pay (the destination
 *     registry), says so to a partner with no such page, and leaves every other caller's turn as it was.
 * The native provider's offers per role are proven over the real owners in test/teras-harness.test.ts. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {HARNESS_SPEC} from '../core/harness/spec';
import {HARNESS_TEST_ONLY,payViewNoteFor,roleNoteFor,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {checkReply,overclaim} from '../core/harness/reply-checks';
import type {ToolProvider} from '../core/harness/tools';
import {issueProposal} from '../core/proposals/proposal';
import {linkablePathsFor,payViewDestinationFor} from '../lib/product-context/destinations';
import {FICTIONAL,fakeTools} from './harness-ratchet/fake-tools';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';

const TENANT='00000000-0000-4000-8000-0000000000aa',C1='00000000-0000-4000-8000-0000000000c1',C2='00000000-0000-4000-8000-0000000000c2';
const person=(roles:string[],grants:{role:string;companyId:string|null}[]):SessionContext=>({tenantId:TENANT,userId:'00000000-0000-4000-8000-0000000000bb',
 personId:'00000000-0000-4000-8000-0000000000cc',roles,grants});
const CALLERS={
 employee:person(['employee'],[{role:'employee',companyId:null}]),
 manager:person(['manager'],[{role:'manager',companyId:null}]),
 hrAdmin:person(['hr_admin'],[{role:'hr_admin',companyId:C1}]),
 hrAdminTwo:person(['hr_admin'],[{role:'hr_admin',companyId:C1},{role:'hr_admin',companyId:C2}]),
 groupAdmin:person(['hr_admin'],[{role:'hr_admin',companyId:null}]),
 superAdmin:person(['super_admin'],[{role:'super_admin',companyId:null}]),
 payroll:person(['payroll_partner'],[{role:'payroll_partner',companyId:C1}]),
 payrollTwo:person(['payroll_partner'],[{role:'payroll_partner',companyId:C1},{role:'payroll_partner',companyId:C2}]),
 managerPayroll:person(['manager','payroll_partner'],[{role:'manager',companyId:null},{role:'payroll_partner',companyId:C1}]),
} as const;
const R=HARNESS_SPEC.roleNote,SCOPE={companyId:C1,locale:'en'};
afterEach(()=>{vi.unstubAllEnvs();});

const withDestinations=(provider:ToolProvider,destinations:readonly string[]):ToolProvider=>async(ctx,scope,actions)=>({...await provider(ctx,scope,actions),destinations});
async function turn(ctx:SessionContext,question:string,script:readonly ScriptStep[],options:{destinations?:readonly string[];locale?:string;provider?:ToolProvider}={}){
 const fake=fakeTools({admin:ctx.roles?.includes('hr_admin')||ctx.roles?.includes('super_admin')});
 const base=options.provider??fake.provider,tools=options.destinations?withDestinations(base,options.destinations):base,model=scriptedModel(script);
 const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:'conversation-v11',question,scope:{...SCOPE,locale:options.locale??'en'},model,memory:new InMemoryTaskMemoryStore(),tools});
 return{result,model,dispatched:fake.dispatched,system:String(model.requests[0]?.messages[0]?.content??'')};
}

describe('defect 1: the caller is described from their roles and grants',()=>{
 it('gives each role its own description, with the companies its grants cover',()=>{
  const payroll=(scope:string)=>'They manage payroll for '+scope+': payroll runs and the payroll actions available_actions lists are theirs to work on.';
  const admin=(scope:string)=>'They are an HR administrator for '+scope+': they configure the system themselves, so give them the steps and use setup_readiness for what is already configured or blocking.';
  const expected:Record<keyof typeof CALLERS,string[]>={
   employee:[R.employee,R.tools],
   manager:[R.employee,R.manager,R.tools],
   hrAdmin:[R.employee,admin('their company'),R.tools],
   hrAdminTwo:[R.employee,admin('2 companies'),R.tools],
   groupAdmin:[R.employee,R.groupAdmin,R.tools],
   superAdmin:[R.employee,R.groupAdmin,R.tools],
   payroll:[R.employee,payroll('their company'),R.tools],
   payrollTwo:[R.employee,payroll('2 companies'),R.tools],
   managerPayroll:[R.employee,payroll('their company'),R.manager,R.tools],
  };
  for(const [name,ctx] of Object.entries(CALLERS))expect(roleNoteFor(ctx),name).toBe(expected[name as keyof typeof CALLERS].join(' '));
  // The sentence that made stronger models refuse managers' and payroll partners' work is gone for everyone.
  for(const ctx of Object.values(CALLERS))expect(roleNoteFor(ctx)).not.toMatch(/only their own records/);
  // A roles-only session is group-wide, as the database treats it (withEffectiveGrants, db/client withTenant); a login
  // without an employee record is not called an employee.
  expect(roleNoteFor({tenantId:TENANT,personId:'00000000-0000-4000-8000-0000000000cc',roles:['hr_admin']})).toBe([R.employee,R.groupAdmin,R.tools].join(' '));
  expect(roleNoteFor({...CALLERS.groupAdmin,personId:null})).toBe([R.noRecord,R.groupAdmin,R.tools].join(' '));
  // Only administrators are pointed at setup_readiness, the administrator-only context tool.
  for(const name of ['employee','manager','payroll','payrollTwo','managerPayroll'] as const)expect(roleNoteFor(CALLERS[name]),name).not.toContain('setup_readiness');
 });
 it('changes nothing a caller is offered: the same tools, and the role note is the only difference in what is sent',async()=>{
  for(const question of ['who in my team has leave coming up?','close the September payroll','How much leave do I have?']){
   const runs=await Promise.all(Object.entries(CALLERS).map(async([name,ctx])=>({name,ctx,...await turn(ctx,question,[{final:{reply:'Ok.'}}])})));
   const reference=runs.find(run=>run.name==='employee')!;
   const offered=(run:typeof reference)=>run.model.requests[0].tools.map(tool=>tool.name);
   for(const run of runs){
    // Administrators hold two more context tools from the provider itself (fakeTools admin), as before v11.
    const expectedOffer=offered(reference).filter(name=>name!=='final_answer').concat(run.ctx.roles?.some(role=>role==='hr_admin'||role==='super_admin')?['setup_readiness','company_setup']:[]).sort();
    expect(offered(run).filter(name=>name!=='final_answer').sort(),run.name+': '+question).toEqual(expectedOffer);
    expect(run.result.trace.offered.slice().sort(),run.name).toEqual(expectedOffer);
    expect(run.system.replace(roleNoteFor(run.ctx),'<caller>'),run.name).toBe(reference.system.replace(roleNoteFor(reference.ctx),'<caller>'));
    expect(run.system,run.name).toContain(roleNoteFor(run.ctx));
   }
  }
 });
});

describe('defect 2: prepared wording only for a card this turn prepared',()=>{
 const READY="I've prepared your annual leave application for you to review and confirm.";
 it('admits exactly that wording only with a proposal, and refuses every claim of a finished change either way',()=>{
  expect(overclaim(READY)).toBe("I've prepared your");
  expect(overclaim(READY,{prepared:true})).toBeNull();
  expect(overclaim('Your leave request has been prepared for you to check.',{prepared:true})).toBeNull();
  for(const claim of ['I have submitted your leave request.','Your claim has been approved for you.','I\'ve closed the September payroll run for you.',
   'Done. I\'ve prepared it for you to confirm.','I\'ve prepared your leave for you to review, and your claim has been approved for you.',
   'Your payroll has been closed for you to review.','I have approved the request for you to review.']){
   expect(overclaim(claim,{prepared:true}),claim).not.toBeNull();expect(overclaim(claim),claim).not.toBeNull();
  }
  // "Prepared" without the review wording is still a claim, card or not.
  expect(overclaim('I\'ve prepared the payroll close.',{prepared:true})).not.toBeNull();
  const order=HARNESS_SPEC.replyChecks.order,allowed=new Set<string>();
  expect(checkReply(READY,allowed,order,{prepared:true}).every(row=>row.ok)).toBe(true);
  expect(checkReply(READY,allowed,order).find(row=>row.check==='overclaim')).toEqual({check:'overclaim',ok:false});
 });
 it('keeps a prepared-card reply when the turn issued a proposal, and retries it when only a pointer was suggested',async()=>{
  vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-secret-of-32-bytes!');
  const ctx=CALLERS.employee,now=new Date();
  const proposal=issueProposal({what:{action:'leave.apply',contractVersion:1,entity:'leave_request',effect:'create',selectors:{date:'2026-11-20'},reviewedDigest:'a'.repeat(64)},
   forWhom:{tenantId:TENANT,subject:'own_employment',subjectId:FICTIONAL.ownEmployment},authority:{kind:'person',tenantId:TENANT,userId:ctx.userId!,personId:ctx.personId!},
   checks:[{check:'actor_current',owner:'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx',ruleVersion:null,result:'pass'}],
   review:{route:'/assistant/leave',href:'/assistant/leave?review=00000000-0000-4000-8000-000000000001',reference:'00000000-0000-4000-8000-000000000001'},
   createdAt:new Date(now.getTime()-60_000).toISOString(),expiresAt:new Date(now.getTime()+3_600_000).toISOString()});
  const suggestion={action:'leave.apply',reviewRoute:'/assistant/leave',inlineCard:true};
  const prepared=fakeTools({outputs:{suggest_action:()=>({ok:true,content:{suggested:true,...suggestion,note:'A review item is ready; the person checks and confirms it on the review page. Nothing is submitted until they do.'},suggestion,proposal})}});
  const script:ScriptStep[]=[{calls:[{name:'suggest_action',args:{action:'leave.apply',details:{leaveType:'Annual Leave',startDate:'2026-11-20',endDate:'2026-11-20'}}}]},
   {final:{reply:'Yes, I can. '+READY,mode:'propose'}},{final:{reply:'Yes, I can. Use the card to review and confirm it.',mode:'propose'}}];
  const withCard=await turn(ctx,'apply annual leave on 20 November',script,{provider:prepared.provider});
  expect(withCard.result.trace.checks.map(row=>row.results.filter(check=>!check.ok).map(check=>check.check))).toEqual([[]]);
  expect(withCard.result.reply).toBe('Yes, I can. '+READY);expect(withCard.result.proposals.map(row=>row.body.id)).toContain(proposal.body.id);
  // fakeTools' own suggest_action is a pointer (no proposal): the same words are an overclaim, retried with the spec's note.
  const pointer=await turn(ctx,'apply annual leave on 20 November',script);
  expect(pointer.result.suggestion?.action).toBe('leave.apply');expect(pointer.result.proposals).toEqual([]);
  expect(pointer.result.trace.checks.map(row=>row.results.filter(check=>!check.ok).map(check=>check.check))).toEqual([['overclaim'],[]]);
  expect(pointer.model.requests[2].messages.at(-1)).toEqual({role:'system',content:HARNESS_SPEC.retryNotes.overclaim});
  expect(pointer.result.reply).toBe('Yes, I can. Use the card to review and confirm it.');
 });
});

describe('defect 3: a pay refusal points where this caller already sees pay',()=>{
 const PAYROLL_PAGES=['/leave','/me/payslip','/payroll','/payroll/transaction-view','/payroll/individual-payslip'];
 const asked="what is Ravi's salary?",refusal=[{final:{reply:'Pay is not shown in chat; you can see it on [Individual Payslip](/payroll/individual-payslip).',mode:'refuse'}}] as const;
 it('names the per-person payslip page to an administrator, from their own destinations, with no read and no figure',async()=>{
  const {result,model,system,dispatched}=await turn(CALLERS.hrAdmin,asked,refusal,{destinations:PAYROLL_PAGES});
  expect(result.trace.gate.reason).toBe('other_person');
  expect(system).toContain(HARNESS_SPEC.payView.page.replace('{label}','Individual Payslip').replace('{href}','/payroll/individual-payslip'));
  expect(system).not.toContain(HARNESS_SPEC.payView.none);
  // The gate still closes every private read: only product context and suggestions are offered, and nothing ran.
  expect(model.requests[0].tools.map(tool=>tool.name).filter(name=>!['product_destinations','product_guidance','available_actions','suggest_action','final_answer'].includes(name))).toEqual([]);
  expect(dispatched).toEqual([]);expect(result.reads).toEqual([]);
  // The named page passes the destination check first time.
  expect(result.trace.checks).toHaveLength(1);expect(result.trace.checks[0].results.every(row=>row.ok)).toBe(true);
  expect(result.reply).toBe(refusal[0].final.reply);
  // In the person's language, and the workbench when the per-person pages are not theirs.
  expect((await turn(CALLERS.groupAdmin,asked,refusal,{destinations:PAYROLL_PAGES,locale:'ms'})).system).toContain('[Slip Gaji Individu](/payroll/individual-payslip)');
  expect((await turn(CALLERS.hrAdmin,asked,refusal,{destinations:['/leave','/me/payslip','/payroll']})).system).toContain('[Payroll Process](/payroll)');
 });
 it('tells a payroll partner with no such page who can help, and leaves an employee or manager turn as before v11',async()=>{
  const partner=await turn(CALLERS.payroll,"what was Siti's net pay in September?",[{final:{reply:'Pay is not shown in chat; your HR administrator can help.',mode:'refuse'}}]);
  expect(partner.result.trace.gate.reason).toBe('other_person');
  expect(partner.system).toContain(HARNESS_SPEC.payView.none);expect(partner.system).not.toContain('](/payroll');
  for(const ctx of [CALLERS.employee,CALLERS.manager]){
   // Even a destination list holding payroll pages adds nothing for a caller without payroll access.
   const {system,result}=await turn(ctx,asked,refusal,{destinations:PAYROLL_PAGES});
   expect(result.trace.gate.reason).toBe('other_person');
   expect(system).not.toContain(HARNESS_SPEC.payView.none);expect(system).not.toContain('If they ask about this person\'s pay');
  }
  // A turn about the caller's own records carries no pay-view note, administrator or not.
  expect((await turn(CALLERS.hrAdmin,'How much leave do I have?',[{final:{reply:'Ok.'}}],{destinations:PAYROLL_PAGES})).system).not.toContain('If they ask about this person\'s pay');
  expect(payViewNoteFor(CALLERS.employee,PAYROLL_PAGES)).toBeNull();expect(payViewNoteFor(CALLERS.manager,PAYROLL_PAGES)).toBeNull();
 });
 it('takes the page only from the registry paths this caller may link',()=>{
  // The registry's own linkable paths: an administrator has the per-person payslip page; a payroll partner has no
  // payroll page (they are requireAdmin or scopedAdmin pages), so nothing is named and nothing is widened.
  expect(payViewDestinationFor(CALLERS.hrAdmin,linkablePathsFor(CALLERS.hrAdmin,['payroll']))?.href).toBe('/payroll/individual-payslip');
  expect(linkablePathsFor(CALLERS.payroll,['payroll']).filter(path=>path.startsWith('/payroll'))).toEqual([]);
  expect(payViewDestinationFor(CALLERS.payroll,linkablePathsFor(CALLERS.payroll,['payroll']))).toBeNull();
  expect(payViewDestinationFor(CALLERS.employee,PAYROLL_PAGES)).toBeNull();
  expect(payViewDestinationFor(CALLERS.hrAdmin,['/me/payslip'])).toBeNull();
 });
});

describe('spec v11 instructions',()=>{
 const instructions=HARNESS_SPEC.instructions.join(' ');
 it('no longer contradicts itself about preparing',()=>{
  expect(instructions).toMatch(/start with "Yes, I can …" and call suggest_action/);
  expect(instructions).toMatch(/never open with "I can't" when an action is listed/);
  expect(instructions).toMatch(/Only when its result says a review item is ready or a form is filled in, write "I've prepared … for you to review and confirm"/);
  expect(instructions).toMatch(/Never say anything is submitted, approved, closed or done/);
  expect(instructions).not.toMatch(/never say anything is prepared/i);
  expect(instructions).not.toMatch(/you prepare it here with them/);
  expect(HARNESS_SPEC.retryNotes.overclaim).not.toMatch(/without saying anything was prepared/);
 });
});
