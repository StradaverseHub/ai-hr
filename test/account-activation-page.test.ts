/** Board 0735d1b7 — the activation page of a person waiting for a login (app/admin/users/activation/[personId]) and its
 * owner (core/account-activation.ts), on the fictional 71-company / 1,000-employment group fixture
 * (test/helpers/ai-centre-scale-fixture.ts). It proves:
 *  - only what fits is offered: no invitation → Set Username and Password and Send Invitation; an open invitation →
 *    when it was sent and whether the email went out, Resend (only for a sent or failed email) and Revoke;
 *  - refusals: a company-scoped administrator is sent away before any read; a person who already has a login, a leaver
 *    whose every employment has ended, and another tenant's person are not activation candidates (404);
 *  - User Type: a person with an employment is an Internal User, a person without one an External User;
 *  - read budget (ADR 0181 rule 6): the page costs at most the recorded transactions and statements at "All companies"
 *    and at one company, the same at both, measured with observeStatements (test/helpers/statement-observer.ts).
 * Every measurement is printed as one `ACTION_BUDGET {json}` line. All names are invented. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
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
import ActivationPage from '../app/admin/users/activation/[personId]/page';
import {readActivationPerson} from '../core/account-activation';
import {closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

/** Recorded budget: the largest (transactions, statements) over both scopes. Budgets only go down; raising one needs an
 * ADR note (docs/adr/0181-database-read-cost-architecture.md). From the design: the session read, then one tenant
 * transaction holding the person statement and the manual-setup proof and list. Tighten to the CI ACTION_BUDGET line. */
const BUDGET={transactions:3,statements:12};
let b:Base,other:Base,fixture:ScaleFixture;
const ids={external:'',internal:'',invited:'',withLogin:'',leaver:'',foreign:''};
const measured:Record<string,{transactions:number;statements:number}>={};

async function person(tenantId:string,name:string,email:string){
 const [row]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${tenantId}::uuid,${name},${email}) returning id::text`);
 return row.id;
}
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();other=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:500});
 ids.external=await person(b.tenantId,'Fictional External Contact',`external-${randomUUID()}@example.test`);
 ids.invited=await person(b.tenantId,'Fictional Invited Contact',`invited-${randomUUID()}@example.test`);
 ids.withLogin=await person(b.tenantId,'Fictional Login Holder',`login-${randomUUID()}@example.test`);
 await createAppUser(b.tenantId,ids.withLogin,'employee');
 ids.foreign=await person(other.tenantId,'Fictional Other Tenant Person',`other-${randomUUID()}@example.test`);
 // Two fixture employees with no login: one stays active (Internal User), one has left.
 const [active,left]=await owner.db.execute<{person_id:string;id:string}>(sql`select e.person_id::text,e.id::text from employment e
  where e.tenant_id=${b.tenantId}::uuid and e.terminated_on is null and not exists(select 1 from app_user u where u.person_id=e.person_id)
   and (select count(*) from employment x where x.person_id=e.person_id)=1 order by e.id limit 2`);
 ids.internal=active.person_id;ids.leaver=left.person_id;
 await owner.db.execute(sql`update employment set terminated_on='2020-01-31',last_working_date='2020-01-31' where id=${left.id}::uuid`);
 // An open invitation whose email failed.
 const [inv]=await owner.db.execute<{id:string}>(sql`insert into app_invitation(tenant_id,email,role,person_id,token_hash,status,expires_at)
  values(${b.tenantId}::uuid,'invited@example.test','employee',${ids.invited}::uuid,${randomUUID()},'pending',now()+interval '7 days') returning id::text`);
 await owner.db.execute(sql`insert into account_email_delivery(tenant_id,kind,invitation_id,status,attempts,last_error) values(${b.tenantId}::uuid,'invitation',${inv.id}::uuid,'failed',1,'providerUnavailable')`);
},300_000);
afterAll(async()=>{console.log('ACTION_BUDGET_SUMMARY '+JSON.stringify(measured));await closeAll();});

const group=():SessionContext=>({...fixture.personas.group});
const render=async(personId:string)=>serverTreeSnapshot(await ActivationPage({params:Promise.resolve({personId})}));

describe('0735d1b7: activation page for a person waiting for a login',()=>{
 it('offers both activation methods to a person with no invitation and labels the User Type',async()=>{
  state.session=group();state.cookies={};
  const external=JSON.stringify(await render(ids.external));
  expect(external).toContain(`/admin/users/create?activate=${ids.external}`);
  expect(external).toContain(`/admin/users/invite?activate=${ids.external}`);
  expect(external).toContain('admin.users.directory.userTypeValue.external');
  expect(external).not.toContain('admin.users.activation.resend');
  const internal=JSON.stringify(await render(ids.internal));
  expect(internal).toContain('admin.users.directory.userTypeValue.internal');
  expect(internal).toContain('/admin/personnel/');
 },120_000);
 it('shows an open invitation with its failed email, Resend and Revoke, and no second invitation link',async()=>{
  state.session=group();state.cookies={};
  const view=await readActivationPerson(group(),ids.invited);
  expect(view?.invitation).toMatchObject({email:'invited@example.test',role:'employee',deliveryStatus:'failed',deliveryError:'providerUnavailable'});
  const page=JSON.stringify(await render(ids.invited));
  expect(page).toContain('admin.users.activation.resend');
  expect(page).toContain('admin.users.revokeInvitation');
  expect(page).toContain('admin.users.activation.delivery.failed');
  expect(page).not.toContain(`/admin/users/invite?activate=${ids.invited}`);
 },120_000);
 it('refuses people who are not activation candidates and other tenants',async()=>{
  for(const id of [ids.withLogin,ids.leaver,ids.foreign,randomUUID()]){
   expect(await readActivationPerson(group(),id),id).toBeNull();
   state.session=group();await expect(render(id)).rejects.toThrow('NEXT_NOT_FOUND');
  }
  // A company-scoped administrator is sent away before any read, and the owner refuses them too.
  state.session={...fixture.personas.single};
  const refused=await observeStatements(()=>render(ids.external).catch(error=>error as Error));
  expect(String(refused.result)).toContain('NEXT_REDIRECT /admin/security-center');
  await expect(readActivationPerson({...fixture.personas.single},ids.external)).rejects.toThrow('group administrator');
 },120_000);
 it('stays within its read budget at All companies and at one company',async()=>{
  const counts:number[]=[];
  for(const scope of ['all','one'] as const){
   state.session=group();state.cookies=scope==='one'?{company_scope:fixture.singleCompanyId}:{};
   const observed=await observeStatements(()=>render(ids.invited));
   const row={action:'activationPage',scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
   console.log('ACTION_BUDGET '+JSON.stringify(row));measured[`activationPage|${scope}`]={transactions:row.transactions,statements:row.statements};
   expect(observed.transactions).toBeGreaterThan(0);
   expect(observed.transactions).toBeLessThanOrEqual(BUDGET.transactions);
   expect(observed.statements.length).toBeLessThanOrEqual(BUDGET.statements);
   counts.push(observed.statements.length);
  }
  expect(counts[0]).toBe(counts[1]);
 },120_000);
});
