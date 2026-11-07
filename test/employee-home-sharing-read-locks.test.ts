/** Actual Home sharing consumers must overlap independent access readers. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {readHomeTeamPage,readHomeCelebrationPage,readHomeTeamCalendar} from '../core/employee-home-sharing';
import {readEmployeeHomeSummary} from '../core/employee-home-summary';
import {readEmployeeHomeTimeOff} from '../core/employee-home-time-off';
import {readEmployeeHomeCalendar} from '../core/employee-home-calendar';
import {readEmployeeHomeTasks} from '../core/employee-home-tasks';
import {readEmployeeHomeGreeting} from '../core/employee-home-greeting';
import {readEmployeeHomeToday} from '../core/employee-home-today';
import {readEmployeeHomeNotices} from '../core/employee-home-notices';
import {saveEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it.each(['reader','writer'] as const)('lets actual Home card aggregations coexist with an access %s',async(mode)=>{
 await resetDb();const b=await seedBase(),on=todayInKualaLumpur();
 const hire=(name:string)=>hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const own=await hire('Fictional Home reader');await hire('Fictional Home peer');
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,own.personId,'employee'),personId:own.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 const configuration=defaultEmployeeHomeConfiguration();configuration.teamVisibility='department';configuration.celebrations={enabled:true,scope:'department'};
 await saveEmployeeHomeConfiguration(adminCtx(b),{companyId:b.companyId,audienceRole:'employee',expectedOrdinal:0,configuration,reason:'Fictional read concurrency check'});
 const readers={team:()=>readHomeTeamPage(ctx,own.employmentId,{date:on}),celebrations:()=>readHomeCelebrationPage(ctx,own.employmentId),calendar:()=>readHomeTeamCalendar(ctx,own.employmentId,on,on),
  summary:async()=>{const {serverNow,...value}=await readEmployeeHomeSummary(ctx,own.employmentId,'en','Replacement holiday');return value;},
  timeOff:()=>readEmployeeHomeTimeOff(ctx,own.employmentId,'en'),
  ownCalendar:()=>readEmployeeHomeCalendar(ctx,own.employmentId,on.slice(0,7)),
  tasks:()=>readEmployeeHomeTasks(ctx,own.employmentId),
  greeting:async()=>{const {serverNow,...value}=await readEmployeeHomeGreeting(ctx,own.employmentId,'en');return value;},
  today:async()=>{const {serverNow,...value}=await readEmployeeHomeToday(ctx,own.employmentId);return value;},
  notices:()=>readEmployeeHomeNotices(ctx,own.employmentId)};
 const names=Object.keys(readers) as (keyof typeof readers)[];
 const baseline=await Promise.all(names.map(name=>readers[name]()));expect(baseline[0]).toMatchObject({totalPeople:1});
 await owner.client.begin(async holder=>{
  if(mode==='reader')await holder`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  else await holder`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  const actual=database.withTenant;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?: Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);return read(tx);
  },options));
  try{
   const results=await Promise.allSettled(names.map(name=>readers[name]()));
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'home-sharing-'+mode+'-locks.json'),JSON.stringify({kind:'ACTUAL_HOME_SHARING_READ_CONCURRENCY_COMPONENT_ONLY',releaseEligible:false,heldAccessMode:mode,results:results.map((row,i)=>({reader:names[i],status:row.status,sqlState:row.status==='rejected'?pgSqlState(row.reason):null}))},null,2));
   expect(results.map(row=>row.status)).toEqual(names.map(()=>'fulfilled'));
   for(const [i,row]of results.entries())if(row.status==='fulfilled')expect(row.value).toEqual(baseline[i]);
  }finally{spy.mockRestore();}
 });
});
