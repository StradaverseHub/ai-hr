/** ADR 0181 decision 5 (Phase 4), migration 7320: tenant-led trigram indexes for employee searches.
 *
 * On the fictional 71-company group (test/helpers/ai-centre-scale-fixture.ts) grown to about 6,000 employments, with
 * non-ASCII names and codes, for the group, company-by-company and single-company administrators, it proves:
 *  - equivalence: the employee picker and the People directory answer exactly what they answered before the
 *    trigram candidates, against independently computed expected rows (an unnarrowed row-secured ILIKE read for
 *    the directory, the picker's own unfiltered list filtered the way the picker matches for the picker), for
 *    narrowed terms (3+ ASCII characters, mixed case, LIKE wildcards) and unnarrowed ones (short, non-ASCII);
 *  - authority: the candidates never contain an employment the caller cannot see, and never miss a visible match;
 *  - plans: under the caller's own session claims, the candidate search uses the trigram indexes (a bitmap index
 *    scan on person_full_name_search_trgm / employment_code_search_trigram) rather than reading every person.
 * All names are invented. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {allowedCompanies,listEmployeesDirectoryPage} from '../core/read';
import {readEmployeeChoices} from '../core/employee-choice';
import {isNarrowableEmploymentSearch} from '../core/employment-search';
import {parseKeysetPageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:0});
 // 5,000 more fictional employments spread over the operating companies, so a selective search is cheaper by index.
 const companies=fixture.operatingCompanyIds;
 await owner.client`with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${b.tenantId}::uuid,'Fictional Bulk '||lpad(n::text,5,'0')||' '||(array['Rahman','Chen','Kaur','Lopez','Ito'])[1+n%5],
    'bulk-'||n||'@fixture.test' from generate_series(1,5000) n returning id,full_name)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select ${b.tenantId}::uuid,p.id,(${'{'+companies.join(',')+'}'}::uuid[])[1+(row_number() over(order by p.full_name))::int%${companies.length}],
   'BK-'||lpad((row_number() over(order by p.full_name))::text,5,'0'),'2023-01-01' from people p`;
 // Non-ASCII names and codes: always candidates, decided by the callers' exact matching.
 const odd=[['Tâm Nguyễn Fictional','VN-01'],['İsmail Fictional Tan','TR-02'],['Kelvin Fictional','K-03'],['Fictional Plain','CÖDE-04']];
 for(const [fullName,employeeCode] of odd){
  const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName,primaryEmail:`odd-${randomUUID().slice(0,6)}@fixture.test`}).returning({id:schema.person.id});
  await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:p.id,companyId:fixture.companyIds[0],employeeCode,hiredOn:'2024-01-01'});
 }
 await owner.client`analyze person`;await owner.client`analyze employment`;
},300_000);
afterAll(closeAll);

const TERMS=['tan','TAN','Bulk 0123','bk-0042','fictional person 01','fx-0','rahman','zzzz-none','a%c','b_l','am','tâm','ⅰ'];
const allCompanies=async(ctx:SessionContext)=>(await allowedCompanies(ctx)).map(c=>c.id);

/** The directory's rows before 7320: the same row-secured ILIKE predicate, without the candidates. */
async function directoryExpected(ctx:SessionContext,companyIds:string[],q:string){
 const like='%'+q.trim().replace(/[\\%_]/g,'\\$&')+'%';
 return (await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select e.id from employment e join person p on p.id=e.person_id
  where e.company_id=any(${'{'+companyIds.join(',')+'}'}::uuid[])
   and (p.full_name ilike ${like} or p.primary_email ilike ${like} or e.employee_code ilike ${like})
  order by p.full_name,e.id`))).map(r=>r.id);
}
async function directoryActual(ctx:SessionContext,companyIds:string[],q:string){
 const ids:string[]=[];let query=parseKeysetPageQuery({size:'200'}),n=0;
 for(;;){
  const read=await listEmployeesDirectoryPage(ctx,{companyIds,q,limit:query.limit,size:query.size,after:query.after,before:query.before,last:query.last,exactCount:false});
  ids.push(...read.rows.map(r=>r.employmentId));n++;
  if(!read.hasNext)break;
  query=parseKeysetPageQuery({size:'200',page:String(n),after:ids.at(-1)});
 }
 return ids;
}
/** Every picker page for a query (the picker pages by OFFSET in its own contract, up to 200 rows a page). */
async function pickerAll(ctx:SessionContext,companyIds:string[],query:string){
 const rows:{employmentId:string;name:string;employeeCode:string|null}[]=[];
 for(let offset=0;;offset+=200){
  const page=await readEmployeeChoices(ctx,{companyIds,query,offset,limit:200});
  rows.push(...page.rows);
  if(offset+200>=page.total)break;
 }
 return rows;
}

describe('employee search trigram candidates (7320)',()=>{
 it('the directory answers exactly the unnarrowed row-secured ILIKE read, for every administrator and term',async()=>{
  for(const [name,ctx] of Object.entries(fixture.personas)){
   const companyIds=await allCompanies(ctx);
   for(const q of TERMS){
    const expected=await directoryExpected(ctx,companyIds,q);
    expect(await directoryActual(ctx,companyIds,q),`${name}/${q}`).toEqual(expected);
   }
  }
 },300_000); // 3 administrators x 13 terms over ~6,000 row-secured employments; hosted runners need headroom.

 it('the picker answers what its own unfiltered list filtered the picker\'s way answers',async()=>{
  for(const [name,ctx] of [['group',fixture.personas.group],['single',fixture.personas.single]] as const){
   const companyIds=await allCompanies(ctx);
   const everyone=await pickerAll(ctx,companyIds,'');
   for(const term of TERMS){
    const q=term.trim().toLowerCase();
    const expected=everyone.filter(r=>r.name.toLowerCase().includes(q)||(r.employeeCode??'').toLowerCase().includes(q)).map(r=>r.employmentId);
    expect((await pickerAll(ctx,companyIds,term)).map(r=>r.employmentId),`${name}/${term}`).toEqual(expected);
   }
  }
 },300_000);

 it('the candidates never contain an employment the caller cannot see, and contain every visible match',async()=>{
  for(const [name,ctx] of Object.entries(fixture.personas)){
   const visible=new Set((await withTenant(ctx,tx=>tx.select({id:schema.employment.id}).from(schema.employment))).map(r=>r.id));
   for(const q of ['tan','bulk 01','bk-00','fictional']){
    const [row]=await withTenant(ctx,tx=>tx.execute<{ids:string[]|null}>(sql`select app.employment_search_candidates(${q}::text,null::uuid[],true) as ids`));
    const candidates=row.ids??[];
    expect(candidates.every(id=>visible.has(id)),`${name}/${q}: only visible employments`).toBe(true);
    for(const id of await directoryExpected(ctx,[...fixture.companyIds,...await allCompanies(ctx)],q))
     expect(candidates.includes(id),`${name}/${q}: visible match ${id} is a candidate`).toBe(true);
   }
   expect(isNarrowableEmploymentSearch('am')).toBe(false);
   const [none]=await withTenant(ctx,tx=>tx.execute<{ids:string[]|null}>(sql`select app.employment_search_candidates('am',null::uuid[],true) as ids`));
   expect(none.ids,`${name}: a 2-character term is not narrowed`).toBeNull();
  }
 },180_000);

 it('under the caller\'s own claims, the candidate search reads the trigram indexes',async()=>{
  const ctx=fixture.personas.group;
  // The caller's own identity statement, replayed as the table owner (the function's definer) before EXPLAIN.
  const observed=await observeStatements(()=>withTenant(ctx,tx=>tx.execute(sql`select 1`)));
  const identity=observed.statements[0];
  expect(identity.sql).toMatch(/set_config\('app\.tenant_id'/);
  const [proc]=await owner.client<{src:string}[]>`select prosrc as src from pg_proc where oid='app.employment_search_candidates(text,uuid[],boolean)'::regprocedure`;
  const search=/\$search\$([\s\S]*?)\$search\$/.exec(proc.src)?.[1];
  expect(search,'the function keeps its search statement between $search$ markers').toBeTruthy();
  const pattern=(q:string)=>'%'+q.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%';
  const used=new Set<string>();
  for(const q of ['bulk 01234','bk-04321','rahman','fictional person 0123']){
   await owner.client.begin(async tx=>{
    await tx.unsafe(identity.sql,identity.params as never[]);
    const [plan]=await tx.unsafe(`explain (format json) ${search}`,[pattern(q),null,true] as never[]);
    type Node={'Node Type':string;'Relation Name'?:string;'Index Name'?:string;Plans?:Node[]};
    const nodes:Node[]=[];const walk=(n:Node)=>{nodes.push(n);for(const c of n.Plans??[])walk(c);};
    walk(((plan as Record<string,unknown>)['QUERY PLAN'] as [{Plan:Node}])[0].Plan);
    for(const n of nodes)if(n['Index Name']?.endsWith('_search_trgm'))used.add(n['Index Name']);
    expect(nodes.filter(n=>n['Node Type']==='Seq Scan'&&(n['Relation Name']==='person'||n['Relation Name']==='employment')).map(n=>n['Relation Name']),
     `${q}: no sequential read of every person or employment`).toEqual([]);
   });
  }
  expect([...used].sort()).toEqual(['employment_code_search_trgm','person_full_name_search_trgm','person_primary_email_search_trgm']);
 },120_000);
});
