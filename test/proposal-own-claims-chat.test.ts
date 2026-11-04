/** AI v2 W2 — own claims prepared in chat (`claims.submit`, `claims.cancel`) on fictional data, over the real owners:
 * the chat preparer resolves the model's details against the caller's own claim catalogue and asks one question when
 * something is missing, seals a draft or cancellation review and issues a signed proposal; Confirm acts only on an
 * explicit Confirm, through the review custody and the claims service, which re-checks its limits then; a tampered or
 * someone else's proposal is refused. Next request cookies/locale/cache are framework seams; identity SQL, custody,
 * RLS and claim effects are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,locale:'en'}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>browser.locale}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import {getBrowserCommandSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {createClaimType,dateMinusDays,decideClaim,setClaimPolicy,submitClaim} from '../packs/claims/service';
import {verifyProposal,type Proposal} from '../core/proposals/proposal';
import {prepareChatClaimSubmitProposal} from '../core/proposals/claim-submit';
import {prepareChatClaimCancelProposal} from '../core/proposals/claim-cancel';
import {prepareSuggestedProposal} from '../core/proposals/suggested';
import {confirmOwnChangeProposal,editOwnChangeProposal} from '../core/assistant-actions/own-change-proposal-confirm';
import {confirmOwnChangeProposalAction,editOwnChangeProposalAction} from '../app/assistant/own-change-proposal-actions';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={uid:string;employmentId:string;personId:string};
let base:Base,claimant:Person,colleague:Person,travelId:string,mealId:string,yesterday:string,earlier:string;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
const group=()=>({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]});
async function hire(name:string):Promise<Person>{
 const hired=await hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:dateMinusDays(todayInKualaLumpur(),30)});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(group(),{appUserId:uid});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-own-claim-chat-storage-master-key');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');await setModule(base.tenantId,'claims','active');
 // Two types, so a type the model leaves out or garbles is a real choice; a per-claim cap the service enforces.
 mealId=(await createClaimType(group(),{code:'FIC-MEAL',name:'Fictional Meal',defaultTaxable:false,requiresReceipt:false})).id;
 travelId=(await createClaimType(group(),{code:'FIC-TRAVEL',name:'Fictional Travel',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(group(),{claimTypeId:travelId,annualBudget:500,perClaimCap:100,effectiveFrom:dateMinusDays(todayInKualaLumpur(),60)});
 claimant=await hire('Fictional Claim Chat Owner');colleague=await hire('Fictional Claim Chat Colleague');
 // A past date in Kuala Lumpur is never ahead of the claims service's own UTC "today".
 yesterday=dateMinusDays(todayInKualaLumpur(),1);earlier=dateMinusDays(todayInKualaLumpur(),2);
 browser.selected=claimant.uid;browser.locale='en';vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caller=()=>getBrowserCommandSession();
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
async function counts(){const [row]=await owner.db.execute<{claims:number;pending:number;drafts:number;cancelled:number;reviews:number}>(sql`select
 (select count(*)::int from claim_request where tenant_id=${base.tenantId}::uuid) as claims,
 (select count(*)::int from claim_request where tenant_id=${base.tenantId}::uuid and status='pending') as pending,
 (select count(*)::int from claim_request where tenant_id=${base.tenantId}::uuid and status='draft') as drafts,
 (select count(*)::int from claim_request where tenant_id=${base.tenantId}::uuid and status='cancelled') as cancelled,
 (select count(*)::int from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid and state='awaiting_confirmation') as reviews`);return row;}
async function chat(details:Record<string,string>,words:string):Promise<Proposal>{
 const outcome=await prepareChatClaimSubmitProposal(await caller(),details,words);
 if(outcome?.kind!=='proposal')throw Error('Fictional chat claim was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}

describe('claims.submit: missing or unclear details get one question, and nothing is prepared',()=>{
 it('asks for the claim type with the caller\'s own catalogue numbered, and for an amount the person did not state',async()=>{
  const before=await counts();
  expect(await prepareChatClaimSubmitProposal(await caller(),{amount:'42.60',incurredOn:yesterday},'Claim RM42.60 for yesterday please')).toMatchObject(
   {kind:'ask',missing:['claimType'],options:[{option:1,claimType:'Fictional Meal'},{option:2,claimType:'Fictional Travel'}]});
  // The model's amount counts only when the person's own words state it.
  expect(await prepareChatClaimSubmitProposal(await caller(),{claimType:'travel',amount:'42.60',incurredOn:yesterday},'Claim my taxi from yesterday')).toMatchObject(
   {kind:'ask',missing:['amount'],options:[]});
  expect(await prepareChatClaimSubmitProposal(await caller(),{claimType:'travel',amount:'42.60'},'Claim RM42.60 for a taxi')).toMatchObject({kind:'ask',missing:['incurredOn']});
  // A number counts only when the person said it.
  expect(await prepareChatClaimSubmitProposal(await caller(),{claimType:'2',amount:'42.60',incurredOn:yesterday},'RM42.60 yesterday')).toMatchObject({kind:'ask',missing:['claimType']});
  const answered=await prepareChatClaimSubmitProposal(await caller(),{claimType:'2',amount:'42.60',incurredOn:yesterday},'Number 2, RM42.60 yesterday');
  expect(answered?.kind==='proposal'&&answered.proposal.body.what.selectors.claimTypeId).toBe(travelId);
  expect(await counts()).toEqual({...before,reviews:before.reviews+1});
 });
});

describe('claims.submit: prepared, then submitted only on Confirm through the claims service',()=>{
 it('prepares a signed card from the claims service\'s own normalisation and saves no claim until Confirm',async()=>{
  const before=await counts();
  const proposal=await chat({claimType:'Fictional Travel',amount:'42.6',incurredOn:yesterday,description:'Taxi to the fictional client'},
   'Please claim RM42.6 for my taxi yesterday, taxi to the fictional client');
  expect(proposal.body).toMatchObject({what:{action:'claims.submit',effect:'create',selectors:{incurredOn:yesterday,claimTypeId:travelId}},
   forWhom:{subject:'own_employment',subjectId:claimant.employmentId},authority:{kind:'person',userId:claimant.uid,personId:claimant.personId},
   review:{route:'/assistant/claims'},facts:{claimType:'Fictional Travel',incurredOn:yesterday,amount:'42.60',outcome:'claim_submitted_if_checks_pass'}});
  expect(proposal.body.checks.map(check=>[check.check,check.result])).toEqual([['actor_current','pass'],['ai_controls_unpaused','pass'],['claim_type_available','pass'],['claim_draft_reviewed','pass'],['receipt_attached','pass']]);
  expect(verifyProposal(proposal,await caller(),new Date()).ok).toBe(true);
  // The description stays in the sealed review, never on the proposal; nothing is saved or submitted.
  expect(JSON.stringify(proposal)).not.toMatch(/fictional client/i);
  expect(await counts()).toEqual({...before,reviews:before.reviews+1});
  for(const confirm of [undefined,false,'true',1])expect(await confirmOwnChangeProposal(await caller(),{proposal,confirm})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await counts()).toMatchObject({claims:0});

  const submitted=await confirmOwnChangeProposalAction({proposal,confirm:true});
  if(submitted.kind!=='submitted')throw Error('Fictional confirmation refused: '+JSON.stringify(submitted));
  const [record]=await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id,submitted.claimId));
  expect({employment:record.employmentId,type:record.claimTypeId,amount:record.amount,incurredOn:String(record.incurredOn),status:record.status,description:record.description})
   .toEqual({employment:claimant.employmentId,type:travelId,amount:'42.60',incurredOn:yesterday,status:'pending',description:'Taxi to the fictional client'});
  const events=await owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,submitted.claimId),eq(schema.domainEvent.eventType,'claim-request.submitted')));
  expect(events).toHaveLength(1);
  // Confirming again replays the same claim; nothing is submitted twice.
  expect(await confirmOwnChangeProposal(await caller(),{proposal,confirm:true})).toEqual(submitted);
  expect(await counts()).toMatchObject({claims:1,pending:1});
 });
 it('keeps a description only when it is the person\'s own words',async()=>{
  const proposal=await chat({claimType:'travel',amount:'15',incurredOn:yesterday,description:'client dinner with the board'},'Claim RM15 travel for yesterday');
  const done=await confirmOwnChangeProposal(await caller(),{proposal,confirm:true});if(done.kind!=='submitted')throw Error('refused '+JSON.stringify(done));
  const [record]=await owner.db.select({description:schema.claimRequest.description,amount:schema.claimRequest.amount}).from(schema.claimRequest).where(eq(schema.claimRequest.id,done.claimId));
  expect(record).toEqual({description:null,amount:'15.00'});
 });
 it('re-checks the claims service at Confirm: over the per-claim cap submits nothing and returns the service\'s own reason',async()=>{
  // Drafts are not limit-checked, so the card is prepared; the claims service refuses when the person confirms.
  const proposal=await chat({claimType:'travel',amount:'150',incurredOn:yesterday},'Claim RM150 travel from yesterday');
  expect(proposal.body.facts).toMatchObject({amount:'150.00'});
  const refused=await confirmOwnChangeProposal(await caller(),{proposal,confirm:true});
  expect(refused).toMatchObject({kind:'refused',reason:'service_refused',message:expect.stringMatching(/per-claim cap/),href:expect.stringMatching(/^\/claims\?draft=[0-9a-f-]{36}$/)});
  // Nothing was submitted; the person's entries stay as a draft to fix on Claims, as the claim form does.
  expect(await counts()).toMatchObject({claims:1,pending:0,drafts:1});
 });
 it('refuses a tampered or someone else\'s proposal, and saves nothing',async()=>{
  const proposal=await chat({claimType:'travel',amount:'42.60',incurredOn:yesterday},'Claim RM42.60 travel for yesterday');
  const forged=clone(proposal);forged.body.facts!.amount='4.26';
  expect(await confirmOwnChangeProposal(await caller(),{proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  const retargeted=clone(proposal);retargeted.body.forWhom.subjectId=colleague.employmentId;
  expect(await confirmOwnChangeProposal(await caller(),{proposal:retargeted,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  browser.selected=colleague.uid;
  expect(await confirmOwnChangeProposalAction({proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await editOwnChangeProposalAction({proposal})).toEqual({ok:false,reason:'authority_mismatch'});
  expect(await counts()).toMatchObject({claims:0});
 });
 it('Edit reopens the sealed review as the caller and opens its review page with every entry filled in',async()=>{
  const proposal=await chat({claimType:'travel',amount:'42.60',incurredOn:yesterday},'Claim RM42.60 travel for yesterday');
  expect(await editOwnChangeProposal(await caller(),proposal)).toEqual({ok:true,href:proposal.body.review.href});
  expect(proposal.body.review.href).toBe('/assistant/claims?review='+proposal.body.review.reference);
  expect(await counts()).toMatchObject({claims:0});
 });
 it('runs through the suggestion path the harness uses',async()=>{
  const outcome=await prepareSuggestedProposal(await caller(),'claims.submit',{claimType:'travel',amount:'42.60',incurredOn:yesterday},'Claim RM42.60 travel for yesterday');
  expect(outcome?.kind).toBe('proposal');
 });
});

describe('claims.cancel: one of the caller\'s own pending claims',()=>{
 const file=async(amount:number,incurredOn:string)=>(await submitClaim(await caller(),{employmentId:claimant.employmentId,claimTypeId:travelId,amount,incurredOn,hasReceipt:false})).id;
 it('prepares the one pending claim, cancels it only on Confirm, and refuses someone else',async()=>{
  const id=await file(20,yesterday),before=await counts();
  const outcome=await prepareChatClaimCancelProposal(await caller(),{});
  if(outcome?.kind!=='proposal')throw Error('not prepared: '+JSON.stringify(outcome));
  const proposal=outcome.proposal;
  expect(proposal.body).toMatchObject({what:{action:'claims.cancel',effect:'withdraw'},facts:{claimType:'Fictional Travel',incurredOn:yesterday,amount:'20.00',outcome:'claim_cancelled_now'},
   review:{route:'/assistant/claims',href:'/assistant/claims?flow=cancel&review='+proposal.body.review.reference}});
  expect(await counts()).toEqual({...before,reviews:before.reviews+1});
  expect(await confirmOwnChangeProposal(await caller(),{proposal,confirm:false})).toEqual({kind:'refused',reason:'not_confirmed'});
  browser.selected=colleague.uid;
  expect(await confirmOwnChangeProposalAction({proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  browser.selected=claimant.uid;
  expect(await counts()).toMatchObject({pending:1,cancelled:0});
  expect(await confirmOwnChangeProposalAction({proposal,confirm:true})).toEqual({kind:'cancelled',action:'claims.cancel',claimId:id});
  const [record]=await owner.db.select({status:schema.claimRequest.status}).from(schema.claimRequest).where(eq(schema.claimRequest.id,id));
  expect(record.status).toBe('cancelled');
 });
 it('asks which claim when several are pending, and a date picks one',async()=>{
  await file(20,yesterday);const second=await file(30,earlier);
  const asked=await prepareChatClaimCancelProposal(await caller(),{});
  expect(asked).toMatchObject({kind:'ask',missing:['claim']});
  expect(asked?.kind==='ask'&&asked.options.map(row=>[row.incurredOn,row.amount]).sort()).toEqual([[earlier,'30.00'],[yesterday,'20.00']].sort());
  const picked=await prepareChatClaimCancelProposal(await caller(),{incurredOn:earlier});
  expect(picked?.kind==='proposal'&&picked.proposal.body.facts).toMatchObject({incurredOn:earlier,amount:'30.00'});
  if(picked?.kind!=='proposal')throw Error('not prepared');
  expect(await confirmOwnChangeProposal(await caller(),{proposal:picked.proposal,confirm:true})).toEqual({kind:'cancelled',action:'claims.cancel',claimId:second});
 });
 it('re-checks at Confirm: a claim approved since the card is not cancelled',async()=>{
  const id=await file(20,yesterday);
  const outcome=await prepareChatClaimCancelProposal(await caller(),{});if(outcome?.kind!=='proposal')throw Error('not prepared');
  await decideClaim(group(),{claimRequestId:id,decision:'approve'});
  expect(await confirmOwnChangeProposal(await caller(),{proposal:outcome.proposal,confirm:true})).toMatchObject({kind:'refused'});
  const [record]=await owner.db.select({status:schema.claimRequest.status}).from(schema.claimRequest).where(eq(schema.claimRequest.id,id));
  expect(record.status).toBe('approved');
 });
});
