/** ADR 0181 decision 5 (Phase 4): Employee Leave Record (/leave/employee-records) pages by key and caps its total.
 *
 * On the fictional 71-company / 1,000-employment group (test/helpers/ai-centre-scale-fixture.ts) with ~1,500 invented
 * leave requests (shared application instants, shared dates, blank employee codes), for the group, company-by-company
 * and single-company administrators, it proves against the previous OFFSET reader (leaveInquiryRecordsPage, which the
 * export keeps):
 *  - equivalence: for every sortable column in both directions, walking Next to the end reads the previous reader's
 *    rows in its order (the column, then newest application, then id; blank codes last ascending, first descending),
 *    and Previous back from Last reads the same list;
 *  - totals: exact below 1,000, "1,000+" above, "Count exactly" equal to the previous total;
 *  - authority: a request the viewer cannot see never anchors a page;
 *  - cost: one transaction, the same list statements for one company and 71 companies, no OFFSET.
 * All names are invented. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {allowedCompanies} from '../core/read';
import {leaveInquiryContext,leaveInquiryRecordsKeysetPageTx,leaveInquiryRecordsPage,leaveInquirySnapshot} from '../core/leave-inquiry';
import {parseInquiryQuery} from '../lib/leave-inquiry-query';
import {LIST_COUNT_CAP,parseKeysetPageQuery,type KeysetPageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture,otherTenantRequest:string;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:0});
 // Blank employee codes on some employments, so the code sort has blanks to place.
 await owner.client`update employment set employee_code=null
  where id = any(${'{'+fixture.activeEmploymentIds.filter((_,i)=>i%37===3).join(',')+'}'}::uuid[])`;
 const statuses=['pending','approved','rejected','cancelled'] as const;
 const instant=new Date('2026-10-01T02:00:00Z');
 const rows=Array.from({length:1500},(_,i)=>({tenantId:b.tenantId,employmentId:fixture.activeEmploymentIds[(i*13)%fixture.activeEmploymentIds.length],
  leaveTypeId:b.annualLeaveTypeId,startDate:`2026-${String(1+i%12).padStart(2,'0')}-${String(1+i%27).padStart(2,'0')}`,
  endDate:`2026-${String(1+i%12).padStart(2,'0')}-${String(1+(i+2)%27).padStart(2,'0')}`,days:'1',status:statuses[i%4],
  // Every 9th request shares one application instant: only the id orders them.
  createdAt:i%9===0?instant:new Date(Date.UTC(2026,0,1)+i*3_600_000)}));
 for(let i=0;i<rows.length;i+=500)await owner.db.insert(schema.leaveRequest).values(rows.slice(i,i+500));
 // A request in another tenant: row security hides it from every persona here.
 const foreign=await seedBase();
 const [fp]=await owner.db.insert(schema.person).values({tenantId:foreign.tenantId,fullName:'Fictional Foreign Person',primaryEmail:`foreign-${randomUUID().slice(0,6)}@fixture.test`}).returning({id:schema.person.id});
 const [fe]=await owner.db.insert(schema.employment).values({tenantId:foreign.tenantId,personId:fp.id,companyId:foreign.companyId,employeeCode:'FOREIGN-1',hiredOn:'2024-01-01'}).returning({id:schema.employment.id});
 const [r]=await owner.db.insert(schema.leaveRequest).values({tenantId:foreign.tenantId,employmentId:fe.id,leaveTypeId:foreign.annualLeaveTypeId,
  startDate:'2026-09-01',endDate:'2026-09-01',days:'1',status:'pending'}).returning({id:schema.leaveRequest.id});
 otherTenantRequest=r.id;
},300_000);
afterAll(closeAll);

const query=(params:Record<string,string>={})=>parseInquiryQuery({asOf:'2026-10-15',...params},'records');
type Row=Awaited<ReturnType<typeof leaveInquiryRecordsPage>>['rows'][number];
async function previous(ctx:SessionContext,companyIds:string[],params:Record<string,string>){
 const q=query(params),scope=await leaveInquiryContext(ctx,companyIds,q);
 const rows:Row[]=[];let total=0;
 for(let offset=0;;offset+=2000){const page=await leaveInquiryRecordsPage(ctx,scope,q,{limit:2000,offset});rows.push(...page.rows);total=page.total;if(page.rows.length<2000)break;}
 return {rows,total};
}
const keysetPage=(ctx:SessionContext,companyIds:string[],params:Record<string,string>,k:KeysetPageQuery)=>{
 const q=query(params);
 return leaveInquirySnapshot(ctx,companyIds,q,(tx,scope)=>leaveInquiryRecordsKeysetPageTx(tx,ctx,scope,q,k),{selectionOnly:true});
};
async function walkForward(ctx:SessionContext,companyIds:string[],params:Record<string,string>,size:string){
 const rows:Row[]=[],totals:{count:number;capped:boolean}[]=[];
 let k=parseKeysetPageQuery({size}),n=0;
 for(;;){
  const read=await keysetPage(ctx,companyIds,params,k);n++;
  expect(read.anchorFound).toBe(true);expect(read.hasPrev).toBe(n>1);
  rows.push(...read.rows);totals.push(read.total);
  if(!read.hasNext)break;
  k=parseKeysetPageQuery({size,page:String(n),after:read.rows.at(-1)!.id});
  expect(n,'the walk terminates').toBeLessThan(200);
 }
 return {rows,totals};
}
async function walkBackward(ctx:SessionContext,companyIds:string[],params:Record<string,string>,size:string){
 const pages:Row[][]=[];
 let k=parseKeysetPageQuery({size,last:'1'});
 for(;;){
  const read=await keysetPage(ctx,companyIds,params,k);pages.unshift(read.rows);
  if(!read.hasPrev)break;
  k=parseKeysetPageQuery({size,page:'3',before:read.rows[0].id});
  expect(pages.length,'the walk terminates').toBeLessThan(200);
 }
 return pages.flat();
}
const ids=(rows:readonly {id:string}[])=>rows.map(r=>r.id);
const scopeOf=async(ctx:SessionContext)=>(await allowedCompanies(ctx)).map(c=>c.id);
const SORTS=['applied','start','end','name','employeeCode','status'];

describe('Employee Leave Record keyset paging at group scale',()=>{
 it('reads the previous reader\'s rows in its order for every sortable column, both directions, every administrator',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  let crossedCap=false,belowCap=false;
  for(const [name,ctx] of Object.entries(fixture.personas)){
   const companyIds=await scopeOf(ctx);
   for(const sort of SORTS)for(const dir of ['asc','desc']){
    const params={sort,dir},label=`${name}/${sort}/${dir}`;
    const expected=await previous(ctx,companyIds,params);
    expect(expected.rows.length,`${label}: nonempty authorized source`).toBeGreaterThan(0);
    const forward=await walkForward(ctx,companyIds,params,'200');
    expect(ids(forward.rows),`${label}: same rows, same order`).toEqual(ids(expected.rows));
    for(const total of forward.totals)
     expect(total,`${label}: capped total`).toEqual(expected.total>LIST_COUNT_CAP?{count:LIST_COUNT_CAP,capped:true}:{count:expected.total,capped:false});
    if(expected.total>LIST_COUNT_CAP){
     crossedCap=true;
     if(sort==='applied')expect((await keysetPage(ctx,companyIds,params,parseKeysetPageQuery({count:'exact'}))).total).toEqual({count:expected.total,capped:false});
    }else{
     belowCap=true;
     if(sort==='employeeCode'||sort==='status')expect(ids(await walkBackward(ctx,companyIds,params,'25')),`${label}: Previous from Last`).toEqual(ids(expected.rows));
    }
   }
  }
  expect(crossedCap&&belowCap,'the administrators cover both sides of the cap').toBe(true);
  // The same rows carry the same fields as before, on the first page of the default order.
  const ctx=fixture.personas.single,companyIds=await scopeOf(ctx);
  const first=await keysetPage(ctx,companyIds,{},parseKeysetPageQuery({size:'50'}));
  expect(first.rows).toEqual((await previous(ctx,companyIds,{})).rows.slice(0,50));
 },600_000); // 3 administrators x 12 orders of 200-row walks over ~1,500 row-secured requests; hosted runners need headroom.

 it('never pages relative to a request the viewer cannot see',async()=>{
  const ctx=fixture.personas.single,companyIds=await scopeOf(ctx);
  const seen=new Set((await withTenant(ctx,tx=>tx.select({id:schema.leaveRequest.id}).from(schema.leaveRequest))).map(r=>r.id));
  const [hiddenInTenant]=await owner.db.select({id:schema.leaveRequest.id}).from(schema.leaveRequest).where(sql`${schema.leaveRequest.tenantId}=${b.tenantId}::uuid`);
  const hidden=[otherTenantRequest,...(seen.has(hiddenInTenant.id)?[]:[hiddenInTenant.id]),randomUUID()];
  const first=await keysetPage(ctx,companyIds,{},parseKeysetPageQuery({size:'25'}));
  for(const id of hidden)for(const cursor of [{after:id},{before:id}]){
   const read=await keysetPage(ctx,companyIds,{},parseKeysetPageQuery({size:'25',page:'5',...cursor}));
   expect(read.anchorFound).toBe(false);expect(read.hasPrev).toBe(false);
   expect(ids(read.rows)).toEqual(ids(first.rows));
  }
 },120_000);

 it('costs the same list statements for one company and 71 companies',async()=>{
  for(const [name,ctx] of [['group',fixture.personas.group],['multi',fixture.personas.multi]] as const){
   const all=await scopeOf(ctx),one=[fixture.companyIds[0]];
   expect(all.length).toBeGreaterThanOrEqual(70);
   await keysetPage(ctx,one,{},parseKeysetPageQuery({size:'25'})); // warm per-process caches
   const a=await observeStatements(()=>keysetPage(ctx,all,{sort:'name',dir:'asc'},parseKeysetPageQuery({size:'25'})));
   const o=await observeStatements(()=>keysetPage(ctx,one,{sort:'name',dir:'asc'},parseKeysetPageQuery({size:'25'})));
   expect(a.transactions,`${name}: one transaction`).toBe(1);
   const list=(s:{sql:string}[])=>s.filter(x=>/from "leave_request"/.test(x.sql)).map(x=>x.sql);
   expect(list(a.statements).length,`${name}: page and capped count`).toBeGreaterThanOrEqual(2);
   expect(list(a.statements),`${name}: same list statements`).toEqual(list(o.statements));
   for(const statement of a.statements)expect(statement.sql,`${name}: no OFFSET`).not.toMatch(/\boffset\b/i);
  }
 },120_000);
});
