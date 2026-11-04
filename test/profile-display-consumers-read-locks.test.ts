/** Actual own-profile display consumers under an independent metadata-reader barrier. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {readOwnProfileWorkspace} from '../core/profile-edit';
import {readOwnProfileFacts} from '../core/profile-view';
import {myProfileChangeRequests} from '../core/profile';
import {readProfilePresentationPolicy} from '../core/profile-edit-policy';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('allows standalone workspace, facts and own request history to overlap metadata readers',async()=>{
 await resetDb();const b=await seedBase(),employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional profile display',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee']};
 const presentation=await readProfilePresentationPolicy(ctx);
 const readers={workspace:()=>readOwnProfileWorkspace(ctx,{employmentId:employee.employmentId}),facts:()=>readOwnProfileFacts(ctx,employee.employmentId),history:()=>myProfileChangeRequests(ctx),pageWorkspace:()=>readOwnProfileWorkspace(ctx,{employmentId:employee.employmentId},presentation),pageHistory:()=>myProfileChangeRequests(ctx,50,presentation)};
 const baseline={workspace:await readers.workspace(),facts:await readers.facts(),history:await readers.history()};
 expect(baseline.workspace.employmentId).toBe(employee.employmentId);expect(baseline.workspace.visible.length).toBeGreaterThan(0);expect(baseline.history).toEqual([]);
 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  const actual=database.withTenant;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);return read(tx);
  },options));
  try{
   const names=Object.keys(readers) as (keyof typeof readers)[];
   const results=await Promise.allSettled(names.map(name=>readers[name]()));
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'profile-display-consumers-read-locks.json'),JSON.stringify({kind:'REAL_PROFILE_CONSUMERS_READ_LOCK_COMPONENT_ONLY',releaseEligible:false,results:results.map((row,i)=>({reader:names[i],status:row.status,sqlState:row.status==='rejected'?pgSqlState(row.reason):null}))},null,2));
   expect(results.map(row=>row.status)).toEqual(['fulfilled','fulfilled','fulfilled','fulfilled','fulfilled']);
   for(const [i,row] of results.entries())if(row.status==='fulfilled'){
    if(names[i]==='history'||names[i]==='pageHistory')expect(row.value).toEqual(baseline.history);
    if(names[i]==='workspace'||names[i]==='pageWorkspace')expect(row.value).toMatchObject({employmentId:baseline.workspace.employmentId,personId:baseline.workspace.personId,visible:baseline.workspace.visible,editable:baseline.workspace.editable});
    if(names[i]==='facts')expect(row.value).toMatchObject({header:baseline.facts.header});
   }
  }finally{spy.mockRestore();}
 });
});
