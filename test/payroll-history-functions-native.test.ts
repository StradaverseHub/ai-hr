/** Actual dormant native floors; no fabricated publisher completion or support flag. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function access(ctx:SessionContext,co:string|null){
 const [row]=await withTenant(ctx,tx=>tx.execute(sql`select app.financial_history_function_action(${co}::uuid,'view') "view",app.financial_history_function_action(${co}::uuid,'add') "add",app.financial_history_function_action(${co}::uuid,'edit') "edit",app.financial_history_function_action(${co}::uuid,'delete') "delete",app.financial_history_function_action(${co}::uuid,'approve') "invented"`));return row;
}
async function otherCompany(){const [co]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional history company '+randomUUID()}).returning();return co;}
it('keeps scoped HR history actions inside the native company and refuses a future/global course',async()=>{
 const other=await otherCompany(),userId=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
 const ctx={...adminCtx(b),userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect(await access(ctx,b.companyId)).toEqual({view:true,add:true,edit:true,delete:true,invented:false});
 for(const co of [other.id,null])expect(await access(ctx,co)).toEqual({view:false,add:false,edit:false,delete:false,invented:false});
});
it('retains separate native Import and Revert ACLs without borrowing catalogue maintenance',async()=>{
 const userId=await createAppUser(b.tenantId,null,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'payroll_partner',companyId:null});
 const ctx={...adminCtx(b),userId,personId:null,roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:null}]};
 expect(await access(ctx,b.companyId)).toEqual({view:true,add:false,edit:false,delete:false,invented:false});
 await owner.db.insert(s.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.history.import',role:'payroll_partner',allowed:true});
 expect(await access(ctx,b.companyId)).toEqual({view:true,add:true,edit:true,delete:false,invented:false});
 const [catalogue]=await withTenant(ctx,tx=>tx.execute(sql`select app.financial_setup_catalog_function('payComponents.catalogue','add') allowed`));expect(catalogue.allowed).toBe(false);
});
it('does not borrow stored global HR from a narrowed current carrier, and global ACLs cover every company',async()=>{
 const other=await otherCompany(),userId=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'employee',companyId:null});
 const full={...adminCtx(b),userId,personId:null,roles:['hr_admin','employee'],grants:[{role:'hr_admin',companyId:null},{role:'employee',companyId:null}]};
 const narrowed={...full,grants:[{role:'hr_admin',companyId:b.companyId},{role:'employee',companyId:null}]};
 const [stored]=await owner.db.execute(sql`select app.financial_history_native(${b.tenantId}::uuid,${userId}::uuid,'import',${other.id}::uuid,false) allowed`);expect(stored.allowed).toBe(true);
 expect(await access(narrowed,other.id)).toEqual({view:false,add:false,edit:false,delete:false,invented:false});
 expect((await access(full,null)).add).toBe(true);
 await owner.db.insert(s.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:other.id,permissionKey:'payroll.history.import',role:'hr_admin',allowed:false});
 expect((await access(full,b.companyId)).add).toBe(true);expect((await access(full,other.id)).add).toBe(false);expect((await access(full,null)).add).toBe(false);
 await expect(withTenant(full,tx=>tx.execute(sql`select app.financial_history_native(${b.tenantId}::uuid,${userId}::uuid,'import',${b.companyId}::uuid,false)`))).rejects.toThrow();
});
