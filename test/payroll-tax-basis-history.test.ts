/** a16382b4 — Recalculation history read at the shape of a real group (docs/SCALE-AND-RELEASE-RULES.md §3): 71 companies
 * and 1,000 employments from the AI Centre scale fixture, 284 saved batches in 142 runs, read under "All companies"
 * (group-wide and company-by-company grants), under one company and with no grant. Expected rows are derived here
 * from the seed, independently of the reader; the per-batch reader is the equivalence reference for one company. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {listTaxBasisHistory,listTaxBasisBatches} from '../core/payroll-tax-basis';
import type {TaxBasisHistoryCursor,TaxBasisHistoryRow} from '../lib/payroll-tax-basis';
import type {SessionContext} from '../db/client';
import {closeAll,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';

type Final='completed'|'completed_with_errors'|'failed'|null;
type SeedBatch={id:string;companyId:string;runKey:string;createdAt:number;eligible:number;notIncluded:number;completed:number;failed:number;final:Final;finalAt:number|null;lastAt:number;processing:boolean};
const MINUTE=60_000;
let b:Base,f:ScaleFixture,batches:SeedBatch[]=[];const names=new Map<string,string>();

beforeAll(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');
 f=await buildScaleFixture(b,{events:0});
 const staff=await owner.db.execute<{id:string;companyId:string}>(sql`select id,company_id as "companyId" from employment where tenant_id=${b.tenantId}::uuid order by employee_code,id`);
 const byCompany=new Map<string,string[]>();for(const row of staff)byCompany.set(row.companyId,[...(byCompany.get(row.companyId)??[]),row.id]);
 for(const row of await owner.db.execute<{id:string;name:string}>(sql`select id,legal_name as name from company where tenant_id=${b.tenantId}::uuid`))names.set(row.id,row.name);
 // The single-company persona's runs are the newest, so the per-batch reader's 100 most recent batches include them.
 const order=[...f.companyIds.filter(id=>id!==f.singleCompanyId),f.singleCompanyId];
 const now=Date.now(),start=now-order.length*4*MINUTE-60*MINUTE;
 const previews:unknown[]=[],rows:unknown[]=[],events:unknown[]=[];
 order.forEach((companyId,ci)=>{
  const people=byCompany.get(companyId)??[];
  const runs=[{key:randomUUID(),grouped:true,parts:3},{key:'',grouped:false,parts:1}];
  runs.forEach((run,ri)=>{for(let part=0;part<run.parts;part++){
   const id=randomUUID(),createdAt=start+(ci*4+ri*3+part)*MINUTE,runKey=run.grouped?run.key:id;
   const assigned=people.filter((_,i)=>i%run.parts===part&&(ri===0||i<5));
   const failedIds=new Set(assigned.filter((_,i)=>i%7===3)),notIncluded=1+ci%3;
   const pattern=ri===1?'completed':(['open','completed','mixed','failed'] as const)[ci%4];
   const last=part===run.parts-1;
   const final:Final=pattern==='open'&&last?null:pattern==='failed'?'failed':pattern==='mixed'&&last?'completed_with_errors':'completed';
   // The newest company has a batch still moving within the last five minutes; every other unfinished one is stale.
   const recent=companyId===f.singleCompanyId&&final===null;
   const eventAt=(n:number)=>recent?now-2*MINUTE+n*1000:createdAt+(n+1)*1000;
   const previewId=randomUUID();
   previews.push({id:previewId,tenant_id:b.tenantId,company_id:companyId,created_by:f.personas.group.userId,preview_hash:'h-'+previewId,expires_at:new Date(createdAt+15*MINUTE),created_at:new Date(createdAt),
    selection:{companyId,year:2026,upToMonth:8,employmentIds:null},
    preview:{previewId,companyId,companyName:names.get(companyId),year:2026,upToMonth:8,selection:'all',eligibleCount:assigned.length,skippedCount:notIncluded,blockedCount:0,unchangedCount:0,recordCount:assigned.length,
     employees:assigned.map(employmentId=>({id:employmentId,employeeNo:'FX',name:'Fictional',status:'ready',reason:null,recordCount:1}))}});
   rows.push({id,tenant_id:b.tenantId,company_id:companyId,preview_id:previewId,created_by:f.personas.group.userId,created_at:new Date(createdAt),run_id:run.grouped?run.key:null});
   let n=0;const add=(kind:string,employmentId:string|null)=>events.push({tenant_id:b.tenantId,company_id:companyId,batch_id:id,employment_id:employmentId,actor_id:f.personas.group.userId,kind,detail:{},created_at:new Date(eventAt(n++))});
   add('pending',null);if(assigned.length)add('processing',null);
   // An unfinished batch has processed only part of its employees.
   const processedPeople=final===null?assigned.slice(0,Math.floor(assigned.length/2)):assigned;
   for(const employmentId of processedPeople)add(failedIds.has(employmentId)?'employee_failed':'employee_completed',employmentId);
   if(final)add(final,null);
   batches.push({id,companyId,runKey,createdAt,eligible:assigned.length,notIncluded,completed:processedPeople.filter(e=>!failedIds.has(e)).length,
    failed:processedPeople.filter(e=>failedIds.has(e)).length,final,finalAt:final?eventAt(n-1):null,lastAt:eventAt(n-1),processing:assigned.length>0});
  }});
 });
 await owner.client.begin(async tx=>{
  // Seeded as the owner without row triggers: the binding trigger requires each writer's live session, which a
  // read fixture does not have. Every identity it would check is consistent by construction above.
  await tx.unsafe('set local session_replication_role = replica');
  for(let i=0;i<previews.length;i+=200)await tx`insert into payroll_tax_basis_preview ${tx(previews.slice(i,i+200) as Record<string,unknown>[])}`;
  for(let i=0;i<rows.length;i+=200)await tx`insert into payroll_tax_basis_batch ${tx(rows.slice(i,i+200) as Record<string,unknown>[])}`;
  for(let i=0;i<events.length;i+=1000)await tx`insert into payroll_tax_basis_event ${tx(events.slice(i,i+1000) as Record<string,unknown>[])}`;
 });
},180_000);
afterAll(closeAll);

/** The history contract, computed from the seed alone. */
function expected(companies:ReadonlySet<string>){
 const runs=new Map<string,SeedBatch[]>();
 for(const batch of batches)if(companies.has(batch.companyId)){const key=batch.runKey+':'+batch.companyId;runs.set(key,[...(runs.get(key)??[]),batch]);}
 return [...runs.entries()].map(([key,group])=>{
  group.sort((x,y)=>x.createdAt-y.createdAt);
  const finished=group.every(x=>x.final!==null),lastAt=Math.max(...group.map(x=>x.lastAt));
  const status=finished?(group.every(x=>x.final==='completed')?'completed':group.every(x=>x.final==='failed')?'failed':'completed_with_errors')
   :group.some(x=>x.final!==null||x.processing)?'processing':'pending';
  const completed=group.reduce((n,x)=>n+x.completed,0),failed=group.reduce((n,x)=>n+x.failed,0);
  return {id:key,kind:'batch',reference:'TAX-'+group[0].id.toUpperCase(),companyId:group[0].companyId,companyName:names.get(group[0].companyId),
   year:2026,upToMonth:8,status,createdAt:group[0].createdAt,actorName:'Fictional Group Administrator GRP1',completedAt:finished?Math.max(...group.map(x=>x.finalAt!)):null,
   employeeCount:group.reduce((n,x)=>n+x.eligible,0),processedCount:completed+failed,completedCount:completed,failedCount:failed,
   notIncludedCount:group.reduce((n,x)=>n+x.notIncluded,0),interrupted:!finished&&Date.now()-lastAt>5*MINUTE,
   batches:group.map(x=>({id:x.id,reference:'TAX-'+x.id.toUpperCase()}))};
 }).sort((x,y)=>y.createdAt-x.createdAt||(y.id<x.id?-1:y.id>x.id?1:0));
}
const comparable=(row:TaxBasisHistoryRow)=>({...row,createdAt:new Date(row.createdAt).getTime(),completedAt:row.completedAt?new Date(row.completedAt).getTime():null});
async function everyPage(ctx:SessionContext,limit=25){
 const all:TaxBasisHistoryRow[]=[];let cursor:TaxBasisHistoryCursor|null=null,pages=0;
 do{const page:Awaited<ReturnType<typeof listTaxBasisHistory>>=await listTaxBasisHistory(ctx,{cursor,limit});expect(page.rows.length).toBeLessThanOrEqual(limit);all.push(...page.rows);cursor=page.next;pages++;}while(cursor&&pages<50);
 return {all,pages};
}

