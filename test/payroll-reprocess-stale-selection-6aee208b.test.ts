/**
 * 6aee208b — "Reprocess Required" selection across pages, proved against the native readers at group shape.
 *
 * The reporter approved: every employee the run marked stale arrives ticked on EVERY page, and the list splits
 * into Reprocess Required / Processed / No Change tabs with their own counts. This file proves the two reads
 * that carry that, with fictional fixtures at the shape of a real group (SCALE-AND-RELEASE-RULES 3: 70+
 * companies, 1,200 payslips on one run, about 300 stale spread across every page):
 *
 *   - `reprocessStaleSelection` returns every stale employee with a payslip ONCE, in list order, and counts
 *     the stale employees without one, so the screen reconciles with the Payroll Process count
 *     (`reprocessEmploymentIds`, the raw stored set);
 *   - `payrollEmployeeSelectionPage` with a tab pages each population with no duplicate and no gap at 25, 50
 *     and 200 rows, its tab counts agree with the populations, search narrows within a tab, and without a tab
 *     it is still the previous whole-run reader (equivalence against `batchDetail`);
 *   - a cleared, closed or draft run, a leftover `recalc_employment_ids`, and another tenant mark nobody;
 *   - every native role, under "All companies" and under one company, sees a stale set consistent with what
 *     the previous reader lets it see.
 *
 * Neither read changes any figure: detection, the reprocess job, tax readiness and calculations are untouched.
 */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {batchDetail,createBatch,generatePayslips,payrollEmployeeSelectionPage,reprocessStaleSelection} from '../core/payroll';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {reprocessEmploymentIds} from '../app/payroll/dashboard-logic';
import {paginateRows,parsePageQuery} from '../lib/pagination';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);

/** Every page of one tab at one size, concatenated — what an operator paging to the end would have seen. */
async function allPages(ctx:SessionContext,batchId:string,tab:'required'|'unchanged',size:string,search?:string){
 const ids:string[]=[];let total=-1;
 for(let page=0;page<1000;page++){
  const r=await payrollEmployeeSelectionPage(ctx,{batchId,kind:'reprocess',page:parsePageQuery({page:String(page),size}),search,tab});
  expect(r.tab).toBe(tab);
  if(total<0)total=r.state.total;else expect(r.state.total,'the total moved between pages').toBe(total);
  expect(r.rows.every(row=>row.stale===(tab==='required'))).toBe(true);
  ids.push(...r.rows.map(row=>row.employmentId));
  if(!r.state.hasNext)return {ids,total,counts:r.tabCounts};
 }
 throw new Error('pager never ended');
}

