/** WP12 review F2: the per-action pause key through a REAL request to handleConfiguredModuleActionBrowserCommand, with
 *  the real cookie-session authenticator (dev_user), the real claim sources and the migrated database. A paused
 *  action is refused; an unpaused sibling keeps working; resuming restores it. Fictional fixtures only. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {type SessionContext} from '../db/client';
import {createClaimType,setClaimPolicy} from '../packs/claims/service';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {setAgentActionPause} from '../core/ai-inventory';
import {OWN_CLAIM_DRAFT_ACTION,type OwnClaimDraftHumanContent} from '../lib/assistant-actions/own-claim-contract';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,resetDb,seedBase,setModule,type Base} from './harness';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));vi.mock('server-only',()=>({}));vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>key==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));vi.mock('../lib/real-auth',()=>({appOrigin:()=>'https://fixture.test'}));
import {handleConfiguredModuleActionBrowserCommand} from '../core/assistant-actions/module-action-server';
let b:Base,human:OwnClaimDraftHumanContent;
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const request=(packet:unknown)=>new Request('https://fixture.test/api/assistant/module-actions',{method:'POST',headers:{origin:'https://fixture.test','content-type':'application/json'},body:JSON.stringify(packet)});
const post=async(packet:unknown)=>{const r=await handleConfiguredModuleActionBrowserCommand(request(packet));return{status:r.status,body:await r.json() as Record<string,unknown>};};
const prepareDraft=()=>post({action:OWN_CLAIM_DRAFT_ACTION,operation:'prepare',input:human});
const cancelChoices=()=>post({action:'claims.cancel',operation:'choices'});
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('NODE_ENV','development');vi.stubEnv('REAL_AUTH','false');browser.selected=undefined;
 vi.stubEnv('AI_CONFIG_SECRET','fictional-claim-custody-key-123456789012345');
 await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');await setModule(b.tenantId,'claims','active');
 const subject=await hireEmployee(group(),{person:{fullName:'Fictional Paused Claimant',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');await grantAssistant(group(),{appUserId:userId});
 browser.selected=userId;vi.stubEnv('DEV_USER_ID',userId);
 const typeId=(await createClaimType(group(),{code:'FICTIONAL',name:'Fictional actual receipt',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(group(),{claimTypeId:typeId,annualBudget:100,perClaimCap:100,effectiveFrom:todayInKualaLumpur()});
 human={action:OWN_CLAIM_DRAFT_ACTION,contractVersion:1,employmentId:subject.employmentId,draftId:null,claimTypeId:typeId,claimItemId:null,enteredAmount:20,quantityKm:null,incurredOn:todayInKualaLumpur(),description:'Fictional receipt',fieldValues:null,retainedAttachmentIds:[]};
});

describe('hr_assistant:<actionId> through the module-actions route',()=>{
 it('refuses the paused action, keeps the sibling working, and resumes',async()=>{
  // Baseline: both work.
  expect((await cancelChoices()).body.kind).not.toBe('unavailable');
  // Pause claims.draft.save only.
  await setAgentActionPause(group(),OWN_CLAIM_DRAFT_ACTION,true);
  const refused=await prepareDraft();
  expect(refused.status===200&&'review' in refused.body).toBe(false);
  const sibling=await cancelChoices();
  expect(sibling.status).toBe(200);expect(sibling.body.kind).not.toBe('unavailable');
  // Pause the sibling too: its choices are now refused (the same check guards it).
  await setAgentActionPause(group(),'claims.cancel',true);
  expect((await cancelChoices()).body.kind).toBe('unavailable');
  // Resume the draft action: it prepares again while claims.cancel stays paused.
  await setAgentActionPause(group(),OWN_CLAIM_DRAFT_ACTION,false);
  const prepared=await prepareDraft();
  expect(prepared.status).toBe(200);expect(prepared.body).toHaveProperty('review');
  expect((await cancelChoices()).body.kind).toBe('unavailable');
 },60000);
});
