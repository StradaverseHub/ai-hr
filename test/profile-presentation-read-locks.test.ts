/** Real display readers must overlap metadata readers; write owners still need exclusive barriers. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {hasPersonPhoto} from '../core/person-photo';
import {readProfilePresentationPolicy} from '../core/profile-edit-policy';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('overlaps real profile presentation and Home photo checks with an independent metadata reader',async()=>{
 await resetDb();const b=await seedBase();
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional policy reader',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee']};
 const expected=await readProfilePresentationPolicy(ctx),expectedPhoto=await hasPersonPhoto(ctx,employee.personId);
 expect(expected.visible.size).toBeGreaterThan(0);expect(expectedPhoto).toBe(false);
 const modes:boolean[]=[];
 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  // The observer delegates to real withTenant and native business readers. Only bounded native
  // diagnostic timeouts are added; identity, permission, policy and data queries are never mocked.
  const actual=database.withTenant;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);
   const result=await read(tx),[mode]=await tx.execute<{readOnly:boolean}>(sql`select current_setting('transaction_read_only')='on' as "readOnly"`);
   modes.push(mode.readOnly);return result;
  },options));
  try{
   const outcomes=await Promise.allSettled([readProfilePresentationPolicy(ctx),hasPersonPhoto(ctx,employee.personId)]);
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'profile-presentation-read-locks.json'),JSON.stringify({kind:'REAL_PROFILE_DISPLAY_READ_LOCK_COMPONENT_ONLY',releaseEligible:false,outcomes:outcomes.map(row=>({status:row.status,sqlState:row.status==='rejected'?pgSqlState(row.reason):null})),nativeReadOnlyModes:modes},null,2));
   expect(outcomes.map(row=>row.status)).toEqual(['fulfilled','fulfilled']);
   const policy=outcomes[0];if(policy.status==='fulfilled'&&typeof policy.value!=='boolean'){
    for(const key of ['editable','legacyPrimary','visible']as const)expect([...policy.value[key]].sort()).toEqual([...expected[key]].sort());
    expect(policy.value.ctx.userId).toBe(ctx.userId);
   }
   expect(outcomes[1]).toMatchObject({status:'fulfilled',value:expectedPhoto});expect(modes).toEqual([true,true]);
  }finally{spy.mockRestore();}
 });
});
