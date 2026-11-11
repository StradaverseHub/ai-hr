/** Personnel private search before and after migration 5086, side by side.
 *
 * The oracle is the release that staging timed out on: the Personnel search and organisation owners exactly as they
 * were before 5086 (restored from the migrations that installed them and checked against the digests 5086 accepts)
 * and the search creation exactly as it shipped (test/helpers/personnel-private-search-legacy.ts, verbatim).
 *
 *  1. Owners. In the restored state every owner 5086 replaces or builds on is read directly (the organisation mapping
 *     and tags on fourteen days, a publish-leased run, employment tags for three actors, typed overview facts and
 *     filter fields, company choices, search rows, filter rows and list rows) and the private-search bind trigger's
 *     verdict on crafted memberships is recorded; after 5086 every answer must be identical.
 *  2. End to end. A spread of searches (terms, identity, column filters, a previous token, a refused viewer) is run
 *     with the shipped search on the restored owners, and must give exactly the same stored membership (every entry,
 *     kind and revision), criteria, scope, first Personnel page, headcount and refusal as the new search after 5086.
 *     The new search on the restored database (its fallback before 5086 arrives) must agree as well.
 *  3. Breadth. Every search is then run with the shipped search and the new search side by side on the 5086 owners,
 *     which (1) proves answer the shipped search's reads identically, comparing the stored membership, for a group HR administrator, the same
 *     administrator over part of the group, a scoped HR administrator with a Workforce denial and a capability-only
 *     viewer.
 * Over 28 companies in five holding blocks (the scale test covers 76) with dated organisation runs (ties, an unpublished time, a parent cycle), retained
 * classifications, dated and cross-company placements, future corrections, terminated and voided staff, identity
 * numbers and non-ASCII text. Fictional data only. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import type {TransactionSql} from 'postgres';
import {client as applicationClient,withTenant,type SessionContext} from '../db/client';
import {createPersonnelPrivateSearch,privateSearchHash} from '../core/personnel-private-search';
import {readPersonnelOverview} from '../core/read';
import {workforceViewScope} from '../core/workforce-access';
import type {PersonnelColumnFilter} from '../lib/personnel-list-controls';
import {closeAll,migrateTestDb,owner} from './harness';
import {legacyCreatePersonnelPrivateSearch} from './helpers/personnel-private-search-legacy';
import {restoreWorkforceCapabilityCatalogue} from './performance/personnel-scale-fixture';
import {installPreSearchMappingOwners,seedPersonnelSearchFixture,type PersonnelSearchFixture} from './performance/personnel-search-fixture';

type Create=typeof createPersonnelPrivateSearch;
type Actor='admin'|'adminPart'|'manager'|'viewer';
type Case={label:string;actor:Actor;text:string;filters?:PersonnelColumnFilter[];previous?:{text:string;filters?:PersonnelColumnFilter[]}};
let f:PersonnelSearchFixture;
let reapply:(()=>Promise<void>)|undefined;
const scopes={} as Record<Actor,string[]>;
const contexts={} as Record<Actor,SessionContext>;
let cases:Case[]=[];
const days:(string|null)[]=[];
const before=new Map<string,unknown>(),beforeFallback=new Map<string,unknown>();

const shift=(day:string,n:number)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const byId=(rows:{employmentId:string}[])=>[...rows].sort((a,b)=>a.employmentId.localeCompare(b.employmentId));
const sorted=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();
/** The refusal itself: a database refusal is compared by its SQLSTATE and message, never by the statement text. */
function refusal(error:unknown){
 const root=(error as {cause?:unknown}).cause instanceof Error?(error as {cause:Error}).cause:error as Error;
 return {refused:root.constructor.name,message:root.message,code:(root as {code?:string}).code??null};
}
/** The migration owner acting for a session, to call the private (non-application) helpers. */
function asSession<T>(ctx:SessionContext,work:(tx:TransactionSql)=>Promise<T>){
 return owner.client.begin(async (tx:TransactionSql)=>{
  await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),
   set_config('app.roles',${(ctx.roles??[]).join(',')},true),set_config('app.grants',${JSON.stringify(ctx.grants??[])},true)`;
  return work(tx);
 }) as Promise<T>;
}
async function attempt<T>(work:()=>Promise<T>){try{return await work();}catch(error){return refusal(error);}}

/** Every stored and visible effect of one search, or its refusal (without the page when `page` is false). */
async function search(create:Create,c:Case,page=true){
 const ctx=contexts[c.actor],companyIds=scopes[c.actor];
 return attempt(async()=>{
  const previousToken=c.previous?await create(ctx,{text:c.previous.text,companyIds,columnFilters:c.previous.filters,replaceCriteria:true}):undefined;
  const token=await create(ctx,{text:c.text,companyIds,columnFilters:c.filters??[],previousToken,replaceCriteria:!c.previous});
  const [stored]=await owner.client<{matches:{employmentId:string}[];criteria:unknown;scope:string[]}[]>`select matches,criteria,scope_ids::text[] as scope
   from personnel_private_search where token_hash=${privateSearchHash(token)}`;
  const membership={matches:byId(stored.matches),criteria:stored.criteria,scope:[...stored.scope].sort()};
  if(!page)return membership;
  const overview=await readPersonnelOverview(ctx,{companyIds,privateSearch:token,limit:25,offset:0},{privateSearch:token});
  return {...membership,employees:overview.employees,headcount:overview.headcount};
 });
}

/** The organisation and Personnel owners 5086 replaces or builds on, read directly. */
async function owners(){
 const out:Record<string,unknown>={};
 const admin=contexts.admin;
 for(const day of days){
  out['mapping '+day]=await asSession(admin,tx=>tx`select app.company_org_mapping_at(${day}::date) as v`.then(rows=>rows[0].v));
  out['company tags '+day]=await asSession(admin,tx=>tx`select c.id,app.company_org_tags_unchecked(c.id,${day}::date) as tags
   from company c where c.tenant_id=${admin.tenantId}::uuid order by c.id`.then(rows=>rows.map(row=>[row.id,row.tags])));
 }
 // A run published by this very transaction (its publish lease) is part of the mapping and the tags.
 out['leased mapping']=await attempt(()=>asSession(admin,async tx=>{
  const [run]=await tx`select id from company_organisation_run where tenant_id=${admin.tenantId}::uuid and state='approved' order by id limit 1`;
  await tx`insert into company_organisation_publish_lease(xact_id,tenant_id,run_id,actor_id) values(pg_current_xact_id(),${admin.tenantId}::uuid,${run.id}::uuid,${admin.userId!}::uuid)`;
  const [row]=await tx`select app.company_org_mapping_at(${f.today}::date) as mapping,
   (select jsonb_agg(app.company_org_tags_unchecked(c.id,${f.today}::date) order by c.id) from company c where c.tenant_id=${admin.tenantId}::uuid) as tags`;
  throw Object.assign(new Error('rollback'),{result:row});
 }).catch(error=>{if((error as {result?:unknown}).result)return (error as {result:unknown}).result;throw error;}));
 const employments=(await owner.client<{id:string}[]>`select id from employment where tenant_id=${admin.tenantId}::uuid order by id`).map(row=>row.id);
 for(const actor of ['admin','manager','viewer'] as Actor[]) for(const day of [f.today,shift(f.today,-100),shift(f.today,60)]){
  out[`employment tags ${actor} ${day}`]=await attempt(()=>asSession(contexts[actor],tx=>tx`select employment_id,tags
   from app._personnel_employment_tags(${employments}::uuid[],${day}::date) order by employment_id`.then(rows=>rows.map(row=>[row.employment_id,row.tags]))));
 }
 for(const actor of ['admin','adminPart','manager','viewer'] as Actor[]){
  const ctx=contexts[actor],scope=sql`ARRAY[${sql.join(scopes[actor].map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
  const read=(label:string,query:ReturnType<typeof sql>)=>attempt(()=>withTenant(ctx,tx=>tx.execute(query)).then(rows=>sorted(rows))).then(value=>{out[label+' '+actor]=value;});
  await read('facts',sql`select * from app.personnel_overview_facts(${f.today}::date,${scope})`);
  await read('filter fields',sql`select * from app.personnel_overview_filter_fields(${f.today}::date,${scope})`);
  await read('companies',sql`select * from app.personnel_filter_companies(${scope},${f.today}::date)`);
  await read('companies without day',sql`select * from app.personnel_filter_companies(${scope},null::date)`);
  await read('search rows',sql`select value from app.personnel_search_rows(${scope}) as s(value)`);
  await read('filter rows',sql`select value from app.personnel_filter_rows(${f.today}::date,${scope}) as s(value)`);
  if(actor==='admin'||actor==='manager')await read('list rows',sql`select value from app.personnel_list_rows(${f.today}::date,${scope}) as s(value)`);
  await read('list rows for ids',sql`select value from app.personnel_list_rows_for_ids(${f.today}::date,${scope},
   (select array_agg(id) from (select id from employment where tenant_id=${ctx.tenantId}::uuid order by id limit 60) e)) as s(value)`);
 }
 return out;
}

function caseList(sample:{name:string;email:string;code:string|null;ic:string|null;passport:string|null}[],companies:string[]):Case[]{
 const names=sample.map(row=>row.name),codes=sample.flatMap(row=>row.code?[row.code]:[]);
 const ic=sample.find(row=>row.ic)!.ic!,passport=sample.find(row=>row.passport)!.passport!;
 const terms=[
  names[0].slice(0,3).toLowerCase(),names[1].toUpperCase(),' '+names[3].slice(2,7)+' ','tan lim','TAN','a','1',
  '-','%','\\',"'",'zzzz-not-a-fixture-name',
  codes[0],codes[0].toLowerCase(),codes[0].replace(/[-. _]/g,''),codes[1].slice(1,6),'fx 000 1','fx.00002','fx\t0000','ＦＸ',
  'EXAMPLE.INVALID','fictional.29@',
  ic,ic.slice(0,6)+'-'+ic.slice(6,8)+'-'+ic.slice(8),ic.slice(0,6)+' '+ic.slice(6,8)+' '+ic.slice(8),ic.slice(2,8),ic.slice(0,6)+'/'+ic.slice(6,8)+'/'+ic.slice(8),
  passport.toLowerCase(),'P-0',
  'zoë','ZOË','ÇELİK','İ','ΣΟΦΊΑ','王','K','x'.repeat(200),
 ];
 const list:Case[]=terms.map(text=>({label:'admin '+JSON.stringify(text),actor:'admin',text}));
 const subset=['tan','a',codes[0].toLowerCase(),ic.slice(2,8),passport,'σοφία','%','zzzz-not-a-fixture-name'];
 for(const actor of ['adminPart','manager'] as Actor[])list.push(...subset.map(text=>({label:actor+' '+JSON.stringify(text),actor,text})));
 list.push(...['tan',ic].map(text=>({label:'viewer '+JSON.stringify(text),actor:'viewer' as Actor,text})));
 const filtered:[Actor,string,PersonnelColumnFilter[]][]=[
  ['admin','',[{field:'identity',operator:'contains',value:ic.slice(0,6)}]],
  ['admin','a',[{field:'identity',operator:'equals',value:ic}]],
  ['admin','tan',[{field:'code',operator:'contains',value:'fx-00'}]],
  ['admin','',[{field:'name',operator:'contains',value:'Lim'},{field:'employment.hiredOn',operator:'from',value:'2020-01-01'}]],
  ['manager','',[{field:'identity',operator:'contains',value:passport.slice(0,3).toUpperCase()},{field:'email',operator:'contains',value:'EXAMPLE'}]],
 ];
 list.push(...filtered.map(([actor,text,filters],i)=>({label:`${actor} filters ${i} ${JSON.stringify(text)}`,actor,text,filters})));
 // Refused before any read: no term and no filter.
 list.push({label:'admin no criteria',actor:'admin',text:'   '});
 list.push({label:'admin previous term then filter',actor:'admin',text:'',previous:{text:'tan'},filters:[{field:'name',operator:'contains',value:'lim'}]});
 list.push({label:'manager previous filter then term',actor:'manager',text:'000',previous:{text:'',filters:[{field:'identity',operator:'contains',value:ic.slice(0,3)}]}});
 return list;
}

/** The end-to-end spread: every actor, identity and formatted NRIC, folded codes, non-ASCII text, a refusal, the column
 * filters and both previous-token merges. */
function endToEnd(){
 const pick=(label:string)=>cases.filter(c=>c.label===label);
 const chosen=[...cases.filter(c=>c.filters||c.previous||c.label==='admin no criteria'),...pick('viewer "tan"'),...pick('manager "tan"'),...pick('adminPart "a"'),
  ...pick('admin "fx\\t0000"'),...pick('admin "ÇELİK"'),...cases.filter(c=>c.actor==='admin'&&!c.filters&&!c.previous).filter((_,i)=>i%13===4)];
 return [...new Map(chosen.map(c=>[c.label,c])).values()];
}

/** The bind trigger's verdict on crafted memberships, inserted by the application role and rolled back: current public
 * and identity entries, a stale revision, identity outside the identity-search permission, a current and a stale filter
 * fingerprint, and a member outside a scoped actor's projection. */
async function bindVerdicts(){
 const out:Record<string,unknown>={};
 const all=sql`ARRAY[${sql.join(scopes.admin.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
 const rows=await withTenant(f.admin,tx=>tx.execute<{value:{employmentId:string;companyId:string;personRevision:string;employmentRevision:string;identityRevision:string|null}}>(
  sql`select value from app.personnel_search_rows(${all}) as s(value) order by value->>'employmentId'`));
 const listed=await withTenant(f.admin,tx=>tx.execute<{value:{employmentId:string;filterRevision:string}}>(
  sql`select value from app.personnel_list_rows(${f.today}::date,${all}) as s(value) order by value->>'employmentId'`));
 const entry=(row:typeof rows[number]['value'],kind:'public'|'identity'='public')=>({employmentId:row.employmentId,kind,personRevision:row.personRevision,
  employmentRevision:row.employmentRevision,identityRevision:kind==='identity'?row.identityRevision:null});
 const withIdentity=rows.find(row=>row.value.identityRevision)!.value,denied=rows.find(row=>row.value.companyId===f.identityDenied)!.value;
 const fingerprinted=listed[0].value,fingerprintRow=rows.find(row=>row.value.employmentId===fingerprinted.employmentId)!.value;
 const memberships:[string,SessionContext,string[],unknown[]][]=[
  ['current public members',f.admin,scopes.admin,rows.slice(0,40).map(row=>entry(row.value))],
  ['current identity member',f.admin,scopes.admin,[entry(withIdentity,'identity')]],
  ['stale revision',f.admin,scopes.admin,[{...entry(rows[3].value),employmentRevision:String(Number(rows[3].value.employmentRevision)+1)}]],
  ['identity without permission',f.admin,scopes.admin,[{...entry(denied,'identity'),identityRevision:withIdentity.identityRevision}]],
  ['current fingerprint',f.admin,scopes.admin,[{...entry(fingerprintRow),filterRevision:fingerprinted.filterRevision}]],
  ['stale fingerprint',f.admin,scopes.admin,[{...entry(fingerprintRow),filterRevision:'0'.repeat(32)}]],
  ['outside the scoped actor',f.manager,scopes.manager,[entry(rows.find(row=>!scopes.manager.includes(row.value.companyId))!.value)]],
 ];
 for(const [label,ctx,scope,matches] of memberships){
  out['bind '+label]=await attempt(()=>withTenant(ctx,async tx=>{
   await tx.execute(sql`insert into personnel_private_search(token_hash,tenant_id,actor_id,scope_ids,matches,criteria)
    values(${'b'.repeat(64)},${ctx.tenantId}::uuid,${ctx.userId}::uuid,ARRAY[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],
     ${JSON.stringify(matches)}::jsonb,${JSON.stringify({term:'fictional',filters:[]})}::jsonb)`);
   throw Object.assign(new Error('accepted'),{accepted:true});
  })).then(value=>value);
 }
 return out;
}

beforeAll(async()=>{
 await migrateTestDb();
 f=await seedPersonnelSearchFixture({count:200,companies:28,runs:6});
 const t=f.base.tenantId;
 // Organisation edge cases: two runs published together on one day (ties broken by id), a published run without a
 // publication time (sorted first), and a parent cycle between two companies.
 const tie=f.companies.slice(10,20),cycle=[f.companies[21],f.companies[22]];
 await owner.client`with runs as (insert into company_organisation_run(id,tenant_id,kind,effective_on,state,company_ids,authority_company_ids,mapping,source_epoch,digest,requested_by,published_at)
   select gen_random_uuid(),${t}::uuid,'restructure',${shift(f.today,-30)}::date,'published',${tie}::uuid[],${tie}::uuid[],'[]'::jsonb,0,'tie-'||n,${f.base.adminUserId}::uuid,
     case when n=3 then null else now() end from generate_series(1,3) n returning id,digest)
  insert into company_organisation_mapping(run_id,tenant_id,company_id,business_unit_id,parent_company_id)
  select r.id,${t}::uuid,c.id,(select b.id from business_unit b where b.company_id=c.id order by b.code offset right(r.digest,1)::int%2 limit 1),
    case when right(r.digest,1)='2' then ${f.companies[0]}::uuid end
  from runs r cross join unnest(${tie}::uuid[]) as c(id)`;
 const [cycleRun]=await owner.client<{id:string}[]>`insert into company_organisation_run(tenant_id,kind,effective_on,state,company_ids,authority_company_ids,mapping,source_epoch,digest,requested_by,published_at)
  values(${t}::uuid,'restructure',${shift(f.today,-20)}::date,'published',${cycle}::uuid[],${cycle}::uuid[],'[]'::jsonb,0,'cycle',${f.base.adminUserId}::uuid,now()) returning id`;
 await owner.client`insert into company_organisation_mapping(run_id,tenant_id,company_id,business_unit_id,parent_company_id) values
  (${cycleRun.id}::uuid,${t}::uuid,${cycle[0]}::uuid,(select id from business_unit where company_id=${cycle[0]}::uuid order by code limit 1),${cycle[1]}::uuid),
  (${cycleRun.id}::uuid,${t}::uuid,${cycle[1]}::uuid,(select id from business_unit where company_id=${cycle[1]}::uuid order by code limit 1),${cycle[0]}::uuid)`;
 await owner.client`analyze company_organisation_run`;await owner.client`analyze company_organisation_mapping`;
 contexts.admin=f.admin;contexts.adminPart=f.admin;contexts.manager=f.manager;contexts.viewer=f.viewer;
 scopes.admin=[...f.companies];scopes.adminPart=f.companies.filter((_,i)=>i%5===2);
 scopes.manager=(await workforceViewScope(f.manager,{personnelList:true})).companyIds;
 scopes.viewer=(await workforceViewScope(f.viewer,{personnelList:true})).companyIds;
 expect(scopes.manager.length).toBeGreaterThan(1);expect(scopes.viewer.length).toBeGreaterThan(1);
 const sample=await owner.client<{name:string;email:string;code:string|null;ic:string|null;passport:string|null}[]>`
  select p.full_name as name,p.primary_email as email,e.employee_code as code,s.ic_number as ic,s.passport_number as passport
  from employment e join person p on p.id=e.person_id left join employee_statutory_my s on s.person_id=p.id
  where e.tenant_id=${t}::uuid and e.voided_at is null and e.employee_code is not null order by s.passport_number is null,s.ic_number nulls last,e.employee_code limit 40`;
 cases=caseList(sample,f.companies);
 for(const day of ['2022-12-31','2023-01-01',shift(f.today,-101),shift(f.today,-100),shift(f.today,-30),shift(f.today,-20),
  shift(f.today,-11),shift(f.today,-10),f.today,shift(f.today,59),shift(f.today,60),'infinity','-infinity',null])days.push(day);
 // The oracle: the owners and the search creation as they were before 5086.
 reapply=await installPreSearchMappingOwners();
 before.set('owners',{...await owners(),...await bindVerdicts()});
 for(const c of endToEnd()){
  before.set(c.label,await search(legacyCreatePersonnelPrivateSearch,c));
  // The new search on a database that 5086 has not reached keeps the previous reader and the same answers.
  beforeFallback.set(c.label,await search(createPersonnelPrivateSearch,c,false));
 }
 await reapply();reapply=undefined;
},1_200_000);
afterAll(async()=>{try{await reapply?.();await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);

describe('migration 5086 keeps every Personnel search answer',()=>{
 it('reads the same organisation mapping, tags, typed facts, company choices and search rows',async()=>{
  const previous=before.get('owners') as Record<string,unknown>,current={...await owners(),...await bindVerdicts()};
  expect(Object.keys(current).length).toBeGreaterThan(60);
  for(const key of Object.keys(previous))expect(current[key],key).toEqual(previous[key]);
  // The set helper is company_org_tags_unchecked for every company of a set, on every day.
  for(const day of days){
   const [row]=await asSession(f.admin,tx=>tx`select (select jsonb_object_agg(t.company_id,t.tags) from app._personnel_company_tags(
     (select array_agg(id) from company where tenant_id=${f.base.tenantId}::uuid),${day}::date) t) as set,
    (select jsonb_object_agg(c.id,app.company_org_tags_unchecked(c.id,${day}::date)) from company c where c.tenant_id=${f.base.tenantId}::uuid) as each`);
   expect(row.set,String(day)).toEqual(row.each);
  }
  // Evidence that the fixture exercised what it claims: ready, pending (cycle and missing unit) and legacy-free tags.
  const tags=(previous['company tags '+f.today] as [string,{status:string;reason:string|null}][]).map(([,value])=>value);
  expect(new Set(tags.map(value=>value.status))).toEqual(new Set(['ready','pending']));
  expect(tags.some(value=>value.reason==='Group structure contains a cycle')).toBe(true);
  expect((previous['leased mapping'] as {mapping:unknown}).mapping).not.toEqual(previous['mapping '+f.today]);
  // The bind trigger both accepted and refused crafted memberships.
  const verdicts=Object.entries(previous).filter(([key])=>key.startsWith('bind ')).map(([,value])=>value as {refused?:string;message:string});
  expect(verdicts.filter(value=>value.message==='accepted')).toHaveLength(3);
  expect(verdicts.filter(value=>value.message!=='accepted').length).toBeGreaterThan(2);
 },240_000);

 it('stores the same private membership, criteria and scope and shows the same page and headcount for every search',async()=>{
  let refused=0,matched=0,empty=0,endToEndCases=0;
  for(const c of cases){
   // Breadth: the stored membership of the shipped search on the owners test 1 proves identical.
   const now=await search(createPersonnelPrivateSearch,c,before.has(c.label));
   expect(now,c.label).toEqual(await search(legacyCreatePersonnelPrivateSearch,c,before.has(c.label)));
   // End to end: the shipped search on the restored owners (with its page), and the new search there before 5086.
   if(before.has(c.label)){
    endToEndCases++;
    expect(now,c.label+' (shipped release)').toEqual(before.get(c.label));
    const shipped=before.get(c.label) as Record<string,unknown>;
    expect(beforeFallback.get(c.label),c.label+' (pre-5086 database)').toEqual('refused' in shipped?shipped:{matches:shipped.matches,criteria:shipped.criteria,scope:shipped.scope});
   }
   if('refused' in now)refused++;else if(now.matches.length)matched++;else empty++;
  }
  // Every outcome was exercised: searches that found people, found nobody, and were refused.
  expect(matched).toBeGreaterThan(cases.length/2);
  expect(refused).toBeGreaterThan(0);
  expect(empty).toBeGreaterThan(0);
  expect(cases.length).toBeGreaterThan(55);
  expect(endToEndCases).toBeGreaterThan(10);
 },600_000);

 it('the new reader keeps app.personnel_search_rows row for row and counts the population in the database',async()=>{
  for(const actor of ['admin','adminPart','manager'] as Actor[]){
   const scope=sql`ARRAY[${sql.join(scopes[actor].map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
   const rows=await withTenant(contexts[actor],tx=>tx.execute<{value:unknown}>(sql`select value from app.personnel_search_rows(${scope}) as s(value)`));
   const every=await withTenant(contexts[actor],tx=>tx.execute<{population:number;value:unknown}>(sql`select population,value
    from app.personnel_search_candidates(${scope},true,false,'','',null,null,ARRAY[]::text[])`));
   const none=await withTenant(contexts[actor],tx=>tx.execute<{population:number;value:unknown}>(sql`select population,value
    from app.personnel_search_candidates(${scope},false,true,'','',null,null,ARRAY[]::text[])`));
   expect(rows.length).toBeGreaterThan(3);
   expect(sorted(every.map(row=>row.value))).toEqual(sorted(rows.map(row=>row.value)));
   expect(new Set(every.map(row=>row.population))).toEqual(new Set([rows.length]));
   expect(none).toEqual([{population:rows.length,value:null}]);
  }
  // The search reads the candidates, not every row: one statement names the new reader and none the old one.
  const statements:string[]=[],options=applicationClient.options as {debug?:unknown},previous=options.debug;
  options.debug=(_connection:number,query:string)=>{statements.push(query);};
  try{await createPersonnelPrivateSearch(f.admin,{text:'tan',companyIds:scopes.admin,replaceCriteria:true});}finally{options.debug=previous;}
  expect(statements.filter(query=>query.includes('app.personnel_search_candidates('))).toHaveLength(1);
  expect(statements.some(query=>query.includes('app.personnel_search_rows(')||query.includes('app.personnel_list_rows('))).toBe(false);
  // The application role may call only the public reader.
  await expect(withTenant(f.admin,tx=>tx.execute(sql`select * from app._personnel_company_tags(ARRAY[${f.companies[0]}::uuid],current_date)`))).rejects.toThrow();
 },120_000);
});
