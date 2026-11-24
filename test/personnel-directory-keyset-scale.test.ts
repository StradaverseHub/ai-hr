/** ADR 0181 decision 5 (Phase 4), first list: the People directory (/personnel) pages by key and caps its total.
 *
 * On the fictional 71-company / 1,000-employment group (test/helpers/ai-centre-scale-fixture.ts), for the group,
 * company-by-company and single-company administrators, a manager and an employee, under "All companies" and one
 * company, it proves against the previous OFFSET reader (listEmployeesPage):
 *  - equivalence: walking Next to the end, and Previous back from Last, reads exactly the previous reader's rows in
 *    the previous reader's order, with nothing repeated or skipped; search narrows identically;
 *  - totals: exact below 1,000 and "1,000+" above; "Count exactly" returns the previous reader's exact total;
 *  - authority: a cursor naming a row the viewer cannot see pages nothing relative to it (the first page is served);
 *  - scale: "All companies" over 71 companies sends the same statements (same text, same count, one parameter for
 *    the company list) as one company, so pg_stat_statements and plan caching treat them as one statement.
 * All names are invented. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {allowedCompanies,listEmployeesDirectoryPage,listEmployeesPage,type EmployeeListFilters} from '../core/read';
import {LIST_COUNT_CAP,parseKeysetPageQuery,type KeysetPageQuery} from '../lib/pagination';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture;
let personas:Record<'group'|'multi'|'single'|'manager'|'employee',SessionContext>;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 // A few more than 1,000 employments so "All companies" crosses the cap for the group administrator.
 fixture=await buildScaleFixture(b,{employments:1040,events:0});
 const base=await entitledCtx(b,['hr_admin']);
 const own=async(employmentId:string,roles:string[]):Promise<SessionContext>=>{
  const [row]=await owner.db.select({personId:schema.employment.personId}).from(schema.employment).where(sql`${schema.employment.id}=${employmentId}::uuid`);
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:row.personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values(roles.map(role=>({tenantId:b.tenantId,appUserId:u.id,companyId:null,role:role as 'employee'})));
  return {...base,userId:u.id,personId:row.personId,roles,grants:roles.map(role=>({role,companyId:null}))};
 };
 // The manager leads a few fictional reports so their directory is a small, non-empty slice.
 const manager=fixture.activeEmploymentIds[11];
 await owner.db.insert(schema.reportingLine).values(fixture.activeEmploymentIds.slice(40,46).map(subordinate=>({tenantId:b.tenantId,
  managerEmploymentId:manager,subordinateEmploymentId:subordinate,lineType:'administrative' as const,validFrom:'2025-01-01'})));
 personas={...fixture.personas,manager:await own(manager,['manager']),employee:await own(fixture.activeEmploymentIds[23],['employee'])};
},300_000);
afterAll(closeAll);

type Scope='all'|'one';
const scopeIds=async(ctx:SessionContext,scope:Scope)=>scope==='one'?[fixture.singleCompanyId]:(await allowedCompanies(ctx)).map(c=>c.id);
/** The previous reader's whole list, in its order (one OFFSET page as large as the list). */
const previous=(ctx:SessionContext,filters:EmployeeListFilters)=>listEmployeesPage(ctx,{...filters,limit:100_000,offset:0});
type Page=Awaited<ReturnType<typeof listEmployeesDirectoryPage>>;
const directory=(ctx:SessionContext,filters:EmployeeListFilters,q:KeysetPageQuery):Promise<Page>=>
 listEmployeesDirectoryPage(ctx,{...filters,limit:q.limit,size:q.size,after:q.after,before:q.before,last:q.last,exactCount:q.exactCount});