describe('Recalculation history at group scale',()=>{
 it('groups every run per company, in order, across keyset pages for group-wide and company-by-company administrators',async()=>{
  const want=expected(new Set(f.companyIds));
  expect(want).toHaveLength(142);expect(want.some(row=>row.batches.length===3)).toBe(true);
  expect(new Set(want.map(row=>row.status))).toEqual(new Set(['completed','completed_with_errors','failed','processing']));
  for(const persona of [f.personas.group,f.personas.multi]){
   const {all,pages}=await everyPage(persona);
   expect(pages).toBe(6);
   expect(all.map(comparable)).toEqual(want);
  }
 },120_000);
 it('reads one company under a single-company grant and matches the per-batch reader for that company',async()=>{
  const want=expected(new Set([f.singleCompanyId]));
  const {all}=await everyPage(f.personas.single);
  expect(all.length).toBeGreaterThan(0);
  expect(all.map(comparable)).toEqual(want);
  expect(all[0]).toMatchObject({status:'processing',interrupted:false});
  // Equivalence with the per-batch reader: same batches, outcome counts, final states and recovery decision.
  const legacy=await listTaxBasisBatches(f.personas.single);
  for(const row of all){
   const old=legacy.filter(batch=>row.batches.some(x=>x.id===batch.id));
   expect(old.map(batch=>batch.id).sort()).toEqual(row.batches.map(x=>x.id).sort());
   expect(row.employeeCount).toBe(old.reduce((n,batch)=>n+batch.employeeCount,0));
   expect(row.completedCount).toBe(old.reduce((n,batch)=>n+batch.completedCount,0));
   expect(row.failedCount).toBe(old.reduce((n,batch)=>n+batch.failedCount,0));
   expect(row.interrupted).toBe(old.some(batch=>batch.recoverable===true));
   if(old.every(batch=>['completed','completed_with_errors','failed'].includes(batch.status)))expect(new Date(row.completedAt!).getTime()).toBe(Math.max(...old.map(batch=>new Date(batch.completedAt!).getTime())));
  }
 },60_000);
 it('shows nothing without a grant and refuses a malformed page cursor',async()=>{
  expect(await listTaxBasisHistory({...f.personas.single,grants:[]})).toEqual({rows:[],next:null});
  await expect(listTaxBasisHistory(f.personas.group,{cursor:{createdAt:"2026-01-01'; drop table x;--",id:'x'}})).rejects.toThrow(/valid history page/);
 });
});
