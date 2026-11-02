/** The integrity fence admits a real storage connection without granting application authority. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {migrateTestDb,resetDb,seedBase,closeAll,owner,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const context=():SessionContext=>({tenantId:b.tenantId,userId:undefined,personId:null,roles:[]});
it('permits a real no-principal storage owner read-only snapshot with a stable integrity stamp',async()=>{
 const result=await owner.withTenant(context(),async tx=>{
  const [row]=await tx.execute(sql`select app.data_permission_read_stamp() stamp,current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') readonly`);
  return row;
 },{readOnlySnapshot:true});
 expect(result.stamp).toMatch(/^[0-9a-f]{64}$/);expect(result.isolation).toBe('repeatable read');expect(result.readonly).toBe('on');
});
it('refuses an application connection with no principal even if it claims HR roles',async()=>{
 const forged={...context(),roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 const [row]=await withTenant(forged,tx=>tx.execute(sql`select app.data_permission_read_stamp() stamp`));expect(row.stamp).toBeNull();
 await expect(withTenant(forged,async()=> 'private-result',{readOnlySnapshot:true})).rejects.toThrow(/Data access/);
});
it('does not turn a stale human principal on an owner connection into maintenance authority',async()=>{
 const stale={...context(),userId:randomUUID(),roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 const [row]=await owner.withTenant(stale,tx=>tx.execute(sql`select app.data_permission_read_stamp() stamp`));expect(row.stamp).toBeNull();
});
it('checks both the session owner and the effective SET ROLE identity',async()=>{
 await owner.withTenant(context(),async tx=>{
  await tx.execute(sql`set local role ai_hr_app`);
  const [row]=await tx.execute(sql`select app.data_permission_read_stamp() stamp`);expect(row.stamp).toBeNull();
 });
});
it('discards a maintenance snapshot if real authority changes before it returns',async()=>{
 await expect(owner.withTenant(context(),async tx=>{
  const [before]=await tx.execute(sql`select app.data_permission_read_stamp() stamp`);expect(before.stamp).toMatch(/^[0-9a-f]{64}$/);
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:b.adminUserId,role:'employee',companyId:b.companyId});
  const [inside]=await tx.execute(sql`select app.data_permission_read_stamp() stamp`);expect(inside.stamp).toBe(before.stamp);
  return 'private-result';
 },{readOnlySnapshot:true})).rejects.toThrow(/Data access changed/);
});
