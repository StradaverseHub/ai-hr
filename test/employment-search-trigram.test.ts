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
 *    scan on person_full_name_search_trgm / employment_code_search_trigram) rather than reading every person;
 *  - cost (7530): the People directory and picker searches, timed with EXPLAIN (ANALYZE, BUFFERS) under each caller's
 *    own identity (group, multi-company and single-company administrators, and an employee), are no slower than the
 *    same statements without the candidates (the reads before 7320), and the 7320 body is kept as a reference to
 *    show the visible-set cost 7530 removes.
 * All names are invented. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {allowedCompanies,listEmployeesDirectoryPage} from '../core/read';
import {readEmployeeChoices} from '../core/employee-choice';
import {isNarrowableEmploymentSearch} from '../core/employment-search';
import {parseKeysetPageQuery} from '../lib/pagination';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {isIdentityStatement,observeStatements,type Captured} from './helpers/statement-observer';

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
 // A second fictional tenant of 15,000 people, so the tables are big enough that the planner's index choice is
 // realistic (on 6,000 rows a sequential read is cheaper). Row security keeps it invisible to every persona here.
 const [other]=await owner.db.insert(schema.tenant).values({name:'Fictional Large Group Bhd',workosOrgId:`org_${randomUUID()}`}).returning({id:schema.tenant.id});
 const [otherCompany]=await owner.db.insert(schema.company).values({tenantId:other.id,legalName:'Fictional Large Operating Sdn Bhd'}).returning({id:schema.company.id});
 await owner.client`with people as (
   insert into person(tenant_id,full_name,primary_email)
   select ${other.id}::uuid,'Fictional Large '||lpad(n::text,6,'0')||' '||(array['Abdullah','Wong','Pillai','Garcia','Sato'])[1+n%5],
    'large-'||n||'@fixture.test' from generate_series(1,15000) n returning id,full_name)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select ${other.id}::uuid,p.id,${otherCompany.id}::uuid,'LG-'||lpad((row_number() over(order by p.full_name))::text,6,'0'),'2023-01-01' from people p`;
 await owner.client`analyze person`;await owner.client`analyze employment`;
},600_000); // The 21,000-employment fixture with 7240's visibility maintenance; hosted runners took >300 s at 46,000.
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
    // NULL: 7530 declines to narrow (a broad term for a caller with cheap row security); the caller
    // then reads as before 7320, which the directory and picker equivalence tests cover.
    if(row.ids===null)continue;
    const candidates=row.ids;
    expect(candidates.every(id=>visible.has(id)),`${name}/${q}: only visible employments`).toBe(true);
    for(const id of await directoryExpected(ctx,[...fixture.companyIds,...await allCompanies(ctx)],q))
     expect(candidates.includes(id),`${name}/${q}: visible match ${id} is a candidate`).toBe(true);
   }
   // A caller naming one company they administer (at most 1,000 employments) is not narrowed (7530): NULL.
   for(const q of ['tan','fictional','fx-0']){
    const [row]=await withTenant(ctx,tx=>tx.execute<{ids:string[]|null}>(sql`select app.employment_search_candidates(${q}::text,${'{'+fixture.singleCompanyId+'}'}::uuid[],true) as ids`));
    expect(row.ids,`${name}/${q}: one administered company is read as before 7320`).toBeNull();
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
    const [{read}]=await tx.unsafe(`select app.employment_read_companies() as read`) as unknown as {read:string[]}[];
    const [plan]=await tx.unsafe(`explain (format json) ${search}`,[pattern(q),null,true,read] as never[]);
    type Node={'Node Type':string;'Relation Name'?:string;'Index Name'?:string;Plans?:Node[]};
    const nodes:Node[]=[];const walk=(n:Node)=>{nodes.push(n);for(const c of n.Plans??[])walk(c);};
    walk(((plan as Record<string,unknown>)['QUERY PLAN'] as [{Plan:Node}])[0].Plan);
    for(const n of nodes)if(n['Index Name']?.endsWith('_search_trgm'))used.add(n['Index Name']);
    const sequential=nodes.filter(n=>n['Node Type']==='Seq Scan'&&(n['Relation Name']==='person'||n['Relation Name']==='employment')).map(n=>n['Relation Name']);
    // Evidence line for the release notes: which indexes the plan read, and any whole-table read left.
    console.log('SEARCH_PLAN '+JSON.stringify({query:q,indexes:nodes.flatMap(n=>n['Index Name']?[n['Index Name']]:[]),sequential}));
   });
  }
  expect([...used].sort()).toEqual(['employment_code_search_trgm','person_full_name_search_trgm','person_primary_email_search_trgm']);
 },120_000);

 it('7530: a search costs no more than the read without candidates (before 7320), for administrators and an employee',async()=>{
  // An employee of the group company with no grant beyond their own record: the relationship part only.
  const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Employee EMP1',primaryEmail:`${randomUUID()}@fixture.test`}).returning({id:schema.person.id});
  await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:p.id,companyId:b.companyId,employeeCode:'FX-EMP1',hiredOn:'2020-01-01'});
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:p.id}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,companyId:null,role:'employee'});
  const employee:SessionContext={...await entitledCtx(b,['employee']),userId:u.id,personId:p.id,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  // Authority on the employee's own company (7530's direct path when that scope is small): only visible ids, every
  // visible match.
  const employeeVisible=new Set((await withTenant(employee,tx=>tx.select({id:schema.employment.id}).from(schema.employment))).map(r=>r.id));
  for(const q of ['tan','fictional','fx-emp']){
   const [row]=await withTenant(employee,tx=>tx.execute<{ids:string[]|null}>(sql`select app.employment_search_candidates(${q}::text,${'{'+b.companyId+'}'}::uuid[],true) as ids`));
   console.log('SEARCH_EMPLOYEE_SCOPE_7530 '+JSON.stringify({q,narrowed:row.ids!==null,candidates:row.ids?.length??null}));
   if(row.ids===null)continue;
   expect(row.ids.every(id=>employeeVisible.has(id)),`employee/${q}: only visible employments`).toBe(true);
   for(const id of await directoryExpected(employee,[b.companyId],q))expect(row.ids.includes(id),`employee/${q}: visible match ${id}`).toBe(true);
  }
  // core/employment-search.ts: the candidates statement, and the narrowing clause it adds to the caller's statements.
  const CANDIDATES=/^select app\.employment_search_candidates\(/i;
  const CLAUSE=/"employment"\."id" = any\((\$\d+)::uuid\[\]\)/;
  /** The search transaction's reads, as the app sends them (7530) and as before 7320 (no candidates statement, no clause). */
  const searchStatements=async(work:()=>Promise<unknown>)=>{
   const observed=await observeStatements(work);
   const reads=observed.statements.filter(s=>!isIdentityStatement(s.sql)&&/^(select|with|\()/i.test(s.sql.trim()));
   expect(reads.filter(s=>CANDIDATES.test(s.sql.trim())).length,'one candidates statement per search').toBe(1);
   const narrowed=reads.some(s=>CLAUSE.test(s.sql));
   const before=reads.filter(s=>!CANDIDATES.test(s.sql.trim())).map(s=>({...s,sql:s.sql.replace(CLAUSE,'($1::uuid[] is not null or true)')}));
   for(const s of before)expect(s.sql,'one narrowing clause per statement').not.toMatch(CLAUSE);
   return {now:reads,before,narrowed};
  };
  const identityOf=async(ctx:SessionContext):Promise<Captured>=>{
   const observed=await observeStatements(()=>withTenant(ctx,tx=>tx.execute(sql`select 1`)));
   return observed.statements.find(s=>isIdentityStatement(s.sql))!;
  };
  /** Execution plus planning ms and shared buffers of the statements, one EXPLAIN (ANALYZE, BUFFERS) each, as the caller. */
  const timed=async(identity:Captured,statements:readonly Captured[])=>{
   let ms=0,buffers=0,jit='';
   await client.begin(async tx=>{
    await tx.unsafe(identity.sql,identity.params as never[]);
    jit=((await tx.unsafe(`select current_setting('jit') as jit`))[0] as unknown as {jit:string}).jit;
    for(const s of statements){
     const [row]=await tx.unsafe(`explain (analyze, buffers, format json) ${s.sql}`,s.params as never[]);
     const [plan]=(row as Record<string,unknown>)['QUERY PLAN'] as [{Plan:{'Shared Hit Blocks'?:number;'Shared Read Blocks'?:number};'Execution Time':number;'Planning Time':number}];
     ms+=plan['Execution Time']+plan['Planning Time'];buffers+=(plan.Plan['Shared Hit Blocks']??0)+(plan.Plan['Shared Read Blocks']??0);
    }
   });
   return {ms,buffers,jit};
  };
  const median=(xs:number[])=>[...xs].sort((x,y)=>x-y)[Math.floor(xs.length/2)];
  const ROUNDS=9;
  type Search={now:Captured[];before:Captured[];narrowed:boolean};
  const cases:{caller:string;ctx:SessionContext;screen:string;search:Search}[]=[];
  const page=parseKeysetPageQuery({size:'25'});
  const directory=(ctx:SessionContext,companyIds:string[],q:string)=>searchStatements(()=>listEmployeesDirectoryPage(ctx,{companyIds,q,limit:page.limit,size:page.size,after:page.after,before:page.before,last:page.last,exactCount:false}));
  for(const q of ['tan','rahman','bulk 0123','bk-0042','fictional']){
   for(const [caller,ctx] of [['group',fixture.personas.group],['multi',fixture.personas.multi],['single',fixture.personas.single]] as const){
    const companyIds=await allCompanies(ctx);
    cases.push({caller,ctx,screen:`directory ${q}`,search:await directory(ctx,companyIds,q)});
    if(caller!=='multi')cases.push({caller,ctx,screen:`picker ${q}`,search:await searchStatements(()=>readEmployeeChoices(ctx,{companyIds,query:q,offset:0,limit:50}))});
   }
   // The employee in the whole group (every company asked) and in their own company (what their screens ask).
   cases.push({caller:'employee',ctx:employee,screen:`directory ${q} (all companies)`,search:await directory(employee,fixture.companyIds as string[],q)});
   cases.push({caller:'employee',ctx:employee,screen:`directory ${q} (own company)`,search:await directory(employee,[b.companyId],q)});
  }
  const failures:string[]=[];
  for(const c of cases){
   const identity=await identityOf(c.ctx);
   const runs={before7320:{ms:[] as number[],buffers:[] as number[]},now7530:{ms:[] as number[],buffers:[] as number[]}};
   const jit=new Set<string>();
   for(let round=0;round<ROUNDS;round++){
    for(const variant of (round%2?['now7530','before7320']:['before7320','now7530']) as (keyof typeof runs)[]){
     const r=await timed(identity,variant==='now7530'?c.search.now:c.search.before);
     runs[variant].ms.push(r.ms);runs[variant].buffers.push(r.buffers);jit.add(r.jit);
    }
   }
   // The app's identity statement turns JIT off for every transaction (db/client.ts), so both run as the app runs.
   expect([...jit],`${c.caller} ${c.screen}: JIT as the app sets it`).toEqual(['off']);
   const row={before7320:{medianMs:Math.round(median(runs.before7320.ms)*100)/100,buffers:median(runs.before7320.buffers)},
    now7530:{medianMs:Math.round(median(runs.now7530.ms)*100)/100,buffers:median(runs.now7530.buffers)}};
   console.log('SEARCH_COST_7530 '+JSON.stringify({caller:c.caller,screen:c.screen,narrowed:c.search.narrowed,statements:c.search.now.length,jit:[...jit].join(','),...row}));
   // No slower than before 7320, with 1 ms (or 10 %) for runner noise between interleaved medians.
   const allowance=Math.max(1,row.before7320.medianMs*0.1);
   if(row.now7530.medianMs>row.before7320.medianMs+allowance)failures.push(`${c.caller} ${c.screen}: ${row.now7530.medianMs} ms > ${row.before7320.medianMs} ms before 7320`);
  }
  expect(failures).toEqual([]);
 },900_000);

 it('measures each index build (the migration\'s CREATE INDEX holds a SHARE lock: reads continue, writes wait)',async()=>{
  const [{people,employments}]=await owner.client<{people:number;employments:number}[]>`select (select count(*) from person)::int as people,(select count(*) from employment)::int as employments`;
  for(const index of ['person_full_name_search_trgm','person_primary_email_search_trgm','employment_code_search_trgm',
   'person_full_name_non_ascii_idx','person_primary_email_non_ascii_idx','employment_code_non_ascii_idx']){
   const started=performance.now();
   // REINDEX builds the index from scratch under the same SHARE lock as CREATE INDEX.
   await owner.client.unsafe(`reindex index public.${index}`);
   const ms=Math.round(performance.now()-started);
   const rows=index.startsWith('person')?people:employments;
   console.log('INDEX_BUILD '+JSON.stringify({index,rows,ms,msPer10kRows:Math.round(ms*10000/rows)}));
   expect(ms,`${index}: builds in seconds at ${rows} rows`).toBeLessThan(60_000);
  }
 },300_000);
});
