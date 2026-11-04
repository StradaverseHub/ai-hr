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
import {myLeaveDashboard,myCurrentLeaveCards} from '../packs/leave/service';
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
  const [state]=await tx.execute<{role:string;readOnly:boolean;isolation:string}>(sql`select current_user as role,current_setting('transaction_read_only')='on'as "readOnly",current_setting('transaction_isolation')as isolation`);transactionStates.push(state);
  return read(new Proxy(tx,{
  get(target,property,receiver){const value=Reflect.get(target,property,receiver);if(property==='selectDistinct')return(...args:unknown[])=>{
   const fields=args[0] as Record<string,unknown>|undefined;if(fields?.d===schema.leaveLedger.effectiveOn)historicalReads++;
   return Reflect.apply(value,target,args);
  };return typeof value==='function'?value.bind(target):value;},
 }));},options));
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
  expect(homeTransactions,'Home Time Off must use one complete read-only snapshot, without nested transactions').toBe(1);
  expect(homeTransactionStates.every(state=>state.role==='ai_hr_app'&&state.readOnly&&state.isolation==='repeatable read')).toBe(true);
  // Neither reusable entry point accepts a mutable or Read Committed carrier.
  for(const readOnly of [false,true]){
   await expect(actual(ctx,async tx=>{
    if(readOnly)await tx.execute(sql`set transaction read only`);
    return requireOwnHomeSubjectTx(tx,ctx,employee.employmentId);
   })).rejects.toMatchObject({code:'employmentUnavailable'});
   await expect(actual(ctx,async tx=>{
    if(readOnly)await tx.execute(sql`set transaction read only`);
    return myCurrentLeaveCards(ctx,employee.employmentId,{today,locale:'en'},tx);
   })).rejects.toThrow('complete read-only snapshot');
  }
 }finally{spy.mockRestore();}
});
