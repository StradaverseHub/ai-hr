/** AI v2 Phase 1, slice 3 — an own letter request prepared in chat ("I need an employment confirmation letter"), on fictional
 * data, over the real owner (core/letter-requests.ts) and forced row-level security.
 *
 * The preparer resolves the letter type only against the types the person may request, asks one question when it is
 * unclear, and writes nothing; Confirm submits only on an explicit Confirm, through the owner, which reads the offer again;
 * a repeated Confirm is the same request; tampered, expired, retargeted and someone else's cards are refused and write
 * nothing; a card whose letter type was closed since is refused; Edit opens the request form with the type chosen. The
 * request carries no purpose and no letter content. Next request cookies/locale/cache are framework seams; identity SQL,
 * RLS and the owner's effects are real. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined,locale:'en'}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>browser.locale}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {getBrowserCommandSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {decideLetterTemplate,saveLetterField,saveLetterTemplate} from '../core/letters';
import {saveLetterRequestOptions} from '../core/letter-requests';
import {issueProposal,type Proposal} from '../core/proposals/proposal';
import {LETTER_REQUEST_ACTION,prepareChatLetterRequestProposal} from '../core/proposals/letter-request';
import {confirmLetterRequestProposal,editLetterRequestProposal} from '../core/assistant-actions/letter-request-proposal-confirm';
import {confirmLetterRequestProposalAction,editLetterRequestProposalAction} from '../app/assistant/letter-request-proposal-actions';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={uid:string;employmentId:string;personId:string};
let base:Base,hr:SessionContext,aina:Person,badrul:Person,confirmationId:string,salaryId:string;
const WORDS='I need an employment confirmation letter';
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
async function hire(name:string):Promise<Person>{
 const hired=await hireEmployee(hr,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const uid=await createAppUser(base.tenantId,hired.personId,'employee');await grantAssistant(hr,{appUserId:uid});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-letter-request-proposal-secret-0123456789');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');hr=adminCtx(base);
 const [reviewerPerson]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:'Fictional template approver',primaryEmail:randomUUID()+'@fixture.test'}).returning();
 const reviewer={...hr,userId:await createAppUser(base.tenantId,reviewerPerson.id,'hr_admin'),personId:reviewerPerson.id};
 const name=await saveLetterField(hr,{companyId:base.companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
 const made=async(code:string,title:string)=>{const template=await saveLetterTemplate(hr,{companyId:base.companyId,code,name:title,category:'confirmation',effectiveFrom:todayInKualaLumpur(),
   document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'To '},{type:'field',key:'employeeName'}]}]},fieldVersionIds:[name.id]});
  await decideLetterTemplate(hr,{versionId:template.versionId,expectedStatus:'draft',action:'submit'});await decideLetterTemplate(reviewer,{versionId:template.versionId,expectedStatus:'submitted',action:'approve'});
  return template.templateId;};
 confirmationId=await made('EMPCONF','Employment Confirmation Letter');salaryId=await made('SALARY','Salary Confirmation Letter');
 aina=await hire('Aina Fictional');badrul=await hire('Badrul Fictional');
 browser.selected=aina.uid;browser.locale='en';vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caller=()=>getBrowserCommandSession();
const as=async(person:Person)=>{browser.selected=person.uid;return getBrowserCommandSession();};
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const requests=()=>owner.db.select().from(schema.letterRequest).where(eq(schema.letterRequest.tenantId,base.tenantId));
const openTypes=(ids:string[],requestable=true)=>saveLetterRequestOptions(hr,{companyId:base.companyId,changes:ids.map(templateId=>({templateId,requestable}))});
async function card(details:Record<string,unknown>={letterType:'employment confirmation letter'},words=WORDS):Promise<Proposal>{
 const outcome=await prepareChatLetterRequestProposal(await caller(),details,words);
 if(outcome?.kind!=='proposal')throw Error('Fictional letter request was not prepared: '+JSON.stringify(outcome));
 return outcome.proposal;
}

describe('a letter request from chat',()=>{
 it('is offered only for a letter type the company opened, asks one numbered question when the type is unclear, and writes nothing',async()=>{
  // Nothing open: no card, the suggestion stays a pointer to the form.
  expect(await prepareChatLetterRequestProposal(await caller(),{letterType:'employment confirmation letter'},WORDS)).toBeNull();
  await openTypes([confirmationId,salaryId]);
  const unclear=await prepareChatLetterRequestProposal(await caller(),{letterType:'confirmation letter'},'I need a confirmation letter');
  expect(unclear).toMatchObject({kind:'ask',missing:['letterType'],options:[{option:1,letterType:'Employment Confirmation Letter'},{option:2,letterType:'Salary Confirmation Letter'}]});
  expect(await prepareChatLetterRequestProposal(await caller(),{},WORDS)).toMatchObject({kind:'ask',missing:['letterType']});
  // A number counts only when the person said it.
  expect(await prepareChatLetterRequestProposal(await caller(),{letterType:'2'},'the first one')).toMatchObject({kind:'ask'});
  const second=await prepareChatLetterRequestProposal(await caller(),{letterType:'2'},'number 2 please');
  expect(second).toMatchObject({kind:'proposal',proposal:{body:{review:{reference:salaryId},facts:{letterType:'Salary Confirmation Letter'}}}});
  expect(await requests()).toHaveLength(0);
 });

 it('names the letter type and what confirming does, and submits only on Confirm, once, with no purpose',async()=>{
  await openTypes([confirmationId,salaryId]);
  const proposal=await card();
  expect(proposal.body).toMatchObject({what:{action:LETTER_REQUEST_ACTION,entity:'letter_request',effect:'create',selectors:{}},
   forWhom:{subject:'own_employment',subjectId:aina.employmentId},authority:{kind:'person',userId:aina.uid,personId:aina.personId},
   review:{route:'/me/letters',href:'/me/letters',reference:confirmationId},facts:{letterType:'Employment Confirmation Letter',outcome:'letter_requested_hr_prepares'}});
  for(const confirm of [undefined,false,'true',1])expect(await confirmLetterRequestProposal(await caller(),{proposal,confirm})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await requests()).toHaveLength(0);
  const submitted=await confirmLetterRequestProposalAction({proposal,confirm:true});
  if(submitted.kind!=='submitted')throw Error('Fictional confirmation refused: '+JSON.stringify(submitted));
  const rows=await requests();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({id:submitted.requestId,employmentId:aina.employmentId,templateId:confirmationId,status:'requested',purpose:null,
   clientKey:proposal.body.id,requestedBy:aina.uid,letterTypeName:'Employment Confirmation Letter'});
  // A second press, or a lost reply: the same request, never a second one.
  expect(await confirmLetterRequestProposalAction({proposal,confirm:true})).toEqual(submitted);
  expect(await requests()).toHaveLength(1);
  // A fresh card for the same open request is refused in place: one open request per letter type.
  expect(await confirmLetterRequestProposal(await caller(),{proposal:await card(),confirm:true})).toEqual({kind:'refused',reason:'duplicate'});
  expect(await requests()).toHaveLength(1);
 });

 it('refuses a tampered, retargeted, expired or someone else\'s card, and writes nothing',async()=>{
  await openTypes([confirmationId,salaryId]);
  const proposal=await card(),ctx=await caller();
  // Retargeted to another letter type, or another name shown, with the old signature.
  const retargeted=clone(proposal);retargeted.body.review.reference=salaryId;
  const renamed=clone(proposal);renamed.body.facts!.letterType='Salary Confirmation Letter';
  for(const forged of [retargeted,renamed])expect(await confirmLetterRequestProposal(ctx,{proposal:forged,confirm:true})).toEqual({kind:'refused',reason:'signature'});
  expect(await confirmLetterRequestProposal(ctx,{proposal,confirm:true},new Date(Date.parse(proposal.body.expiresAt)+1000))).toEqual({kind:'refused',reason:'expired'});
  // Someone else's card, confirmed by another employee of the same company.
  const other=await as(badrul);
  expect(await confirmLetterRequestProposal(other,{proposal,confirm:true})).toEqual({kind:'refused',reason:'authority_mismatch'});
  expect(await editLetterRequestProposal(other,proposal)).toEqual({ok:false,reason:'authority_mismatch'});
  // A validly signed card for another action is not a letter request.
  const created=new Date();
  const foreignAction=issueProposal({what:{action:'leave.apply',contractVersion:1,entity:'letter_request',effect:'create',selectors:{},reviewedDigest:proposal.body.what.reviewedDigest},
   forWhom:proposal.body.forWhom,authority:proposal.body.authority,checks:proposal.body.checks,review:proposal.body.review,
   createdAt:created.toISOString(),expiresAt:new Date(created.getTime()+600_000).toISOString()});
  browser.selected=aina.uid;
  expect(await confirmLetterRequestProposal(await caller(),{proposal:foreignAction,confirm:true})).toEqual({kind:'refused',reason:'wrong_action'});
  expect(await confirmLetterRequestProposal(await caller(),{proposal:{body:proposal.body},confirm:true})).toEqual({kind:'refused',reason:'malformed'});
  expect(await requests()).toHaveLength(0);
 });

 it('refuses a card whose letter type the company closed since, and Edit opens the form with the type chosen',async()=>{
  await openTypes([confirmationId]);
  const proposal=await card();
  expect(await editLetterRequestProposalAction({proposal})).toEqual({ok:true,href:`/me/letters?request=1&template=${confirmationId}#request-letter`});
  await openTypes([confirmationId],false);
  expect(await confirmLetterRequestProposal(await caller(),{proposal,confirm:true})).toEqual({kind:'refused',reason:'changed'});
  expect(await editLetterRequestProposal(await caller(),proposal)).toEqual({ok:false,reason:'unavailable'});
  expect(await requests()).toHaveLength(0);
 });
});
