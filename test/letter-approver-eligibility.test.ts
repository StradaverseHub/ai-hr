import {beforeEach,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {company,appUser,roleAssignment,roleEnum} from '../db/schema';
import {saveLetterPermission} from '../core/letters';
import {adminCtx,entitledCtx,owner,resetDb,seedBase,closeAll,type Base} from './harness';
let b:Base;
beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
it('preserves the original current-principal financial policy for every role and group/company/subtree scope',async()=>{
 const [child]=await owner.db.insert(company).values({tenantId:b.tenantId,parentId:b.companyId,legalName:'Fictional child'}).returning(),[sibling]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional sibling'}).returning();
 for(const role of roleEnum.enumValues)for(const scope of [null,b.companyId]){
  const [user]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:'policy-parity-'+randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role,companyId:scope});
  const ctx={...adminCtx(b),userId:user.id,personId:null,roles:[role],grants:[{role,companyId:scope}]};
  for(const target of [b.companyId,child.id,sibling.id]){
   const [result]=await withTenant(ctx,tx=>tx.execute<{actual:boolean;original:boolean}>(sql`select app.can_admin_payroll_for(${target}::uuid) as actual,
    exists(select 1 from app.current_grants() g where g.role in ('hr_admin','super_admin','payroll_partner') and (g.company_id is null or g.company_id=${target}::uuid or app.is_company_descendant(${target}::uuid,g.company_id))) as original`));
   expect(result.actual,JSON.stringify({role,scope,target})).toBe(result.original);
  }
 }
});
it('requires actual financial grants for confidential-letter candidates without replacing the caller principal',async()=>{
 const ctx=await entitledCtx(b),[user]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:'candidate-'+randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'manager',companyId:b.companyId});
 for(const capability of ['read','approve'] as const)await saveLetterPermission(ctx,{companyId:b.companyId,role:'manager',capability,allowed:true});
 const check=async()=>withTenant(ctx,async tx=>{const [before]=await tx.execute<{id:string}>(sql`select app.current_user_id() as id`);const [result]=await tx.execute<{ordinary:boolean;confidential:boolean}>(sql`select app.letter_approver_eligible(${user.id}::uuid,${b.companyId}::uuid,false) as ordinary,app.letter_approver_eligible(${user.id}::uuid,${b.companyId}::uuid,true) as confidential`);const [after]=await tx.execute<{id:string}>(sql`select app.current_user_id() as id`);expect(after.id).toBe(before.id);return result;});
 expect(await check()).toEqual({ordinary:true,confidential:false});await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'payroll_partner',companyId:b.companyId});expect(await check()).toEqual({ordinary:true,confidential:true});
});
it('uses existing descendant scope for a current HR grant and refuses a foreign tenant',async()=>{
 const ctx=await entitledCtx(b),[child]=await owner.db.insert(company).values({tenantId:b.tenantId,parentId:b.companyId,legalName:'Fictional descendant'}).returning(),[user]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:'scoped-'+randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
 const [eligible]=await withTenant(ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.letter_approver_eligible(${user.id}::uuid,${child.id}::uuid,true) as ok`));expect(eligible.ok).toBe(true);const foreign=await seedBase();const [blocked]=await withTenant(ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.letter_approver_eligible(${user.id}::uuid,${foreign.companyId}::uuid,true) as ok`));expect(blocked.ok).toBe(false);
});
