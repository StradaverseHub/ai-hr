/** ADR 0181 decision 1 as a ratchet (docs/architecture/FUTURE-BUILD-CONTRACT.md, "Database read cost"): no new per-row
 * authority call inside an access rule.
 *
 * Reads every row-security policy of the migrated test database (pg_policy, deparsed with pg_get_expr, so policies
 * built by DO blocks and later ALTER POLICY rewrites are seen as installed) and lists each call to an authority
 * function, a SECURITY DEFINER or procedural (plpgsql) function that Postgres cannot inline, whose arguments name a
 * column of the row: that call runs once for every row the statement reads. Calls with constant arguments, such as
 * the precomputed-access form `company_id = any ((select app.effective_companies('workforce.view')))`, run once per
 * statement and are not listed. Each listed call is one entry `schema.table | policy | function` in
 * test/read-cost-ratchets/policy-authority.json (seeded from origin/alpha at release 9). A new entry fails: new access
 * rules use precomputed access (the 7210/7240/7280 pattern). An entry no longer found fails until it is removed. The
 * parser is test/helpers/read-cost-ratchet.ts (perRowAuthorityCalls), with fixtures in test/read-cost-ratchets.test.ts.
 * The observed list is printed as one `READ_COST_POLICY_AUTHORITY [json]` line. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner} from './harness';
import * as rc from './helpers/read-cost-ratchet';

const root=fileURLToPath(new URL('..',import.meta.url)).replace(/[\\/]+$/,'');
const ALLOWLIST='test/read-cost-ratchets/policy-authority.json';

beforeAll(migrateTestDb);
afterAll(closeAll);

describe('row-security policies: per-row authority calls only shrink',()=>{
 it('adds no per-row authority function call to any policy',async()=>{
  const functions=await owner.client<{schema:string;name:string;authority:boolean}[]>`
   select n.nspname as schema,p.proname as name,bool_or(p.prosecdef or l.lanname not in ('sql','internal','c')) as authority
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
   where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
   group by 1,2`;
  const qualified=new Set(functions.filter(f=>f.authority).map(f=>`${f.schema}.${f.name}`));
  const unqualified=new Set(functions.filter(f=>f.authority).map(f=>f.name));
  const isAuthority=(schema:string|null,name:string)=>schema?qualified.has(`${schema}.${name}`):unqualified.has(name);
  expect(qualified.size).toBeGreaterThan(500);

  const policies=await owner.client<{tbl:string;policy:string;qual:string|null;chk:string|null}[]>`
   select n.nspname||'.'||c.relname as tbl,p.polname as policy,
    pg_get_expr(p.polqual,p.polrelid) as qual,pg_get_expr(p.polwithcheck,p.polrelid) as chk
   from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
   order by 1,2`;
  expect(policies.length).toBeGreaterThan(1000);

  const found=[...new Set(policies.flatMap(p=>
   [...rc.perRowAuthorityCalls(p.qual,isAuthority),...rc.perRowAuthorityCalls(p.chk,isAuthority)].map(fn=>`${p.tbl} | ${p.policy} | ${fn}`)))].sort();
  console.log('READ_COST_POLICY_AUTHORITY '+JSON.stringify(found));
  // The pre-pilot authority chains are still in place on most tables; an empty list means the parser broke.
  expect(found.length).toBeGreaterThan(100);

  const allowed=JSON.parse(readFileSync(join(root,ALLOWLIST),'utf8')) as string[];
  const diff=rc.compareCounts(rc.asCounts(found),rc.asCounts(allowed));
  const keep=new Set(found);
  const byKey=new Map(policies.map(p=>[`${p.tbl} | ${p.policy}`,p]));
  const sites=diff.grown.map(g=>{
   const policy=byKey.get(g.key.split(' | ').slice(0,2).join(' | '));
   return {key:g.key,file:g.key,line:0,text:`USING ${policy?.qual?.slice(0,300)??'-'} WITH CHECK ${policy?.chk?.slice(0,300)??'-'}`};
  });
  const report=rc.ratchetReport({name:'Per-row authority calls in policies',allowlist:ALLOWLIST,diff,sites,
   rule:'New access rules read a precomputed answer once per statement (stored answer, access version, legacy/shadow/precomputed mode and a nightly rebuild-and-compare, as 7210, 7240 and 7280 do), not a SECURITY DEFINER function per row. See docs/architecture/FUTURE-BUILD-CONTRACT.md ("Database read cost").',
   shrunkAllowlist:diff.shrunk.length?rc.json(allowed.filter(k=>keep.has(k))).trimEnd():undefined});
  expect([...diff.grown,...diff.shrunk].map(d=>d.key),report).toEqual([]);
 });
});
