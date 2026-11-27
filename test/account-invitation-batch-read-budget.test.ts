/** ADR 0181 read budgets (docs/architecture/FUTURE-BUILD-CONTRACT.md, "Database read cost") for Security Center ›
 * Users › By Batch Send Invitation (board 0735d1b7): its two pages (app/admin/users/invitations/batch/page.tsx and
 * [jobId]/page.tsx) and its three server actions (app/admin/users/invitations/batch/actions.ts: start, retry failed,
 * stop).
 *
 * Each page function is run and each action is called as the request runs it (the real modules; only the session and
 * the translator are mocked at the Next.js edge) on the fictional 71-company / 1,000-employment group fixture
 * (test/helpers/ai-centre-scale-fixture.ts), whose ~1,000 people have no login: the realistic shape of a tenant with
 * thousands Pending Activation. Statements and transactions are counted with observeStatements
 * (test/helpers/statement-observer.ts). It proves, for each:
 *  - budget: no measurement exceeds the recorded BUDGETS (transactions, statements). Budgets only go down; raising
 *    one needs an ADR note;
 *  - no per-person loop: the list page and "Select all" over ~1,000 people cost a fixed number of statements, the same
 *    at "All companies" and at one company;
 *  - the measurement is real: the eligible count equals an independent count (core/employment-status.ts
 *    isLoginBlocked over the fixture's rows), "Select all" freezes exactly that population, and each call returns
 *    the expected next address;
 *  - only group administrators: the 71-company and one-company administrators are sent away by the page guard.
 * Every measurement is printed as one `ACTION_BUDGET {json}` line. All names are invented. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({session:undefined as unknown,cookies:{} as Record<string,string>}));
vi.mock('next/headers',()=>({
 headers:async()=>new Headers(),
 cookies:async()=>({get:(name:string)=>name in state.cookies?{name,value:state.cookies[name]}:undefined,
  getAll:()=>Object.entries(state.cookies).map(([name,value])=>({name,value})),has:(name:string)=>name in state.cookies}),
}));
vi.mock('next/cache',async importOriginal=>({...await importOriginal<typeof import('next/cache')>(),revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
vi.mock('next/navigation',async importOriginal=>({...await importOriginal<typeof import('next/navigation')>(),
 notFound:vi.fn(()=>{throw new Error('NEXT_NOT_FOUND');}),
 redirect:vi.fn((url:string)=>{throw Object.assign(new Error(`NEXT_REDIRECT ${url}`),{digest:`NEXT_REDIRECT;replace;${url}`});})}));
vi.mock('next-intl/server',()=>{
 const translator=(namespace?:string)=>{
  const t=(key:string,values?:Record<string,unknown>)=>`${namespace?namespace+'.':''}${key}${values?JSON.stringify(values):''}`;
  return Object.assign(t,{rich:t,markup:t,raw:(key:string)=>key,has:()=>true});
 };
 return {getLocale:async()=>'en',getTranslations:async(arg?:string|{namespace?:string})=>translator(typeof arg==='string'?arg:arg?.namespace),
  getFormatter:async()=>({dateTime:(value:unknown)=>new Date(value as string).toISOString(),number:(value:unknown)=>String(value)})};
});
vi.mock('../lib/session',async importOriginal=>({...await importOriginal<typeof import('../lib/session')>(),
 getSession:async()=>state.session,getBrowserCommandSession:async()=>state.session}));

import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {ACTION_NAVIGATION_FIELD} from '../lib/action-navigation';
import {isLoginBlocked} from '../core/employment-status';
import type {AuthProvider} from '../core/auth';
import {accountInvitationBatchHandler} from '../core/account-invitation-batch-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {AccountEmailDeliveryError} from '../lib/account-email-model';
import BatchInvitationPage from '../app/admin/users/invitations/batch/page';
import InvitationBatchPage from '../app/admin/users/invitations/batch/[jobId]/page';
import {cancelInvitationBatchAction,retryFailedInvitationsAction,startInvitationBatchAction} from '../app/admin/users/invitations/batch/actions';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

type Budgeted='listPage'|'batchPage'|'startInvitationBatchAction'|'retryFailedInvitationsAction'|'cancelInvitationBatchAction';
/** Recorded budgets (transactions, statements). Initial ceilings from the statement shape, to be lowered to the first
 * CI measurement (ACTION_BUDGET lines): the list page is the candidates read (page, both counts; the manual-setup proof
 * when an embedded or Keycloak issuer is selected) plus the company list and the caller's latest batch; the batch page
 * is the job and the names of one page of results; each action is one tenant transaction (admission: company check,
 * the frozen population, worker readiness, admission, job read). Budgets only go down; raising one needs an ADR note
 * (docs/adr/0181-database-read-cost-architecture.md). */
