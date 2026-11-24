/** ADR 0181 decision 5 (Phase 4), item 4: hot list reads send a company list as ONE `= any($n::uuid[])` parameter.
 *
 * drizzle `inArray(column, ids)` and hand-built `ARRAY[$1, $2, ...]` sent one bind parameter per company, so the same
 * read over 10 and over 74 companies was two statements to the planner and two rows in pg_stat_statements, and a
 * 70-company group paid a 70-parameter parse on every list. On the fictional 71-company group
 * (test/helpers/ai-centre-scale-fixture.ts), for the group administrator, every converted reader below sends the same
 * statement text, the same number of statements and the same number of parameters for one company and for 71
 * companies, and still answers the same rows: All companies equals no company filter, and one company is a
 * non-empty subset. All names are invented. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {
 countEmployeesInScope,employmentPickerList,leaveBalancesAll,listEmployeesPage,listLeaveApprovers,listLeaveRequests,
 listManagerCandidates,listPendingLeaveCancellations,listWorkforcePickOptions,orgChartWindowFullData,plannedAbsences,
 replacementLeaveSummary,awayTodayCount,
} from '../core/read';
import {pendingLeaveTaskMetadata} from '../core/leave';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,migrateTestDb,resetDb,seedBase} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let fixture:ScaleFixture,ctx:SessionContext;
beforeAll(async()=>{
 await migrateTestDb();await resetDb();const b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1000,events:0});
 ctx=fixture.personas.group;
},300_000);
afterAll(closeAll);

const today=todayInKualaLumpur();
type Reader=(companyIds:string[]|undefined)=>Promise<unknown>;
const READERS:Record<string,Reader>={
 'listEmployeesPage (directory)':ids=>listEmployeesPage(ctx,{companyIds:ids,limit:50,offset:0}),
 'listEmployeesPage (Personnel overview)':ids=>listEmployeesPage(ctx,{companyIds:ids??fixture.companyIds as string[],limit:50,offset:0},'workforce'),
 employmentPickerList:ids=>employmentPickerList(ctx,ids),
 listWorkforcePickOptions:ids=>listWorkforcePickOptions(ctx,ids),
 orgChartWindowFullData:ids=>orgChartWindowFullData(ctx,ids),
 leaveBalancesAll:ids=>leaveBalancesAll(ctx,ids),
 replacementLeaveSummary:ids=>replacementLeaveSummary(ctx,ids),
 listLeaveApprovers:ids=>listLeaveApprovers(ctx,ids),
 listLeaveRequests:ids=>listLeaveRequests(ctx,ids),
 listPendingLeaveCancellations:ids=>listPendingLeaveCancellations(ctx,ids),
 pendingLeaveTaskMetadata:ids=>pendingLeaveTaskMetadata(ctx,ids),
 plannedAbsences:ids=>plannedAbsences(ctx,ids,{from:today,to:today}),
 awayTodayCount:ids=>awayTodayCount(ctx,ids,today),
 countEmployeesInScope:ids=>countEmployeesInScope(ctx,{companyIds:ids}),
 listManagerCandidates:ids=>listManagerCandidates(ctx,{companyIds:ids}),
};
/** Readers whose undefined company list means "every company the caller may see", so All companies must equal it. */
const UNFILTERED_EQUALS_ALL=['listEmployeesPage (directory)','employmentPickerList','leaveBalancesAll','countEmployeesInScope'];

describe('one company-list parameter for hot list reads',()=>{
 it.each(Object.keys(READERS))('%s: one statement shape for 1 and 71 companies',async name=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  const read=READERS[name],all=[...fixture.companyIds],one=[fixture.companyIds[0]];
  // Warm once: the first read in a file also fills per-process caches (one extra statement), which is not a
  // per-company cost.
  await read(one);
  const a=await observeStatements(()=>read(all)),o=await observeStatements(()=>read(one));
  expect(a.statements.length,`${name}: statements`).toBe(o.statements.length);
  expect(a.statements.map(s=>s.sql),`${name}: same statement text`).toEqual(o.statements.map(s=>s.sql));
  expect(a.statements.map(s=>s.params.length),`${name}: same parameter count`).toEqual(o.statements.map(s=>s.params.length));
  // No statement carries one parameter per company any more.
  for(const statement of a.statements)expect(statement.params.length,`${name}: parameters`).toBeLessThan(all.length);
  if(UNFILTERED_EQUALS_ALL.includes(name)){
   expect(await read(all),`${name}: All companies answers like no filter`).toEqual(await read(undefined));
   // The fixture's largest company holds employments; it has no leave balances, so only the people reads must be non-empty.
   if(name!=='leaveBalancesAll'){const subset=await read(one);expect(JSON.stringify(subset),`${name}: one company answers something`).not.toMatch(/^(\[\]|0)$/);}
  }
 },60_000);
});
