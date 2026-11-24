/** ADR 0181 decision 5 (Phase 4), migration 7290: Approval History pages by key and caps its total.
 *
 * On the fictional 71-company / 1,000-employment group (test/helpers/ai-centre-scale-fixture.ts) with ~2,400 invented
 * approval decisions (several kinds, a run sharing one timestamp, some on the viewers' own employments), for the
 * group, company-by-company and single-company administrators and a manager with a two-level reporting tree, it
 * proves against the previous definer functions (app.approval_history / app.approval_history_count via
 * listApprovalHistory / approvalHistoryCount):
 *  - equivalence: Next to the end and Previous back from Last read the previous reader's rows (names and "on behalf
 *    of" included) in its order, for no filter, an Area, an action, a date range and a decider;
 *  - totals: exact below 1,000, "1,000+" above, and "Count exactly" equal to the previous count;
 *  - authority: a decision the viewer cannot see (or that the filters exclude) never anchors a page;
 *  - cost: one transaction of at most three statements with no OFFSET, the same statements for 1 and 71 companies.
 * All names and payloads are invented. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {approvalHistoryCount,approvalHistoryPage,listApprovalHistory,type ApprovalHistoryFilters,type ApprovalHistoryRow} from '../core/read';
import {LIST_COUNT_CAP,parseKeysetPageQuery,type KeysetPageQuery} from '../lib/pagination';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture,manager:SessionContext,deciderEmploymentId:string,hiddenDecisionId:string;
let personas:Record<string,SessionContext>;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:0});
 const base=await entitledCtx(b,['hr_admin']);
 // A manager over 8 direct and 16 second-level reports (all active employments of the fixture).
 const managerEmployment=fixture.activeEmploymentIds[5];
 const [row]=await owner.db.select({personId:schema.employment.personId,companyId:schema.employment.companyId}).from(schema.employment).where(sql`${schema.employment.id}=${managerEmployment}::uuid`);
 const [mu]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:row.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:mu.id,companyId:null,role:'manager'});
 manager={...base,userId:mu.id,personId:row.personId,roles:['manager'],grants:[{role:'manager',companyId:null}]};
 // Reports in the manager's own company, so the company-subtree clamp keeps them.
 const sameCompany=(await owner.db.select({id:schema.employment.id}).from(schema.employment)
  .where(sql`${schema.employment.companyId}=${row.companyId}::uuid and ${schema.employment.terminatedOn} is null and ${schema.employment.id}<>${managerEmployment}::uuid`)
  .orderBy(schema.employment.employeeCode).limit(24)).map(r=>r.id);
 const direct=sameCompany.slice(0,8),second=sameCompany.slice(8,24);
 await owner.db.insert(schema.reportingLine).values([
  ...direct.map(id=>({tenantId:b.tenantId,managerEmploymentId:managerEmployment,subordinateEmploymentId:id,lineType:'administrative' as const,validFrom:'2025-01-01'})),
  ...second.map((id,i)=>({tenantId:b.tenantId,managerEmploymentId:direct[i%8],subordinateEmploymentId:id,lineType:'administrative' as const,validFrom:'2025-01-01'})),
 ]);
 // Deciders: the group administrator and the manager.
 deciderEmploymentId=managerEmployment;
 const kinds=[['leave-request','leave-request.approved'],['leave-request','leave-request.rejected'],['claim-request','claim-request.approved'],
  ['claim-request','claim-request.rejected'],['attendance-correction','attendance-correction.approved'],['employment-review','employment-review.decided'],
  ['leave-request','leave-request.date.decided']] as const;
 const subjects=[...fixture.activeEmploymentIds,...sameCompany,...sameCompany];
 const now=Date.now(),instant=new Date(now-3*3_600_000);
 const events:(typeof schema.domainEvent.$inferInsert)[]=Array.from({length:2400},(_,i)=>{const [aggregateType,eventType]=kinds[i%kinds.length];
  return {tenantId:b.tenantId,aggregateType,aggregateId:randomUUID(),eventType,actorType:'user' as const,actorId:i%3===0?mu.id:b.adminUserId,
   subjectEmploymentId:subjects[(i*7)%subjects.length],payload:eventType==='leave-request.date.decided'?{decision:i%2?'approved':'rejected'}:{n:i},
   // 50 decisions share one instant; the rest are a minute apart over ~40 hours.
   occurredAt:i%48===0?instant:new Date(now-i*60_000)};});
 // The manager's own decisions about their own leave never appear (self rows).
 events.push(...Array.from({length:5},(_,i)=>({tenantId:b.tenantId,aggregateType:'leave-request',aggregateId:randomUUID(),eventType:'leave-request.approved',
  actorType:'user' as const,actorId:b.adminUserId,subjectEmploymentId:managerEmployment,payload:{self:i},occurredAt:new Date(now-i*30_000)})));
 for(let i=0;i<events.length;i+=1000)await owner.db.insert(schema.domainEvent).values(events.slice(i,i+1000));
 // A decision about an employment outside the manager's tree: invisible to the manager.
 const [hidden]=await owner.db.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'claim-request',aggregateId:randomUUID(),
  eventType:'claim-request.approved',actorType:'user',actorId:b.adminUserId,subjectEmploymentId:fixture.activeEmploymentIds.at(-1)!,payload:{hidden:true}})
  .returning({id:schema.domainEvent.id});
 hiddenDecisionId=hidden.id;
 personas={...fixture.personas,manager};
},300_000);
afterAll(closeAll);

/** The previous reader's whole list, by OFFSET pages at the "All" ceiling. */
async function previous(ctx:SessionContext,f:ApprovalHistoryFilters){
 const rows:ApprovalHistoryRow[]=[];
 for(let offset=0;;offset+=2000){const page=await listApprovalHistory(ctx,{...f,limit:2000,offset});rows.push(...page);if(page.length<2000)break;}
 return {rows,total:await approvalHistoryCount(ctx,f)};
}
const page=(ctx:SessionContext,f:ApprovalHistoryFilters,q:KeysetPageQuery)=>approvalHistoryPage(ctx,f,q);
async function walkForward(ctx:SessionContext,f:ApprovalHistoryFilters,size:string){
 const rows:ApprovalHistoryRow[]=[],totals:{count:number;capped:boolean}[]=[];
 let q=parseKeysetPageQuery({size}),n=0;
 for(;;){
  const read=await page(ctx,f,q);n++;
  expect(read.anchorFound).toBe(true);expect(read.hasPrev).toBe(n>1);
  rows.push(...read.rows);totals.push(read.total);
  if(!read.hasNext)break;
  q=parseKeysetPageQuery({size,page:String(n),after:read.rows.at(-1)!.id});
  expect(n,'the walk terminates').toBeLessThan(400);
 }
 return {rows,totals};
}
async function walkBackward(ctx:SessionContext,f:ApprovalHistoryFilters,size:string){
 const pages:ApprovalHistoryRow[][]=[];
 let q=parseKeysetPageQuery({size,last:'1'});
 for(;;){
  const read=await page(ctx,f,q);pages.unshift(read.rows);
  if(!read.hasPrev)break;
  q=parseKeysetPageQuery({size,page:'3',before:read.rows[0].id});
  expect(pages.length,'the walk terminates').toBeLessThan(400);
 }
 return pages.flat();
}
const ids=(rows:readonly {id:string}[])=>rows.map(r=>r.id);
const day=(offsetHours:number)=>new Date(Date.now()-offsetHours*3_600_000).toISOString();