/** Next from the first page to the end; returns every row in reading order and the pages' totals. */
async function walkForward(ctx:SessionContext,filters:EmployeeListFilters,size:string){
 const rows:Page['rows']=[],totals:Page['total'][]=[];
 let q=parseKeysetPageQuery({size}),pages=0;
 for(;;){
  const page=await directory(ctx,filters,q);pages++;
  expect(page.anchorFound).toBe(true);
  expect(page.hasPrev).toBe(pages>1);
  rows.push(...page.rows);totals.push(page.total);
  if(!page.hasNext)break;
  q=parseKeysetPageQuery({size,page:String(pages),after:page.rows.at(-1)!.employmentId});
  expect(pages,'the walk terminates').toBeLessThan(200);
 }
 return {rows,totals,pages};
}
/** Last, then Previous to the start; returns every row in reading order. */
async function walkBackward(ctx:SessionContext,filters:EmployeeListFilters,size:string){
 const pages:Page['rows'][]=[];
 let q=parseKeysetPageQuery({size,last:'1'});
 for(;;){
  const page=await directory(ctx,filters,q);
  pages.unshift(page.rows);
  if(!page.hasPrev)break;
  q=parseKeysetPageQuery({size,page:'5',before:page.rows[0].employmentId});
  expect(pages.length,'the walk terminates').toBeLessThan(200);
 }
 return pages.flat();
}
const ids=(rows:readonly {employmentId:string}[])=>rows.map(r=>r.employmentId);
const names=(rows:readonly {name:string}[])=>rows.map(r=>r.name);

