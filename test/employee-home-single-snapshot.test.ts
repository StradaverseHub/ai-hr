/** Observe real app-role transactions; never replace identity, permissions or database readers. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {readOwnEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {readEmployeeHomeIdentityTx} from '../core/employee-home';
import {adminCtx,closeAll,createAppUser,migrateTestDb,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('reads selected Home role, active own employment and configuration in one read-only app snapshot',async()=>{
 await resetDb();const b=await seedBase();
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Home snapshot',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee']};
 const actual=database.withTenant,observed:{role:string;isolation:string;readOnly:boolean}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(context,async tx=>{
  const [properties]=await tx.execute<{role:string;isolation:string;readOnly:boolean}>(sql`select current_user as role,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly"`);
  observed.push(properties);return read(tx);
 },options));
 try{
  expect(await readOwnEmployeeHomeConfiguration(ctx,employee.employmentId)).toMatchObject({employmentId:employee.employmentId,companyId:b.companyId,audienceRole:'employee',ordinal:0});
  expect(observed).toEqual([{role:'ai_hr_app',isolation:'repeatable read',readOnly:true}]);
 }finally{spy.mockRestore();}
 // A future caller cannot reuse the composable reader from a command transaction or
 // substitute READ COMMITTED for its complete read-only repeatable snapshot.
 await expect(database.withTenant(ctx,tx=>readEmployeeHomeIdentityTx(tx,ctx,employee.employmentId))).rejects.toMatchObject({code:'employmentUnavailable'});
 await expect(database.withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);
  return readEmployeeHomeIdentityTx(tx,ctx,employee.employmentId);
 })).rejects.toMatchObject({code:'employmentUnavailable'});
});