describe('Approval History keyset paging at group scale (7290)',()=>{
 it('reads the previous reader\'s decisions in its order, forwards and backwards, for every role and filter',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  const filters:Record<string,ApprovalHistoryFilters>={
   everything:{},area:{module:'claims'},approved:{action:'approved'},other:{action:'other'},
   range:{from:day(30),to:day(2)},decider:{deciderEmploymentId},
  };
  let crossedCap=false,belowCap=false;
  for(const [name,ctx] of Object.entries(personas)){
   for(const [label,f] of Object.entries(filters)){
    const expected=await previous(ctx,f);
    expect(expected.rows.length,`${name}/${label}: the previous count agrees with its rows`).toBe(expected.total);
    if(label==='everything')expect(expected.rows.length,`${name}: nonempty authorized source`).toBeGreaterThan(0);
    const forward=await walkForward(ctx,f,'200');
    expect(ids(forward.rows),`${name}/${label}: same decisions, same order`).toEqual(ids(expected.rows));
    expect(forward.rows,`${name}/${label}: same names and on-behalf fields`).toEqual(expected.rows);
    for(const total of forward.totals)
     expect(total,`${name}/${label}: capped total`).toEqual(expected.total>LIST_COUNT_CAP?{count:LIST_COUNT_CAP,capped:true}:{count:expected.total,capped:false});
    if(expected.total>LIST_COUNT_CAP){
     crossedCap=true;
     expect((await page(ctx,f,parseKeysetPageQuery({count:'exact'}))).total,`${name}/${label}: Count exactly`).toEqual({count:expected.total,capped:false});
    }else if(expected.total>0){
     belowCap=true;
     expect(ids(await walkBackward(ctx,f,'25')),`${name}/${label}: Previous from Last`).toEqual(ids(expected.rows));
    }
   }
  }
  expect(crossedCap&&belowCap,'the filters cover both sides of the cap').toBe(true);
 },300_000); // 6 filters x 4 roles of 200-row walks over ~2,400 decisions; hosted runners need headroom.

 it('never pages relative to a decision the viewer cannot see or the filters exclude',async()=>{
  const first=await page(manager,{},parseKeysetPageQuery({size:'25'}));
  const claimOnly=(await previous(manager,{module:'claims'})).rows[0].id;
  for(const [f,cursor] of [[{},{after:hiddenDecisionId}],[{},{before:hiddenDecisionId}],[{},{after:randomUUID()}],[{module:'leave'},{after:claimOnly}]] as const){
   const read=await page(manager,f,parseKeysetPageQuery({size:'25',page:'6',...cursor}));
   expect(read.anchorFound).toBe(false);expect(read.hasPrev).toBe(false);
   if(!('module' in f))expect(ids(read.rows)).toEqual(ids(first.rows));
  }
 },60_000);

 it('costs one transaction and the same statements for one company and 71 companies',async()=>{
  const shapes=new Set<string>();
  for(const [name,ctx] of Object.entries(personas)){
   const first=await observeStatements(()=>page(ctx,{},parseKeysetPageQuery({size:'25'})));
   expect(first.result.hasNext,`${name}: a next page`).toBe(true);
   const next=await observeStatements(()=>page(ctx,{},parseKeysetPageQuery({size:'25',page:'1',after:first.result.rows.at(-1)!.id})));
   for(const [label,observed] of [['first',first],['next',next]] as const){
    expect(observed.transactions,`${name}/${label}`).toBe(1);
    expect(observed.statements.length,`${name}/${label}`).toBeLessThanOrEqual(3);
    for(const statement of observed.statements){expect(statement.sql,`${name}/${label}: no OFFSET`).not.toMatch(/\boffset\b/i);shapes.add(statement.sql);}
   }
  }
  // Identity, page and capped count: the same three statement texts for every role and company count.
  expect(shapes.size).toBeLessThanOrEqual(3);
 },120_000);

 it('the migration keeps the previous functions and grants only the page and the capped count',()=>{
  const migration=readFileSync('db/migrations/7290_approval_history_keyset.sql','utf8');
  expect(migration).not.toMatch(/CREATE OR REPLACE|DROP |ALTER /i);
  expect(migration.match(/GRANT EXECUTE ON FUNCTION app\.(\w+)/g)).toEqual(['GRANT EXECUTE ON FUNCTION app.approval_history_page','GRANT EXECUTE ON FUNCTION app.approval_history_count_capped']);
 });
});
