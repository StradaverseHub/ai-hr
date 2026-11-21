import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {roleAssignment,company} from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {resolveMyTeamRosterScope,readMyTeam} from '../core/my-team';
import * as readOwner from '../core/read';
import * as rosterOwner from '../core/roster';
import {filterMyTeamSearch} from '../core/my-team-scope';
import {todayInKualaLumpur} from '../lib/hr-date';
import {weekRangeOf} from '../lib/roster-month';
import type {MyTeamQuery} from '../lib/my-team-types';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base,ctx:SessionContext,subject:{personId:string;employmentId:string},downline:{personId:string;employmentId:string};
const today=todayInKualaLumpur(),query:MyTeamQuery={view:'week',scope:'all',anchorDate:today};
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const hire=(name:string)=>hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const manager=await hire('Fictional membership manager');subject=await hire('Fictional membership direct');downline=await hire('Fictional membership downline');await hire('Fictional excluded colleague');
 const userId=await createAppUser(b.tenantId,manager.personId,'manager');
 ctx={...await entitledCtx(b,['manager']),userId,personId:manager.personId,roles:['manager'],grants:[{role:'manager',companyId:null}]};
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:downline.employmentId,managerEmploymentId:subject.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
});
afterEach(()=>vi.restoreAllMocks());

it('returns exact team/search/date scope without roster or balance hydration, including the stored calling-person rule',async()=>{
 const balances=vi.spyOn(readOwner,'leaveBalances'),roster=vi.spyOn(rosterOwner,'rosterWindowView');
 const all=await resolveMyTeamRosterScope(ctx,query),period=weekRangeOf(today);
 expect(all).toEqual({companyIds:[b.companyId],employmentIds:[subject.employmentId,downline.employmentId],from:period.from,to:period.to,canEditRoster:false});
 // Native fullName ordering puts "direct" before "downline".
 expect(all.employmentIds).toEqual([subject.employmentId,downline.employmentId]);
 expect((await resolveMyTeamRosterScope(ctx,{...query,scope:'direct'})).employmentIds).toEqual([subject.employmentId]);
 expect((await resolveMyTeamRosterScope(ctx,{...query,search:'  DOWNLINE  '})).employmentIds).toEqual([downline.employmentId]);
 expect((await resolveMyTeamRosterScope(ctx,{...query,employmentId:downline.employmentId})).employmentIds).toEqual([downline.employmentId]);
 expect((await resolveMyTeamRosterScope(ctx,{...query,companyIds:[]})).employmentIds).toEqual([]);
 expect((await resolveMyTeamRosterScope({...ctx,personId:randomUUID()},query))).toEqual(all);
 expect(await resolveMyTeamRosterScope(ctx,{...query,view:'month',anchorDate:'2026-11-01'})).toMatchObject({from:'2026-10-26',to:'2026-12-06'});
 expect(balances).not.toHaveBeenCalled();expect(roster).not.toHaveBeenCalled();
 balances.mockRestore();roster.mockRestore();
 const canonical=await readMyTeam(ctx,query);
 expect(all).toEqual({companyIds:canonical.query.companyIds,employmentIds:canonical.gridEmploymentIds,from:canonical.period.gridDates[0],to:canonical.period.gridDates.at(-1),canEditRoster:canonical.scope.canEditRoster});
});

it('finishes behind an actual uncommitted role-revocation writer, then refuses the next snapshot',async()=>{
 let entered!:()=>void,release!:()=>void;
 const reached=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const writer=database.withTenant(adminCtx(b),async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);
  await tx.delete(roleAssignment).where(eq(roleAssignment.appUserId,ctx.userId!));entered();await held;
 });
 let timer:ReturnType<typeof setTimeout>|undefined,read:Promise<unknown>|undefined;
 try{
  await reached;read=resolveMyTeamRosterScope(ctx,query);
  const result=await Promise.race([read,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Scope waited behind Access writer')),2500);})]);
  expect(result).toMatchObject({employmentIds:[subject.employmentId,downline.employmentId]});
 }finally{clearTimeout(timer);release();await writer;await Promise.allSettled(read?[read]:[]);}
 await expect(resolveMyTeamRosterScope(ctx,query)).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
});

it('uses an enforced readonly snapshot and refuses persisted writes with SQLSTATE 25006',async()=>{
 const original=database.withTenant;let mode:unknown;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof original>[2])=>original(context,async tx=>{
  const [row]=await tx.execute(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly`);
  mode=row;
  return read(tx);
 },options));
 await resolveMyTeamRosterScope(ctx,query);expect(mode).toEqual({isolation:'repeatable read',readonly:'on'});spy.mockRestore();
 const failure=await database.withTenant(ctx,tx=>tx.update(company).set({legalName:'Must not persist'}).where(eq(company.id,b.companyId)),{readOnlySnapshot:true}).catch(error=>error);
 const errors:unknown[]=[];for(let e:unknown=failure;e instanceof Error;e=(e as Error&{cause?:unknown}).cause)errors.push((e as Error&{code?:string}).code);
 expect(errors).toContain('25006');
 expect((await owner.db.select({name:company.legalName}).from(company).where(eq(company.id,b.companyId)))[0].name).toBe('Acme Sdn Bhd');
});

it('captures nested request inputs and keeps invalid/foreign/department authority refusals explicit',async()=>{
 const mutable=structuredClone(ctx),input:MyTeamQuery={...query,companyIds:[b.companyId]};
 const original=database.withTenant;let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(async<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof original>[2])=>{await gate;return original(context,read,options);});
 const pending=resolveMyTeamRosterScope(mutable,input);
 mutable.userId=randomUUID();mutable.roles!.splice(0,1,'employee');mutable.grants![0].companyId=randomUUID();input.companyIds![0]=randomUUID();input.search='not a visible match';
 release();expect((await pending).employmentIds).toEqual([subject.employmentId,downline.employmentId]);spy.mockRestore();
 const foreign=await seedBase();
 expect((await resolveMyTeamRosterScope(ctx,{...query,companyIds:[foreign.companyId]})).employmentIds).toEqual([]);
 await expect(resolveMyTeamRosterScope({...ctx,userId:foreign.adminUserId},query)).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
 await expect(resolveMyTeamRosterScope(ctx,{...query,scope:'department',departmentId:b.deptA})).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
 const transactions=vi.spyOn(database,'withTenant');
 await expect(resolveMyTeamRosterScope(ctx,{...query,anchorDate:'2026-02-30'})).rejects.toThrow('MY_TEAM_QUERY_INVALID');
 expect(transactions).not.toHaveBeenCalled();
});

it('shares the exact joined name/code substring search while preserving input order',()=>{
 const rows=[{name:'Alpha',employeeCode:'BETA'},{name:'Älice',employeeCode:null},{name:'alpha beta',employeeCode:'C'}];
 expect(filterMyTeamSearch(rows,'  HA be  ')).toEqual([rows[0],rows[2]]);
 expect(filterMyTeamSearch(rows,'äL')).toEqual([rows[1]]);expect(filterMyTeamSearch(rows,' ')).toEqual(rows);
});