const BUDGETS:Record<Budgeted,{transactions:number;statements:number}>={
 listPage:{transactions:3,statements:10},
 batchPage:{transactions:1,statements:4},
 startInvitationBatchAction:{transactions:1,statements:8},
 retryFailedInvitationsAction:{transactions:1,statements:8},
 cancelInvitationBatchAction:{transactions:1,statements:4},
};
let b:Base,fixture:ScaleFixture;
const measured:Record<string,{transactions:number;statements:number}>={};
beforeAll(async()=>{await migrateTestDb();await resetDb();b=await seedBase();fixture=await buildScaleFixture(b,{employments:1000,events:2000});},300_000);
afterAll(async()=>{console.log('ACTION_BUDGET_SUMMARY '+JSON.stringify(measured));await closeAll();});

function use(persona:'group'|'multi'|'single',scope:'all'|'one'){state.session={...fixture.personas[persona]};state.cookies=scope==='one'?{company_scope:fixture.singleCompanyId}:{};}
async function measure<T>(what:Budgeted,scope:'all'|'one',work:()=>Promise<T>){
 use('group',scope);
 const observed=await observeStatements(work);
 const row={action:what,persona:'group',scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('ACTION_BUDGET '+JSON.stringify(row));
 measured[`${what}|${scope}`]={transactions:row.transactions,statements:row.statements};
 expect(observed.transactions,`${what} transactions`).toBeGreaterThan(0);
 expect(observed.transactions,`${what} transactions`).toBeLessThanOrEqual(BUDGETS[what].transactions);
 expect(observed.statements.length,`${what} statements`).toBeLessThanOrEqual(BUDGETS[what].statements);
 return observed;
}
const form=(fields:Record<string,string|string[]>)=>{const f=new FormData();f.set(ACTION_NAVIGATION_FIELD,'client');
 for(const [k,v] of Object.entries(fields))for(const value of [v].flat())f.append(k,value);return f;};
const jobRow=async(id:string)=>(await owner.client<{state:string;steps_total:number;input:{personIds?:string[]}|null;result:{counts:Record<string,number>}|null}[]>`
 select state,steps_total,input,result from bulk_job where id=${id}::uuid`)[0];
const fakeProvider=(fail:boolean):AuthProvider=>({sendInvitation:async()=>{if(fail)throw new AccountEmailDeliveryError('relayUnavailable');return {invitationId:'fake'};},
 revokeInvitation:async()=>{},sendPasswordReset:async()=>{},endSession:async()=>{},emailReadiness:async()=>null});
async function settle(id:string,provider:AuthProvider){
 for(let tick=0;tick<400;tick++){const row=await jobRow(id);if(['completed','failed','cancelled'].includes(row.state))return row;
  if(!await runBulkJobTick(owner.client,{handlers:[accountInvitationBatchHandler(provider)]}))await new Promise(r=>setTimeout(r,30));}
 throw new Error('job did not finish');
}
const jobIdOf=(navigate:string)=>/\/admin\/users\/invitations\/batch\/([0-9a-f-]{36})/.exec(navigate)?.[1];

/** Who can receive an invitation, counted independently of the SQL reader: no login, no pending invitation, not a
 * leaver (isLoginBlocked over the person's employments), a work email nobody else's login or invitation uses. */
async function independentEligible(){
 const people=await owner.db.select().from(schema.person).where(eq(schema.person.tenantId,b.tenantId));
 const employments=await owner.db.select().from(schema.employment).where(eq(schema.employment.tenantId,b.tenantId));
 const users=await owner.db.select().from(schema.appUser).where(eq(schema.appUser.tenantId,b.tenantId));
 const invitations=await owner.db.select().from(schema.appInvitation).where(eq(schema.appInvitation.tenantId,b.tenantId));
 const withLogin=new Set(users.map(u=>u.personId).filter(Boolean));
 const invited=new Set(invitations.filter(i=>i.status==='pending').map(i=>i.personId));
 const held=new Map<string,Set<string|null>>();
 const hold=(email:string,personId:string|null)=>{const k=email.trim().toLowerCase();if(!k)return;(held.get(k)??held.set(k,new Set()).get(k)!).add(personId);};
 for(const i of invitations)if(i.status==='pending'||i.status==='accepted')hold(i.email,i.personId);
 for(const p of people)if(withLogin.has(p.id))hold(p.primaryEmail,p.id);
 return people.filter(p=>!withLogin.has(p.id)&&!invited.has(p.id)
  &&!isLoginBlocked({employments:employments.filter(e=>e.personId===p.id)})
  &&/.@./.test(p.primaryEmail.trim())&&![...(held.get(p.primaryEmail.trim().toLowerCase())??[])].some(holder=>holder!==p.id)).map(p=>p.id);
}

describe('0735d1b7: By Batch Send Invitation at group scale',()=>{
 it('lists, admits, stops, reads and retries in a bounded number of reads, for group administrators only',async()=>{
  const expected=await independentEligible();
  expect(expected.length).toBeGreaterThan(900);
  // Warm process-level caches once, unmeasured.
  use('group','all');await BatchInvitationPage({searchParams:Promise.resolve({})});
  const all=await measure('listPage','all',()=>BatchInvitationPage({searchParams:Promise.resolve({})}));
  const one=await measure('listPage','one',()=>BatchInvitationPage({searchParams:Promise.resolve({})}));
  expect(all.statements.length).toBeLessThanOrEqual(one.statements.length);
  expect(all.result).toBeTruthy();
  // Only group administrators reach the page.
  for(const persona of ['multi','single'] as const){use(persona,'all');await expect(BatchInvitationPage({searchParams:Promise.resolve({})})).rejects.toThrow(/NEXT_REDIRECT/);}

  // "Select all" over ~1,000 people: one admission, the frozen population equal to the independent count.
  const started=await measure('startInvitationBatchAction','all',()=>startInvitationBatchAction(form({selection:'all',search:'',role:'employee',companyId:'group',
   emailLocale:'en',expectedCount:String(expected.length),operationKey:randomUUID(),confirmed:'on'})));
  const bigId=jobIdOf(started.result.navigate);
  expect(bigId,started.result.navigate).toBeTruthy();
  expect([...(await jobRow(bigId!)).input!.personIds!].sort()).toEqual([...expected].sort());
  const stopped=await measure('cancelInvitationBatchAction','all',()=>cancelInvitationBatchAction(form({jobId:bigId!})));
  expect(stopped.result.navigate).toBe(`/admin/users/invitations/batch/${bigId}`);
  expect((await settle(bigId!,fakeProvider(false))).state).toBe('cancelled');

  // A small batch whose emails all fail, its results page and its retry.
  use('group','all');
  const small=await startInvitationBatchAction(form({selection:'ids',personIds:expected.slice(0,3),role:'employee',companyId:'group',emailLocale:'en',
   expectedCount:'3',operationKey:randomUUID(),confirmed:'on'}));
  const smallId=jobIdOf(small.navigate)!;
  expect((await settle(smallId,fakeProvider(true))).result?.counts).toEqual({sent:0,failed:3,skipped:0,uncertain:0});
  const page=await measure('batchPage','all',()=>InvitationBatchPage({params:Promise.resolve({jobId:smallId}),searchParams:Promise.resolve({})}));
  expect(page.result).toBeTruthy();
  const retried=await measure('retryFailedInvitationsAction','all',()=>retryFailedInvitationsAction(form({jobId:smallId,operationKey:randomUUID()})));
  const retryId=jobIdOf(retried.result.navigate)!;
  expect(retryId).not.toBe(smallId);
  expect((await settle(retryId,fakeProvider(false))).result?.counts).toEqual({sent:3,failed:0,skipped:0,uncertain:0});
 },600_000);
});
