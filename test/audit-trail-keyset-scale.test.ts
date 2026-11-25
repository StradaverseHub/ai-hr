/** ADR 0181 decision 5 (Phase 4): the Audit Trail (/admin/audit) pages by key and caps its total.
 *
 * On the fictional 71-company group (test/helpers/ai-centre-scale-fixture.ts) with ~2,600 ledger events, including a
 * run of events that share one timestamp, for the group, company-by-company and single-company administrators, it
 * proves against the previous OFFSET reader (auditEvents + auditEventsCount):
 *  - equivalence: walking Next to the end, and Previous back from Last, reads exactly the previous reader's events in
 *    its order (newest first, ties by sequence), for no filter, an Area, a search, a record type and a date range;
 *  - totals: exact below 1,000 and "1,000+" above; "Count exactly" equals the previous reader's count;
 *  - authority: an event the viewer cannot see never anchors a page;
 *  - cost: every page is one transaction of at most three statements with no OFFSET, for 1 or 71 companies.
 * All names and payloads are invented. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {auditEvents,auditEventsCount,auditEventsPage,type AuditFilters} from '../core/read';
import {LIST_COUNT_CAP,parseKeysetPageQuery,type KeysetPageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture,otherTenantEventId:string;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:2500});
 // A run of events at one instant: only `sequence` orders them, so a keyset that ignored it would skip or repeat.
 const instant=new Date(Date.now()-90*60_000);
 await owner.db.insert(schema.domainEvent).values(Array.from({length:60},(_,i)=>({tenantId:b.tenantId,aggregateType:'holiday',
  aggregateId:randomUUID(),eventType:'holiday.replacement.reconciled',actorType:'system' as const,payload:{tie:i},occurredAt:instant})));
 // An event in another tenant: row security hides it from every persona here.
 const [tenant]=await owner.db.insert(schema.tenant).values({name:'Fictional Other Tenant Sdn Bhd',workosOrgId:`org_${randomUUID()}`}).returning({id:schema.tenant.id});
 const [other]=await owner.db.insert(schema.domainEvent).values({tenantId:tenant.id,aggregateType:'holiday',aggregateId:randomUUID(),
  eventType:'holiday.replacement.reconciled',actorType:'system',payload:{hidden:true}}).returning({id:schema.domainEvent.id});
 otherTenantEventId=other.id;
},300_000);
afterAll(closeAll);

type Row=Awaited<ReturnType<typeof auditEvents>>[number];
/** The previous reader's whole list for these filters, by OFFSET pages at the "All" ceiling. */
async function previous(ctx:SessionContext,f:AuditFilters){
 const rows:Row[]=[];
 for(let offset=0;;offset+=2000){
  const page=await auditEvents(ctx,{...f,limit:2000,offset});
  rows.push(...page);
  if(page.length<2000)break;
 }
 return {rows,total:await auditEventsCount(ctx,f)};
}
const page=(ctx:SessionContext,f:AuditFilters,q:KeysetPageQuery)=>auditEventsPage(ctx,f,q);
async function walkForward(ctx:SessionContext,f:AuditFilters,size:string){
 const rows:Row[]=[],totals:{count:number;capped:boolean}[]=[];
 let q=parseKeysetPageQuery({size}),n=0;
 for(;;){
  const read=await page(ctx,f,q);n++;
  expect(read.anchorFound).toBe(true);
  expect(read.hasPrev).toBe(n>1);
  rows.push(...read.rows);totals.push(read.total);
  if(!read.hasNext)break;
  q=parseKeysetPageQuery({size,page:String(n),after:read.rows.at(-1)!.id});
  expect(n,'the walk terminates').toBeLessThan(400);
 }
 return {rows,totals};
}
async function walkBackward(ctx:SessionContext,f:AuditFilters,size:string){
 const pages:Row[][]=[];
 let q=parseKeysetPageQuery({size,last:'1'});
 for(;;){
  const read=await page(ctx,f,q);
  pages.unshift(read.rows);
  if(!read.hasPrev)break;
  q=parseKeysetPageQuery({size,page:'3',before:read.rows[0].id});
  expect(pages.length,'the walk terminates').toBeLessThan(400);
 }
 return pages.flat();
}
const ids=(rows:readonly {id:string}[])=>rows.map(r=>r.id);
const FILTERS:Record<string,AuditFilters>={
 everything:{},
 area:{module:'leave'},
 search:{eventQuery:'anomaly'},
 recordType:{aggregateType:'holiday'},
 range:{from:new Date(Date.now()-40*86_400_000).toISOString().slice(0,10),to:new Date().toISOString().slice(0,10)},
};