it('ticks every stale employee once across pages, splits the tabs exactly and reconciles with the Payroll Process count',async()=>{
 await resetDb();const b=await seedBase(),root=adminCtx(b),foreign=adminCtx(await seedBase());
 const target=await hireEmployee(root,{person:{fullName:'Fictional stale selection person',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'0001',employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:target.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});
 await setStatutoryProfileMY(root,{personId:target.personId,icNumber:'900101015552',taxCategory:1,numChildren:0});
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01'});await generatePayslips(root,{batchId});
 const {batchId:draftId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-02'});
 const [actual]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId));expect(actual).toBeTruthy();
 // 1,199 more fictional payslips cloned from the real one (no figure is recomputed by anything here).
 const extra=Array.from({length:1199},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),i}));
 for(let i=0;i<extra.length;i+=200){
  const members=extra.slice(i,i+200);
  await owner.db.insert(s.person).values(members.map(m=>({id:m.personId,tenantId:b.tenantId,fullName:'Fictional payee '+String(m.i%1150).padStart(4,'0'),primaryEmail:m.personId+'@example.invalid'})));
  await owner.db.insert(s.employment).values(members.map(m=>({id:m.employmentId,tenantId:b.tenantId,personId:m.personId,companyId:b.companyId,hiredOn:'2020-01-01',employeeCode:'FX-'+String(m.i).padStart(4,'0')})));
  await owner.db.insert(s.payslip).values(members.map(m=>({...actual,id:randomUUID(),employmentId:m.employmentId})));
 }
 // Group shape: seventy companies in the tenant, plus one a scoped administrator is limited to.
 await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional stale group '+i})));
 const [otherCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other company'}).returning({id:s.company.id});
 for(const name of ['person','employment','payslip','payroll_batch','role_assignment'])await owner.client.unsafe('analyze public.'+name);

 const exact=await batchDetail(root,batchId);expect(exact?.slips).toHaveLength(1200);
 // The previous reader's order: name, then payslip id.
 const ordered=[...exact!.slips].sort((x,y)=>x.name<y.name?-1:x.name>y.name?1:x.id.localeCompare(y.id));
 // About 300 stale, spread over every page: every fourth payslip in list order.
 const staleOnRun=ordered.filter((_,i)=>i%4===1);expect(staleOnRun.length).toBe(300);
 const noPayslip=[randomUUID(),randomUUID()];
 // The column is jsonb: a duplicate, a number and an empty string are ignored exactly as the count ignores them.
 const stored=[...staleOnRun.map(r=>r.employmentId),...noPayslip,staleOnRun[0].employmentId,7,''];
 await owner.db.update(s.payrollBatch).set({needsRecalcAt:new Date(),recalcEmploymentIds:sql`${JSON.stringify(stored)}::jsonb`}).where(eq(s.payrollBatch.id,batchId));
 const [marked]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId));
 const dashboardCount=reprocessEmploymentIds(marked).length;expect(dashboardCount).toBe(302);

 // ── The stale reader ────────────────────────────────────────────────────────────────────────────────
 const selection=await reprocessStaleSelection(root,batchId);
 expect(selection.rows).toEqual(staleOnRun.map(r=>({employmentId:r.employmentId,employeeCode:r.employeeCode,name:r.name})));
 expect(new Set(selection.rows.map(r=>r.employmentId)).size).toBe(300);
 expect(selection.withoutPayslip).toBe(2);
 expect(selection.rows.length+selection.withoutPayslip,'the screen total must equal the Payroll Process count').toBe(dashboardCount);

 // ── The tabs, page by page, at every offered size ────────────────────────────────────────────────────
 const staleIds=staleOnRun.map(r=>r.employmentId),unchangedIds=ordered.filter((_,i)=>i%4!==1).map(r=>r.employmentId);
 for(const size of ['25','50','200']){
  const required=await allPages(root,batchId,'required',size);
  expect(required.ids,`required @${size}`).toEqual(staleIds);
  expect(required.total).toBe(300);expect(required.counts).toEqual({required:300,unchanged:900});
  const unchanged=await allPages(root,batchId,'unchanged',size);
  expect(unchanged.ids,`unchanged @${size}`).toEqual(unchangedIds);
  expect(unchanged.total).toBe(900);
 }
 // No tab given in the address ⇒ Reprocess Required, because it has people.
 const opened=await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:parsePageQuery(),tab:'default'});
 expect(opened.tab).toBe('required');expect(opened.runTotal).toBe(1200);
 expect(opened.rows.map(r=>r.employmentId)).toEqual(staleIds.slice(0,25));
 // Money is still the payslip's own, joined after the tab narrowed the page.
 expect(opened.rows.map(r=>({id:r.id,gross:r.gross,net:r.net,version:r.version}))).toEqual(staleOnRun.slice(0,25).map(r=>({id:r.id,gross:r.gross,net:r.net,version:r.version})));
 // Without a tab the reader is the previous whole-run reader: same rows, order, counts.
 for(const raw of [{},{page:'3',size:'50'},{size:'all'}]){
  const q=parsePageQuery(raw),whole=await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:q});
  const expected=paginateRows(ordered,q);
  expect(whole.tab).toBe('all');expect(whole.state).toEqual(expected.state);expect(whole.runTotal).toBe(1200);
  expect(whole.rows.map(r=>r.id)).toEqual(expected.rows.map(r=>r.id));
  expect(whole.rows.map(r=>r.stale)).toEqual(expected.rows.map(r=>staleIds.includes(r.employmentId)));
 }
 // Remove never reads the mark.
 const removal=await payrollEmployeeSelectionPage(root,{batchId,kind:'remove',page:parsePageQuery(),tab:'required'});
 expect(removal.tab).toBe('all');expect(removal.state.total).toBe(1200);expect(removal.rows.every(r=>r.stale===false)).toBe(true);

 // ── Search inside a tab: the tab counts are search-filtered, runTotal is not ─────────────────────────
 const needle='Fictional payee 01';
 const hit=(r:{name:string})=>r.name.toLowerCase().includes(needle.toLowerCase());
 const searched=await allPages(root,batchId,'required','25',needle);
 expect(searched.ids).toEqual(staleOnRun.filter(hit).map(r=>r.employmentId));
 expect(searched.counts).toEqual({required:staleOnRun.filter(hit).length,unchanged:ordered.filter((r,i)=>i%4!==1&&hit(r)).length});
 expect(searched.ids.length).toBeGreaterThan(0);
 const byCode=await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:parsePageQuery(),search:'fx'+staleOnRun[5].employeeCode!.slice(3),tab:'required'});
 expect(byCode.rows.map(r=>r.employmentId)).toContain(staleOnRun[5].employmentId);
 expect(byCode.runTotal).toBe(1200);

 // ── Every native role, group-wide and company-scoped ────────────────────────────────────────────────
 for(const role of s.roleEnum.enumValues)for(const companyId of (role==='super_admin'?[null]:[null,b.companyId,otherCompany.id])){
  const userId=await createAppUser(b.tenantId,null,'employee');
  await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who:SessionContext={...root,userId,personId:null,roles:[role],grants:[{role,companyId}]};
  const label=`${role}:${companyId??'all'}`;
  const outcome=async<T>(read:()=>Promise<T>)=>{try{return{value:await read()};}catch(e){return{error:String(e)};}};
  const old=await outcome(()=>batchDetail(who,batchId));
  const now=await outcome(()=>reprocessStaleSelection(who,batchId));
  const tabbed=await outcome(()=>payrollEmployeeSelectionPage(who,{batchId,kind:'reprocess',page:parsePageQuery({size:'all'}),tab:'required'}));
  if('error' in old){expect('error' in now,label).toBe(true);expect('error' in tabbed,label).toBe(true);continue;}
  expect('value' in now&&'value' in tabbed,label).toBe(true);
  const visibleStale=(old.value?.slips??[]).filter(r=>staleIds.includes(r.employmentId)).map(r=>r.employmentId);
  const sel=(now as {value:Awaited<ReturnType<typeof reprocessStaleSelection>>}).value;
  const page=(tabbed as {value:Awaited<ReturnType<typeof payrollEmployeeSelectionPage>>}).value;
  expect(new Set(sel.rows.map(r=>r.employmentId)),label).toEqual(new Set(visibleStale));
  expect(sel.rows.length+sel.withoutPayslip,label).toBe(old.value?302:0);
  expect(new Set(page.rows.map(r=>r.employmentId)),label).toEqual(new Set(visibleStale));
  expect(page.state.total,label).toBe(visibleStale.length);
 }
 // Another tenant sees nothing of this run.
 expect(await reprocessStaleSelection(foreign,batchId)).toEqual({rows:[],withoutPayslip:0});

 // ── Runs that owe nothing mark nobody, whatever the column still holds ───────────────────────────────
 await owner.db.update(s.payrollBatch).set({needsRecalcAt:sql`now()`,recalcEmploymentIds:staleIds}).where(eq(s.payrollBatch.id,draftId));
 expect(await reprocessStaleSelection(root,draftId)).toEqual({rows:[],withoutPayslip:0});
 // A cleared mark with a leftover id list (the timestamp is what says the run owes anything).
 await owner.db.update(s.payrollBatch).set({needsRecalcAt:null}).where(eq(s.payrollBatch.id,batchId));
 expect(await reprocessStaleSelection(root,batchId)).toEqual({rows:[],withoutPayslip:0});
 const cleared=await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:parsePageQuery(),tab:'default'});
 expect(cleared.tab).toBe('unchanged');expect(cleared.tabCounts).toEqual({required:0,unchanged:1200});expect(cleared.state.total).toBe(1200);
 const emptyRequired=await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:parsePageQuery(),tab:'required'});
 expect(emptyRequired.rows).toEqual([]);expect(emptyRequired.state.total).toBe(0);expect(emptyRequired.runTotal).toBe(1200);
 // A closed run, even with the mark still set.
 await owner.db.update(s.payrollBatch).set({status:'closed',closedAt:new Date(),needsRecalcAt:new Date()}).where(eq(s.payrollBatch.id,batchId));
 expect(await reprocessStaleSelection(root,batchId)).toEqual({rows:[],withoutPayslip:0});
 expect((await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:parsePageQuery(),tab:'required'})).state.total).toBe(0);
},600000);
