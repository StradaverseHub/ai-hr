/** People > Personnel search at scale: 1,000, 10,000 and 50,000 fictional employments over 76 companies with dated
 * organisation runs (test/performance/personnel-search-fixture.ts). For each size it times the private search the
 * route runs (createPersonnelPrivateSearch, as the group HR administrator over every company) and the Personnel page
 * that the search opens, one at a time and four at a time (the staging box has two vCPUs, so four concurrent searches
 * keep it CPU-bound), for selective terms, terms that match everyone and a column filter without a term, and reports
 * p50/p95/max. No term search may be refused or reach the 20-second Personnel statement limit; a selective search
 * stays under a second up to 10,000 employments. Column filters without a term are measured (with any refusal) only. At 1,000 employments it also times the search exactly as release f7ee5177 shipped it (the
 * pre-5086 owners and the verbatim legacy search), which staging timed out on. Measurements are written to the focused
 * evidence directory when one is set. Fictional data only. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createPersonnelPrivateSearch} from '../../core/personnel-private-search';
import {readPersonnelOverview} from '../../core/read';
import {closeAll,migrateTestDb,owner} from '../harness';
import {legacyCreatePersonnelPrivateSearch} from '../helpers/personnel-private-search-legacy';
import {restoreWorkforceCapabilityCatalogue} from './personnel-scale-fixture';
import {installPreSearchMappingOwners,seedPersonnelSearchFixture,type PersonnelSearchFixture} from './personnel-search-fixture';

// 50,000 employments are seeded only when a focused run selects this file (the release gate batches every test file,
// and the large seed alone takes about a minute there); 1,000 and 10,000 are measured everywhere.
const SIZES=(process.env.AIHR_PERSONNEL_SEARCH_SIZES??(process.env.AIHR_FOCUSED_SUITE_CAPACITY==='true'?'1000,10000,50000':'1000,10000'))
 .split(',').map(Number);
const CONCURRENCY=4;
type Timing={n:number;p50:number;p95:number;max:number};
const report:{companies:number;sizes:Record<string,unknown>[];legacy?:Record<string,unknown>[]}={companies:76,sizes:[]};
const percentile=(values:number[],p:number)=>{const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)];};
const summary=(values:number[]):Timing=>({n:values.length,p50:Math.round(percentile(values,0.5)),p95:Math.round(percentile(values,0.95)),max:Math.round(Math.max(...values))});
async function timed<T>(work:()=>Promise<T>){const start=performance.now();const value=await work();return {value,ms:performance.now()-start};}
function save(){
 const text=JSON.stringify({kind:'PERSONNEL_SEARCH_SCALE_COMPONENT_ONLY',releaseEligible:false,concurrency:CONCURRENCY,...report},null,2);
 process.stdout.write(text+'\n');
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'personnel-search-scale.json'),text);
}
/** The searches a user types, by how much of the population they match: a full Employee ID, a folded Employee ID, a
 * full NRIC, a non-ASCII name, a term that matches nobody and a common surname are selective; a single letter and the
 * shared e-mail domain match everyone; an identity filter without a term reads the private column-filter rows. */
async function terms(f:PersonnelSearchFixture){
 const [row]=await owner.client<{code:string;ic:string}[]>`select e.employee_code as code,s.ic_number as ic from employment e
  join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=${f.base.tenantId}::uuid and e.voided_at is null
   and e.employee_code like 'FX-%' and s.ic_number is not null order by e.employee_code limit 1`;
 return {
  selective:[{text:row.code},{text:row.code.toLowerCase().replace('-','')},{text:row.ic},{text:'zoë'},{text:'zzzz-nobody'},{text:'tan'}],
  broad:[{text:'a'},{text:'example.invalid'}],
  filter:[{text:'',columnFilters:[{field:'identity',operator:'contains' as const,value:row.ic.slice(0,4)}]}],
 };
}