describe('People directory keyset paging at group scale',()=>{
 it('reads the previous reader\'s rows in its order, forwards and backwards, for every role and scope',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  expect(fixture.employmentIds.length).toBeGreaterThanOrEqual(1000);
  let crossedCap=false;
  for(const [name,ctx] of Object.entries(personas)){
   for(const scope of ['all','one'] as const){
    const filters:EmployeeListFilters={companyIds:await scopeIds(ctx,scope)};
    const expected=await previous(ctx,filters);
    if(name!=='employee'&&name!=='manager')expect(expected.rows.length,`${name}/${scope}: nonempty authorized source`).toBeGreaterThan(0);
    const forward=await walkForward(ctx,filters,'200');
    // Same rows, nothing repeated or skipped, in the previous reader's (name) order. Names are unique in the
    // fixture's employments, so the order is fully determined and compared exactly.
    expect(new Set(ids(forward.rows)).size,`${name}/${scope}: no repeats`).toBe(forward.rows.length);
    expect([...ids(forward.rows)].sort(),`${name}/${scope}: same rows`).toEqual([...ids(expected.rows)].sort());
    expect(names(forward.rows),`${name}/${scope}: same order`).toEqual(names(expected.rows));
    // Rows carry the same fields as before.
    const before=new Map(expected.rows.map(r=>[r.employmentId,r]));
    for(const row of forward.rows)expect(row,`${name}/${scope}: same row`).toEqual(before.get(row.employmentId));
    // Totals: exact below the cap, "1,000+" at or above it, the same on every page.
    const exact=expected.total;
    for(const total of forward.totals)
     expect(total,`${name}/${scope}: capped total`).toEqual(exact>LIST_COUNT_CAP?{count:LIST_COUNT_CAP,capped:true}:{count:exact,capped:false});
    if(exact>LIST_COUNT_CAP){
     crossedCap=true;
     const counted=await directory(ctx,filters,parseKeysetPageQuery({count:'exact'}));
     expect(counted.total,`${name}/${scope}: Count exactly`).toEqual({count:exact,capped:false});
    }
    if(expected.rows.length>25&&exact<=LIST_COUNT_CAP){
     const backward=await walkBackward(ctx,filters,'25');
     expect(ids(backward),`${name}/${scope}: Previous from Last reads the same list`).toEqual(ids(forward.rows));
    }
   }
  }
  expect(crossedCap,'the group administrator\'s All companies crosses the cap').toBe(true);
 },300_000); // ~40 RLS-scoped pages per persona on the 1,040-employment group; hosted runners need headroom.

 it('narrows by search exactly like the previous reader',async()=>{
  for(const [name,ctx] of Object.entries(fixture.personas)){
   for(const q of ['Tan','fx-01','person 02','scale-1']){
    const filters:EmployeeListFilters={companyIds:await scopeIds(ctx,'all'),q,status:'active'};
    const expected=await previous(ctx,filters);
    // The group-wide administrators see every fictional company; a single company may hold no match for a term.
    if(name!=='single')expect(expected.rows.length,`${name}/${q}: nonempty`).toBeGreaterThan(0);
    const forward=await walkForward(ctx,filters,'100');
    expect(names(forward.rows),`${name}/${q}`).toEqual(names(expected.rows));
    expect(forward.totals[0],`${name}/${q}: total`).toEqual(expected.total>LIST_COUNT_CAP?{count:LIST_COUNT_CAP,capped:true}:{count:expected.total,capped:false});
   }
  }
 },180_000);

 it('never pages relative to a row the viewer cannot see',async()=>{
  // A persona with at least one employment that row security hides from it (read without any list filter).
  let ctx:SessionContext|undefined,hidden:string|undefined;
  for(const candidate of [personas.single,personas.manager,personas.employee]){
   const seen=new Set((await withTenant(candidate,tx=>tx.select({id:schema.employment.id}).from(schema.employment))).map(r=>r.id));
   hidden=fixture.employmentIds.find(id=>!seen.has(id));
   if(hidden){ctx=candidate;break;}
  }
  expect(hidden,'some fictional employment is invisible to a restricted persona').toBeDefined();
  const filters:EmployeeListFilters={companyIds:await scopeIds(ctx!,'all')};
  const visible=await previous(ctx!,filters);
  for(const cursor of [{after:hidden!},{before:hidden!},{after:randomUUID()}]){
   const page=await directory(ctx!,filters,parseKeysetPageQuery({size:'25',page:'4',...cursor}));
   expect(page.anchorFound).toBe(false);
   expect(page.hasPrev).toBe(false);
   expect(ids(page.rows)).toEqual(ids(visible.rows.slice(0,25)));
  }
 },60_000);

 it('costs the same statements for one company and 71 companies',async()=>{
  for(const [name,ctx] of Object.entries(fixture.personas)){
   const run=async(scope:Scope,cursor:Record<string,string>={})=>{
    const filters:EmployeeListFilters={companyIds:await scopeIds(ctx,scope),q:'person',status:'active'};
    return observeStatements(()=>directory(ctx,filters,parseKeysetPageQuery({size:'25',...cursor})));
   };
   const all=await run('all'),one=await run('one');
   expect((await scopeIds(ctx,'all')).length,`${name}: All companies is the group`).toBeGreaterThanOrEqual(name==='single'?1:70);
   for(const [label,a,o] of [['first page',all,one],
    ['next page',await run('all',{after:all.result.rows.at(-1)!.employmentId,page:'1'}),await run('one',{after:one.result.rows.at(-1)!.employmentId,page:'1'})]] as const){
    expect(a.transactions,`${name}/${label}: one transaction`).toBe(1);
    expect(o.transactions,`${name}/${label}: one transaction`).toBe(1);
    // Rows and the capped count: two statements beside the transaction's identity statement, whatever the scope.
    expect(a.statements.length,`${name}/${label}: statements`).toBeLessThanOrEqual(3);
    expect(a.statements.map(s=>s.sql),`${name}/${label}: same statement text for 1 and 71 companies`).toEqual(o.statements.map(s=>s.sql));
    expect(a.statements.map(s=>s.params.length),`${name}/${label}: same parameter count`).toEqual(o.statements.map(s=>s.params.length));
   }
   // No OFFSET and no exact count on a directory page.
   for(const statement of all.statements){
    expect(statement.sql,`${name}: no OFFSET`).not.toMatch(/\boffset\b/i);
    expect(statement.sql,`${name}: no DISTINCT count`).not.toMatch(/count\(distinct/i);
   }
  }
 },120_000);
});
