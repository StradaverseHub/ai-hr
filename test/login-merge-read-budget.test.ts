/** ADR 0181 read budgets (docs/architecture/FUTURE-BUILD-CONTRACT.md, "Database read cost") for board 0735d1b7's
 * duplicate-login screens: the Duplicate IC / Passport and Duplicate Work Email Address tabs, the merge confirmation, and
 * the Merge and Undo merge saves (app/admin/users/duplicates/actions.ts).
 *
 * Each page is rendered as the request renders it (its server components resolved, test/helpers/server-tree-snapshot.ts)
 * and each action is called as <ActionNavigateForm> calls it, on the fictional 71-company / 1,000-employment group
 * fixture (test/helpers/ai-centre-scale-fixture.ts) with 120 extra fictional logins in 40 IC pairs and 20 email pairs.
 * Statements and transactions are counted with observeStatements (test/helpers/statement-observer.ts). The screens are
 * group-administrator only and tenant-wide, so the group administrator is measured at "All companies" and at one
 * company (company switcher) and the two must cost the same; a company-scoped administrator is refused before any read
 * of logins. It proves:
 *  - budget: no measurement exceeds the recorded BUDGETS. Budgets only go down; raising one needs an ADR note;
 *  - no per-row loop: a page of 25 groups costs the same number of statements as a page of all 40;
 *  - the measurement is real: the pages list the fixture's groups and the merge and undo take effect.
 * Every measurement is printed as one `ACTION_BUDGET {json}` line. All names are invented. */
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
import DuplicateIdentityPage from '../app/admin/users/duplicates/identity/page';
import DuplicateEmailPage from '../app/admin/users/duplicates/email/page';
import MergeLoginsPage from '../app/admin/users/duplicates/merge/page';
import {mergeLoginsAction,undoLoginMergeAction} from '../app/admin/users/duplicates/actions';
import {readLoginDuplicates} from '../core/login-duplicates';
import {readLoginMergeState} from '../core/login-merge';
import {ACTION_NAVIGATION_FIELD} from '../lib/action-navigation';
import {parseKeysetPageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {allowPeopleDuplicates} from './helpers/allow-people-duplicates';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';
import {serverTreeSnapshot} from './helpers/server-tree-snapshot';

type Budgeted='identityPage'|'emailPage'|'mergePage'|'mergeLoginsAction'|'undoLoginMergeAction';
/** Recorded budgets: the largest (transactions, statements) over both scopes, from focused run 46039979962 (27 Nov 2026).
 * Each page is the tab bar's capped counts, one page read of the groups plus their accounts in one tenant transaction and
 * the batched last sign-ins; the confirmation adds the carry offer. Each save is one tenant transaction; the merge here
 * switches off one login of a two-login group (its statements grow with the merged logins, at most MERGE_MAX_ACCOUNTS
 * per merge, inside the one command). Budgets only go down; raising one needs an ADR note
 * (docs/adr/0181-database-read-cost-architecture.md). */
const BUDGETS:Record<Budgeted,{transactions:number;statements:number}>={
 identityPage:{transactions:3,statements:7},
 emailPage:{transactions:3,statements:7},
 mergePage:{transactions:3,statements:8},
 mergeLoginsAction:{transactions:1,statements:14},
 undoLoginMergeAction:{transactions:1,statements:9},
};
type Scope='all'|'one';
let b:Base,fixture:ScaleFixture;
const measured:Record<string,{transactions:number;statements:number}>={};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();await allowPeopleDuplicates(b.tenantId);
 fixture=await buildScaleFixture(b,{employments:1000,events:2000});
 // 120 fictional logins: 40 pairs sharing an IC (written differently) and 20 pairs sharing a work email (different case).
 await owner.db.execute(sql`with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${b.tenantId}::uuid,'Fictional Duplicate '||n,case when n>80 then 'dup'||((n-79)/2)||(case when n%2=0 then '@Example.test' else '@example.test' end) else 'dup-ic-'||n||'@example.test' end
   from generate_series(1,120) n returning id,full_name),
  numbered as (select id,(regexp_replace(full_name,'\\D','','g'))::int as n from people),
  stat as (insert into employee_statutory_my(tenant_id,person_id,ic_number)
   select ${b.tenantId}::uuid,id,case when n%2=0 then '7701'||lpad(((n+1)/2)::text,8,'0') else '7701-'||lpad(((n+1)/2)::text,8,'0') end from numbered where n<=80 returning person_id)
  insert into app_user(tenant_id,workos_user_id,person_id) select ${b.tenantId}::uuid,'user_dup_'||id,id from numbered`);
},300_000);
afterAll(async()=>{console.log('ACTION_BUDGET_SUMMARY '+JSON.stringify(measured));await closeAll();});