beforeAll(migrateTestDb);
afterAll(async()=>{try{save();await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);

it('searches thousands to tens of thousands of employments over 76 companies, alone and four at a time, without a timeout',async()=>{
 for(const count of SIZES){
  const seeded=await timed(()=>seedPersonnelSearchFixture({count,companies:76,runs:8}));
  const f=seeded.value,companyIds=f.companies,list=await terms(f);
  const search=(criteria:{text:string;columnFilters?:{field:string;operator:'contains';value:string}[]})=>
   createPersonnelPrivateSearch(f.admin,{...criteria,companyIds,replaceCriteria:true});
  // Warm the plan and buffer caches once, as a running installation is.
  await search(list.selective[0]);
  const entry:Record<string,unknown>={employments:count,seedMs:Math.round(seeded.ms)};
  report.sizes.push(entry);
  for(const [kind,criteria] of Object.entries(list)){
   const alone:number[]=[],page:number[]=[],refusals:string[]=[];let matched=0;
   for(let round=0;round<(kind==='selective'?2:1);round++)for(const c of criteria){
    const {value:token,ms}=await timed(()=>search(c).catch((error:Error)=>{refusals.push(((error.cause as Error|undefined)??error).message);return null;}));alone.push(ms);
    if(!token)continue;
    const {value:overview,ms:pageMs}=await timed(()=>readPersonnelOverview(f.admin,{companyIds,privateSearch:token,limit:25,offset:0},{privateSearch:token}));
    page.push(pageMs);if(overview.headcount.total>0)matched++;
   }
   const together:number[]=[];
   for(let round=0;round<(kind==='selective'?2:1);round++){
    const results=await Promise.all(Array.from({length:CONCURRENCY},(_,j)=>timed(()=>search(criteria[(round*CONCURRENCY+j)%criteria.length])
     .catch((error:Error)=>{refusals.push(((error.cause as Error|undefined)??error).message);return null;}))));
    together.push(...results.map(result=>result.ms));
   }
   entry[kind]={search:summary(alone),page:page.length?summary(page):null,[`search${CONCURRENCY}Concurrent`]:summary(together),searchesWithMatches:matched,refusals};
   save();
   // The owner's bar for the search terms: no term search is refused or reaches the 20-second Personnel statement
   // limit, alone or under load. Column filters without a term read the exact list owner (app.personnel_list_rows)
   // for the whole population; that reader is measured and reported, not asserted here.
   if(kind!=='filter'){
    expect(refusals,`${count} employments: ${kind} searches`).toEqual([]);
    expect(Math.max(...alone,...together),`${count} employments: ${kind} searches finish`).toBeLessThan(20_000);
    expect(matched).toBeGreaterThan(0);
   }
   if(kind==='selective'&&count<=10_000)expect(summary(alone).p95,`${count} employments: selective search p95`).toBeLessThan(1000);
  }

 }
 // The release staging timed out on, for the before numbers at the smallest size (a refusal, such as the 20-second
 // statement limit, is timed as it happened).
 const legacy:Record<string,unknown>[]=[];
 const legacySizes:[number,('selective'|'broad'|'filter')[]][]=[[SIZES[0],['selective','broad','filter']]];
 for(const [count,kinds] of legacySizes){
  const f=await seedPersonnelSearchFixture({count,companies:76,runs:8}),list=await terms(f);
  const reapply=await installPreSearchMappingOwners();
  try{
   const entry:Record<string,unknown>={employments:count};
   for(const kind of kinds){
    const times:number[]=[];
    for(const c of list[kind])times.push((await timed(()=>legacyCreatePersonnelPrivateSearch(f.admin,{...c,companyIds:f.companies,replaceCriteria:true}).catch(error=>error))).ms);
    entry[kind]=summary(times);
   }
   legacy.push(entry);report.legacy=legacy;save();
  }finally{await reapply();}
 }
 expect(legacy.length).toBeGreaterThan(0);
},1_800_000);
