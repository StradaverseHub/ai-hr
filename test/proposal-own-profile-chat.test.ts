/** AI v2 W2 — own profile changes prepared in chat (`ess.profile.request`) on fictional data, over the real owners: an
 * address, an emergency contact, a dependant and bank details become an ADR-0159 profile change request that HR
 * approves; nothing changes on the record at Confirm. A bank account number is read from the person's own words only,
 * goes into the sealed review only, and never reaches the model (asserted on what the scripted model was sent and on
 * the turn's own trace). Next request cookies/locale/cache are framework seams; identity SQL, custody, RLS and the
 * request owner are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
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
import {saveProfileEditPolicy} from '../core/profile-edit-policy';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import type {Proposal} from '../core/proposals/proposal';
import {PROFILE_CHANGE_FIELDS,prepareChatProfileChangeProposal} from '../core/proposals/profile-change';
import {confirmOwnChangeProposal,editOwnChangeProposal} from '../core/assistant-actions/own-change-proposal-confirm';
import {confirmOwnChangeProposalAction} from '../app/assistant/own-change-proposal-actions';
import {ownProfileEditSeed} from '../core/own-profile-edit-seed';
import {readOwnProfileWorkspace} from '../core/profile-edit';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {scriptedModel} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={uid:string;employmentId:string;personId:string};
let base:Base,employee:Person,colleague:Person;
const ACCOUNT='514012345678';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
const group=()=>({...adminCtx(base),grants:[{role:'hr_admin' as const,companyId:null}]});
async function hire(name:string):Promise<Person>{
 const hired=await hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(group(),{appUserId:uid});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-own-profile-chat-storage-master-key');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 // The company lets employees request these fields; each goes to HR for approval (the descriptors' own default).
 const keys=[...Object.values(PROFILE_CHANGE_FIELDS.address),...Object.values(PROFILE_CHANGE_FIELDS.emergency_contact),...Object.values(PROFILE_CHANGE_FIELDS.dependant),...Object.values(PROFILE_CHANGE_FIELDS.bank)];
 await saveProfileEditPolicy(group(),{keys,withdrawnReason:'Fictional chat profile policy'});
 employee=await hire('Fictional Profile Chat Owner');colleague=await hire('Fictional Profile Chat Colleague');
 await setStatutoryProfileMY(group(),{personId:employee.personId,icNumber:'900101015555',taxCategory:1,numChildren:0});
 browser.selected=employee.uid;browser.locale='en';vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caller=()=>getBrowserCommandSession();
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
async function state(){
 const requests=await owner.db.select({id:schema.profileChangeRequest.id,status:schema.profileChangeRequest.status,proposed:schema.profileChangeRequest.proposed}).from(schema.profileChangeRequest).where(eq(schema.profileChangeRequest.tenantId,base.tenantId));
 const [master]=await owner.db.select({line1:schema.person.permanentAddressLine1}).from(schema.person).where(eq(schema.person.id,employee.personId));
 const [reviews]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.assistant_own_leave_review where tenant_id=${base.tenantId}::uuid and state='awaiting_confirmation'`);
 return{requests,line1:master.line1,reviews:reviews.n};
}
async function chat(details:Record<string,string>,words:string):Promise<Proposal>{
 const outcome=await prepareChatProfileChangeProposal(await caller(),details,words);
 if(outcome?.kind!=='proposal')throw Error('Fictional chat profile change was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}
const ADDRESS_WORDS='Please change my home address to 12 Jalan Fiksyen, 50450 Kuala Lumpur';
const ADDRESS={change:'address',addressLine1:'12 Jalan Fiksyen',postcode:'50450',city:'Kuala Lumpur'};

describe('missing or unclear details: one question, nothing prepared',()=>{
 it('asks which change, and for an address line the person did not say',async()=>{
  const before=await state();
  expect(await prepareChatProfileChangeProposal(await caller(),{},'Update my details please')).toMatchObject({kind:'ask',missing:['change']});
  expect(await prepareChatProfileChangeProposal(await caller(),{change:'address'},'Change my address')).toMatchObject({kind:'ask',missing:['addressLine1']});
  expect(await prepareChatProfileChangeProposal(await caller(),{...ADDRESS,addressLine1:'99 Jalan Lain'},ADDRESS_WORDS)).toMatchObject({kind:'ask',missing:['addressLine1']});
  // The model never supplies a bank account: without one in the person's own words, it is asked for.
  expect(await prepareChatProfileChangeProposal(await caller(),{change:'bank',bankName:'Maybank',accountNumber:ACCOUNT},'Change my bank to Maybank')).toMatchObject({kind:'ask',missing:['accountNumber']});
  expect(await state()).toEqual(before);
 });
});

describe('an address change: sent to HR on Confirm, applied only when HR approves',()=>{
 it('prepares a signed card that carries no value, and requests nothing until Confirm',async()=>{
  const before=await state();
  const proposal=await chat(ADDRESS,ADDRESS_WORDS);
  expect(proposal.body).toMatchObject({what:{action:'ess.profile.request',effect:'create',selectors:{change:'address'}},
   forWhom:{subject:'own_employment',subjectId:employee.employmentId},authority:{kind:'person',userId:employee.uid,personId:employee.personId},
   review:{route:'/assistant/profile'},facts:{profileChange:'address',fieldCount:3,outcome:'hr_approval_required'}});
  expect(JSON.stringify(proposal)).not.toMatch(/Fiksyen|50450|Kuala Lumpur/);
  expect(await state()).toEqual({...before,reviews:before.reviews+1});
  expect(await confirmOwnChangeProposal(await caller(),{proposal,confirm:'yes'})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect((await state()).requests).toEqual([]);

  const requested=await confirmOwnChangeProposalAction({proposal,confirm:true});
  if(requested.kind!=='requested')throw Error('Fictional request refused: '+JSON.stringify(requested));
  const after=await state();
  expect(after.requests).toHaveLength(1);
  expect(after.requests[0]).toMatchObject({id:requested.requestId,status:'pending'});
  expect(JSON.stringify(after.requests[0].proposed)).toContain('12 Jalan Fiksyen');
  // Nothing on the record changes until HR approves.
  expect(after.line1).toBe(before.line1);
  expect(await confirmOwnChangeProposal(await caller(),{proposal,confirm:true})).toEqual(requested);
  expect((await state()).requests).toHaveLength(1);
  expect(await editOwnChangeProposal(await caller(),proposal)).toEqual({ok:true,href:'/me?tab=profile'});
 });
 it('re-checks the record at Confirm: a change since the card requests nothing',async()=>{
  const proposal=await chat(ADDRESS,ADDRESS_WORDS);
  await owner.db.update(schema.person).set({permanentAddressLine1:'1 Jalan Berubah'}).where(eq(schema.person.id,employee.personId));
  expect(await confirmOwnChangeProposal(await caller(),{proposal,confirm:true})).toMatchObject({kind:'refused'});
  expect((await state()).requests).toEqual([]);
 });
 it('refuses a tampered or someone else\'s proposal',async()=>{
  const proposal=await chat(ADDRESS,ADDRESS_WORDS);
  const forged=clone(proposal);forged.body.facts!.profileChange='bank';
  expect(await confirmOwnChangeProposal(await caller(),{proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  browser.selected=colleague.uid;
  expect(await confirmOwnChangeProposalAction({proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  browser.selected=employee.uid;
  expect((await state()).requests).toEqual([]);
 });
});

describe('Edit before Confirm: the profile form opens filled from the sealed review (slice 3 follow-up)',()=>{
 const seedFor=async(href:string)=>{const handle=new URL(href,'https://fixture.test').searchParams.get('profileSeed');const ctx=await caller();
  return ownProfileEditSeed(ctx,handle,await readOwnProfileWorkspace(ctx,{employmentId:employee.employmentId}));};
 it('an address: the link names only the review, and the page seeds the reviewed values for the caller alone',async()=>{
  const proposal=await chat(ADDRESS,ADDRESS_WORDS);
  const edit=await editOwnChangeProposal(await caller(),proposal);
  expect(edit).toEqual({ok:true,href:`/me?tab=profile&profileSeed=${proposal.body.review.reference}`});
  const href=(edit as {href:string}).href;
  expect(href).not.toMatch(/Fiksyen|50450|Kuala/);
  const F=PROFILE_CHANGE_FIELDS.address;
  expect(await seedFor(href)).toEqual({fields:{[F.addressLine1]:'12 Jalan Fiksyen',[F.postcode]:'50450',[F.city]:'Kuala Lumpur'},registers:[],withheld:[]});
  // Someone else's login with the same handle seeds nothing; nor does a review once it has gone to HR.
  browser.selected=colleague.uid;
  const other=await caller();
  expect(await ownProfileEditSeed(other,proposal.body.review.reference,await readOwnProfileWorkspace(other,{employmentId:colleague.employmentId}))).toBeNull();
  browser.selected=employee.uid;
  expect((await confirmOwnChangeProposal(await caller(),{proposal,confirm:true})).kind).toBe('requested');
  expect(await seedFor(href)).toBeNull();
  expect(await editOwnChangeProposal(await caller(),proposal)).toEqual({ok:true,href:'/me?tab=profile'});
 });
 it('bank details: the bank is filled in, the account number never is, in the link or the seed',async()=>{
  const outcome=await prepareChatProfileChangeProposal(await caller(),{change:'bank',bankName:'Maybank'},`Please change my bank account to Maybank ${ACCOUNT}`);
  if(outcome?.kind!=='proposal')throw Error('Fictional bank change was not prepared: '+JSON.stringify(outcome));
  const edit=await editOwnChangeProposal(await caller(),outcome.proposal);
  if(!edit.ok)throw Error('Fictional bank Edit refused');
  expect(edit.href).toBe(`/me?tab=bankStatutory&profileSeed=${outcome.proposal.body.review.reference}`);
  const seed=await seedFor(edit.href);
  expect(seed).toEqual({fields:{[PROFILE_CHANGE_FIELDS.bank.bankName]:'Maybank'},registers:[],withheld:[PROFILE_CHANGE_FIELDS.bank.accountNumber]});
  expect(JSON.stringify(seed)+edit.href).not.toContain(ACCOUNT);expect(JSON.stringify(seed)+edit.href).not.toContain(ACCOUNT.slice(-4));
  expect((await state()).requests).toEqual([]);
 });
 it('a dependant: a new record seeded under the review\'s own row',async()=>{
  const proposal=await chat({change:'dependant',dependantName:'Fictional Child',relationship:'son'},'Add my son Fictional Child as a dependant');
  const edit=await editOwnChangeProposal(await caller(),proposal);
  if(!edit.ok)throw Error('Fictional dependant Edit refused');
  expect(edit.href).toBe(`/me?tab=family&profileSeed=${proposal.body.review.reference}`);
  const F=PROFILE_CHANGE_FIELDS.dependant;
  expect(await seedFor(edit.href)).toEqual({fields:{},withheld:[],registers:[{kind:'dependent',id:null,clientId:'chat-dependant',values:{[F.relationship]:'child',[F.dependantName]:'Fictional Child'}}]});
 });
});

describe('bank details: HR verifies them, and the account number never reaches the model',()=>{
 it('reads the account from the person\'s own words into the sealed review only, and the model sees it removed',async()=>{
  const words=`Please change my bank account to Maybank ${ACCOUNT}`;
  let sent:unknown;
  const model=scriptedModel([{calls:[{name:'suggest_action',args:{action:'ess.profile.request',details:{change:'bank',bankName:'Maybank'}}}]},
   request=>{sent=request.messages;return{final:{reply:'I prepared this for you to review and confirm.',mode:'answer'}};}]);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx:await caller(),conversationId:randomUUID(),question:words,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  // Nothing the model was sent, on any call, carries the account number; the person's words reached it screened.
  const everything=JSON.stringify(model.requests);
  expect(everything).not.toContain(ACCOUNT);
  expect(JSON.stringify(sent)).toContain('[bank_account removed]');
  expect(result.trace.screening.question).toBeGreaterThanOrEqual(1);expect(result.trace.screening.kinds).toContain('bank_account');
  expect(JSON.stringify(result.trace)).not.toContain(ACCOUNT);
  expect(result.proposals).toHaveLength(1);
  const proposal=result.proposals[0];
  expect(proposal.body).toMatchObject({what:{action:'ess.profile.request'},facts:{profileChange:'bank',bankName:'Maybank',accountEnding:ACCOUNT.slice(-4),outcome:'hr_verification_required'}});
  expect(JSON.stringify(proposal)).not.toContain(ACCOUNT);
  expect((await state()).requests).toEqual([]);

  const requested=await confirmOwnChangeProposal(await caller(),{proposal,confirm:true});
  if(requested.kind!=='requested')throw Error('Fictional bank request refused: '+JSON.stringify(requested));
  const after=await state();
  // HR verifies it: the request waits for approval with the person's own number in it.
  expect(after.requests).toHaveLength(1);expect(after.requests[0].status).toBe('pending');
  expect(JSON.stringify(after.requests[0].proposed)).toContain(ACCOUNT);
  expect(await editOwnChangeProposal(await caller(),proposal)).toEqual({ok:true,href:'/me?tab=bankStatutory'});
 });
});

describe('an emergency contact and a dependant',()=>{
 it('adds the first emergency contact from the person\'s own words, with the phone read from them',async()=>{
  const proposal=await chat({change:'emergency_contact',contactName:'Fictional Aisha'},'Make Fictional Aisha my emergency contact, her number is 012-345 6789');
  expect(proposal.body.facts).toMatchObject({profileChange:'emergency_contact',outcome:'hr_approval_required'});
  expect(JSON.stringify(proposal)).not.toMatch(/Aisha|6789/);
  const requested=await confirmOwnChangeProposal(await caller(),{proposal,confirm:true});
  expect(requested.kind).toBe('requested');
  const [request]=(await state()).requests;
  expect(JSON.stringify(request.proposed)).toContain('Fictional Aisha');expect(JSON.stringify(request.proposed)).toContain('012-345 6789');
 });
 it('adds a dependant, with a date of birth only when the person named it',async()=>{
  expect(await prepareChatProfileChangeProposal(await caller(),{change:'dependant',dependantName:'Fictional Child',relationship:'son',dateOfBirth:'2020-05-01'},
   'Add my son Fictional Child as a dependant')).toMatchObject({kind:'ask',missing:['dateOfBirth']});
  const proposal=await chat({change:'dependant',dependantName:'Fictional Child',relationship:'son',dateOfBirth:'2020-05-01'},'Add my son Fictional Child, born 2020-05-01, as a dependant');
  expect(proposal.body.facts).toMatchObject({profileChange:'dependant',outcome:'hr_approval_required'});
  const requested=await confirmOwnChangeProposal(await caller(),{proposal,confirm:true});
  expect(requested.kind).toBe('requested');
  expect(await editOwnChangeProposal(await caller(),proposal)).toEqual({ok:true,href:'/me?tab=family'});
 });
});
