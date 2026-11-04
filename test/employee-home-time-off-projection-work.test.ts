/** Home needs current card figures, not the historical-year selector's ledger date catalogue. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {myLeaveDashboard,myCurrentLeaveCards,leaveTypeApplySummaries} from '../packs/leave/service';
import {leaveEntitlementBreakdowns} from '../core/read';
import {requireOwnHomeSubjectTx} from '../core/employee-home';
import {readEmployeeHomeTimeOff} from '../core/employee-home-time-off';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains exact canonical current figures without loading historical ledger dates for Home',async()=>{
 await resetDb();const b=await seedBase(),today=todayInKualaLumpur(),year=Number(today.slice(0,4));
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional current leave',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2000-01-01'});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 await owner.db.insert(schema.leaveLedger).values(Array.from({length:11},(_,i)=>({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual' as const,days:i===0?'20.00':'1.00',effectiveOn:String(year-i)+'-01-01'})));
 let historicalReads=0,transactions=0;const transactionStates:{role:string;readOnly:boolean;isolation:string}[]=[];const actual=database.withTenant;
 // The observer delegates every builder and query to the real app-role transaction. It counts
 // only the historical date-list projection; identity, eligibility and figures are never mocked.
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(context,async tx=>{transactions++;
  const result=await read(new Proxy(tx,{
  get(target,property,receiver){const value=Reflect.get(target,property,receiver);if(property==='selectDistinct')return(...args:unknown[])=>{
   const fields=args[0] as Record<string,unknown>|undefined;if(fields?.d===schema.leaveLedger.effectiveOn)historicalReads++;
   return Reflect.apply(value,target,args);
  };return typeof value==='function'?value.bind(target):value;},
 }));
  const [state]=await tx.execute<{role:string;readOnly:boolean;isolation:string}>(sql`select current_user as role,current_setting('transaction_read_only')='on'as "readOnly",current_setting('transaction_isolation')as isolation`);transactionStates.push(state);
  return result;},options));
 try{
  const canonical=await myLeaveDashboard(ctx,employee.employmentId,{today,locale:'en'}),dashboardHistoryReads=historicalReads;
  expect(canonical.cards.length).toBeGreaterThan(0);expect(canonical.years).toContain(year-1);expect(dashboardHistoryReads).toBeGreaterThan(0);
  historicalReads=0;transactions=0;transactionStates.length=0;const start=performance.now(),home=await readEmployeeHomeTimeOff(ctx,employee.employmentId,'en'),elapsedMs=performance.now()-start,homeHistoryReads=historicalReads,homeTransactions=transactions,homeTransactionStates=[...transactionStates];
  expect(home.balances).toEqual(canonical.cards.map(card=>({id:card.leaveTypeId,name:card.leaveType,annualLeave:card.annualLeave,available:card.canApplyFor,pending:card.pending})));
  const expectedCurrent=canonical.cards.map(({leaveTypeId,leaveType,annualLeave,canApplyFor,pending})=>({leaveTypeId,leaveType,annualLeave,canApplyFor,pending}));
  // Home's purpose cannot be turned into a historical read by an untyped posted year.
  expect(await myCurrentLeaveCards(ctx,employee.employmentId,{today,locale:'en',...{year:String(year-1)}})).toEqual(expectedCurrent);
  const previous=await myLeaveDashboard(ctx,employee.employmentId,{today,locale:'en',year:String(year-1)});
  expect(previous.selectedYear).toBe(year-1);expect(previous.cards.length).toBeGreaterThan(0);
  historicalReads=0;const fullAgain=await myLeaveDashboard(ctx,employee.employmentId,{today,locale:'en'});
  expect(fullAgain).toEqual(canonical);expect(historicalReads).toBeGreaterThan(0);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'home-time-off-projection-work.json'),JSON.stringify({kind:'ACTUAL_HOME_CURRENT_FIGURES_COMPONENT_ONLY',releaseEligible:false,dashboardHistoryReads,homeHistoryReads,homeTransactions,homeTransactionStates,fullHistoryStillAvailable:true,cardCount:home.balances.length,exactCanonicalFigures:true,elapsedMs},null,2));
  expect(homeHistoryReads,'Home must not read the past-year selector date catalogue').toBe(0);
  expect(homeTransactions,'Home Time Off must use one complete read-only transaction, without nested transactions').toBe(1);
  expect(homeTransactionStates.every(state=>state.role==='ai_hr_app'&&state.readOnly&&state.isolation==='read committed')).toBe(true);
  // Keep the canonical fresh-principal contract: refuse mutable and Repeatable Read carriers.
  for(const options of [undefined,{readOnlySnapshot:true}] as const){
   await expect(actual(ctx,tx=>requireOwnHomeSubjectTx(tx,ctx,employee.employmentId),options)).rejects.toMatchObject({code:'employmentUnavailable'});
   await expect(actual(ctx,tx=>myCurrentLeaveCards(ctx,employee.employmentId,{today,locale:'en'},tx),options)).rejects.toThrow('read-only Read Committed transaction');
  }
  // The new batched seams must bind the supplied context to the actual carrier as well.
  const forged={...ctx,userId:randomUUID()};
  await actual(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);
   await expect(leaveEntitlementBreakdowns(forged,employee.employmentId,[{leaveTypeId:b.annualLeaveTypeId,asOf:today}],'en',tx)).rejects.toThrow('calling authority');
   await expect(leaveTypeApplySummaries(forged,employee.employmentId,[b.annualLeaveTypeId],tx)).rejects.toThrow('calling authority');
  });

 }finally{spy.mockRestore();}
});