describe('Audit Trail keyset paging at group scale',()=>{
 it('reads the previous reader\'s events in its order, forwards and backwards, for every administrator',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  let crossedCap=false,belowCap=false;
  for(const [name,ctx] of Object.entries(fixture.personas)){
   for(const [label,f] of Object.entries(FILTERS)){
    const expected=await previous(ctx,f);
    expect(expected.rows.length,`${name}/${label}: nonempty authorized source`).toBeGreaterThan(0);
    expect(expected.rows.length,`${name}/${label}: the previous count agrees with its rows`).toBe(expected.total);
    const forward=await walkForward(ctx,f,'200');
    expect(ids(forward.rows),`${name}/${label}: same events, same order`).toEqual(ids(expected.rows));
    expect(forward.rows,`${name}/${label}: same fields`).toEqual(expected.rows);
    for(const total of forward.totals)
     expect(total,`${name}/${label}: capped total`).toEqual(expected.total>LIST_COUNT_CAP?{count:LIST_COUNT_CAP,capped:true}:{count:expected.total,capped:false});
    if(expected.total>LIST_COUNT_CAP){
     crossedCap=true;
     expect((await page(ctx,f,parseKeysetPageQuery({count:'exact'}))).total,`${name}/${label}: Count exactly`).toEqual({count:expected.total,capped:false});
    }else{
     belowCap=true;
     expect(ids(await walkBackward(ctx,f,'25')),`${name}/${label}: Previous from Last`).toEqual(ids(expected.rows));
    }
   }
  }
  expect(crossedCap&&belowCap,'the filters cover both sides of the cap').toBe(true);
 },300_000); // ~5 filters x 3 administrators of 200-row walks over 2,600 events; hosted runners need headroom.

 it('the shared-timestamp run is ordered by sequence and walked without repeats at a small page size',async()=>{
  const ctx=fixture.personas.group,f:AuditFilters={aggregateType:'holiday'};
  const expected=await previous(ctx,f);
  const forward=await walkForward(ctx,f,'25');
  expect(new Set(ids(forward.rows)).size).toBe(forward.rows.length);
  expect(ids(forward.rows)).toEqual(ids(expected.rows));
 },120_000);

 it('never pages relative to an event the viewer cannot see',async()=>{
  const ctx=fixture.personas.single,f:AuditFilters={};
  const first=await page(ctx,f,parseKeysetPageQuery({size:'25'}));
  for(const cursor of [{after:otherTenantEventId},{before:otherTenantEventId},{after:randomUUID()}]){
   const read=await page(ctx,f,parseKeysetPageQuery({size:'25',page:'6',...cursor}));
   expect(read.anchorFound).toBe(false);
   expect(read.hasPrev).toBe(false);
   expect(ids(read.rows)).toEqual(ids(first.rows));
  }
 },60_000);

 it('costs one transaction and the same statements for one company and 71 companies',async()=>{
  const shapes=new Set<string>();
  for(const [name,ctx] of Object.entries(fixture.personas)){
   const first=await observeStatements(()=>page(ctx,{},parseKeysetPageQuery({size:'25'})));
   const next=await observeStatements(()=>page(ctx,{},parseKeysetPageQuery({size:'25',page:'1',after:first.result.rows.at(-1)!.id})));
   for(const [label,observed] of [['first',first],['next',next]] as const){
    expect(observed.transactions,`${name}/${label}`).toBe(1);
    expect(observed.statements.length,`${name}/${label}`).toBeLessThanOrEqual(3);
    for(const statement of observed.statements){
     expect(statement.sql,`${name}/${label}: no OFFSET`).not.toMatch(/\boffset\b/i);
     shapes.add(statement.sql);
    }
   }
  }
  // Group, company-by-company (71 grants) and single-company administrators send the very same statements.
  expect(shapes.size).toBeLessThanOrEqual(5);
 },120_000);
});