const group=():SessionContext=>({...fixture.personas.group});
function use(scope:Scope){state.session=group();state.cookies=scope==='one'?{company_scope:fixture.singleCompanyId}:{};}
async function measure<T>(what:Budgeted,scope:Scope,work:()=>Promise<T>){
 use(scope);
 const observed=await observeStatements(work);
 const row={action:what,scope,transactions:observed.transactions,statements:observed.statements.length,ms:Math.round(observed.ms)};
 console.log('ACTION_BUDGET '+JSON.stringify(row));
 const key=`${what}|${scope}`;
 measured[key]={transactions:row.transactions,statements:row.statements};
 expect(observed.transactions,`${key} transactions`).toBeGreaterThan(0);
 expect(observed.transactions,`${key} transactions`).toBeLessThanOrEqual(BUDGETS[what].transactions);
 expect(observed.statements.length,`${key} statements`).toBeLessThanOrEqual(BUDGETS[what].statements);
 return {...observed,key};
}
const render=async(node:Promise<unknown>)=>serverTreeSnapshot(await node);
const form=(values:Record<string,string|string[]>)=>{const data=new FormData();data.set(ACTION_NAVIGATION_FIELD,'client');
 for(const [k,v] of Object.entries(values))for(const item of [v].flat())data.append(k,item);return data;};

describe('0735d1b7: duplicate-login screens and saves at group scale',()=>{
 it('lists, confirms, merges and undoes in a bounded number of reads at every scope',async()=>{
  expect((await readLoginDuplicates(group(),'identity',parseKeysetPageQuery({}))).total).toEqual({count:40,capped:false});
  expect((await readLoginDuplicates(group(),'email',parseKeysetPageQuery({}))).total).toEqual({count:20,capped:false});
  // Warm process-level caches once, unmeasured.
  use('all');await render(DuplicateIdentityPage({searchParams:Promise.resolve({})}));
  const pages:Record<string,Awaited<ReturnType<typeof measure>>>={};
  for(const scope of ['all','one'] as const){
   pages[`identity|${scope}`]=await measure('identityPage',scope,()=>render(DuplicateIdentityPage({searchParams:Promise.resolve({})})));
   expect(JSON.stringify(pages[`identity|${scope}`].result)).toContain('Fictional Duplicate');
   pages[`email|${scope}`]=await measure('emailPage',scope,()=>render(DuplicateEmailPage({searchParams:Promise.resolve({})})));
  }
  for(const tab of ['identity','email'])expect(pages[`${tab}|all`].statements.length).toBe(pages[`${tab}|one`].statements.length);
  // A page of 25 groups (50 accounts) and a page of all 40 groups (80 accounts) cost the same statements: no per-group or
  // per-account loop. (With the embedded HR login selected, usernames come from readManagedAccountDirectory, whose
  // existing per-account read this screen does not extend; this fixture runs without it.)
  use('all');
  const small=await observeStatements(()=>render(DuplicateIdentityPage({searchParams:Promise.resolve({size:'25'})})));
  const large=await observeStatements(()=>render(DuplicateIdentityPage({searchParams:Promise.resolve({size:'100'})})));
  const buttons=(tree:unknown)=>JSON.stringify(tree).match(/"admin\.users\.duplicates\.merge"/g)?.length??0;
  expect([buttons(small.result),buttons(large.result)]).toEqual([25,40]);
  expect(large.statements.length).toBe(small.statements.length);
  const groups=(await readLoginDuplicates(group(),'identity',parseKeysetPageQuery({}))).groups;
  const target=groups[0],master=target.accounts[0].appUserId,merged=target.accounts.slice(1).map(a=>a.appUserId);
  for(const scope of ['all','one'] as const){
   const page=await measure('mergePage',scope,()=>render(MergeLoginsPage({searchParams:Promise.resolve({tab:'identity',group:target.digest,master})})));
   expect(JSON.stringify(page.result)).toContain(target.digest);
  }
  const merge=await measure('mergeLoginsAction','all',()=>mergeLoginsAction(form({tab:'identity',group:target.digest,basis:target.basis,master,merged,
   reason:'Fictional duplicate login of one person',confirmation:'MERGE'})));
  expect(merge.result).toEqual({navigate:expect.stringMatching(new RegExp(`^/admin/users/${master}/account\\?toast=`))});
  const mergedState=await readLoginMergeState(group(),merged[0]);
  expect(mergedState.mergedInto?.masterId).toBe(master);
  const undo=await measure('undoLoginMergeAction','all',()=>undoLoginMergeAction(form({mergeId:mergedState.mergedInto!.id,userId:merged[0],reason:'Fictional reviewed undo'})));
  expect(undo.result).toEqual({navigate:expect.stringMatching(new RegExp(`^/admin/users/${merged[0]}/account\\?toast=`))});
  expect((await readLoginMergeState(group(),merged[0])).mergedInto).toBeNull();
 },600_000);
});
