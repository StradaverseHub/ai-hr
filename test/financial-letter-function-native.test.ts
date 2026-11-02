/** Actual stored native ACL/default/current-carrier courses. No activation sentinel or test-only grants. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import type {LetterCapability} from '../lib/letter-workflow';
import {saveLetterPermission,readLetterPermissions} from '../core/letters';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,userId:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();userId=await createAppUser(b.tenantId,null,'employee');});
async function context():Promise<SessionContext>{return {...await entitledCtx(b),userId,personId:undefined,roles:['employee'],grants:[{role:'employee',companyId:null}]};}
async function acl(capability:LetterCapability,companyId=b.companyId){await saveLetterPermission(await entitledCtx(b),{companyId,role:'employee',capability,allowed:true});}
async function allowed(key:string,operation:string,companyId:string|null=b.companyId,ctx?:SessionContext){
 const [row]=await withTenant(ctx??await context(),tx=>tx.execute<{allowed:boolean}>(sql`select app.letter_function_action(${key},${operation},${companyId}::uuid) as allowed`));return row.allowed;
}
it('native read-only operators retain Fields/Templates View without being given Template maintenance',async()=>{
 await acl('read');
 expect(await allowed('letterFields','view')).toBe(true);expect(await allowed('letterTemplates','view')).toBe(true);
 expect(await allowed('letterFields','add')).toBe(false);expect(await allowed('letterTemplates','edit')).toBe(false);
 expect(await allowed('letterRegister','view')).toBe(true);expect(await allowed('letterReports','view')).toBe(false);
 expect(await allowed('letterGenerate','view')).toBe(false);expect(await allowed('letterApproval','view')).toBe(false);
});
it('an approve-only native user retains own signature images and the Settings shell without general configuration or assigned content',async()=>{
 await acl('approve');
 expect(await allowed('letterSettings.signature','view')).toBe(true);expect(await allowed('letterSettings.signature','add')).toBe(true);
 expect(await allowed('letterSettings','view')).toBe(true);expect(await allowed('letterSettings','add')).toBe(false);
 expect(await allowed('letterApproval','view')).toBe(false);expect(await allowed('letterApproval','approve')).toBe(false);
 expect(await allowed('letterSettings.signature','edit')).toBe(false);
});
it('the actual assigned Approval course requires both native Read and Approve and has no fabricated Add action',async()=>{
 await acl('read');await acl('approve');
 expect(await allowed('letterApproval','view')).toBe(true);expect(await allowed('letterApproval','approve')).toBe(true);
 expect(await allowed('letterApproval','add')).toBe(false);expect(await allowed('notRegistered','view')).toBe(false);
 const roles=await owner.db.select({role:s.roleAssignment.role}).from(s.roleAssignment).where(sql`${s.roleAssignment.appUserId}=${userId}::uuid`);
 expect(roles).toEqual([{role:'employee'}]);
});
it('current narrowed company claims cannot borrow the stored global native role in a different company',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional native letter company '+randomUUID()}).returning();
 await acl('read',other.id);await acl('approve',other.id);
 const [stored]=await owner.db.execute<{allowed:boolean}>(sql`select app.financial_function_legacy_allowed(${b.tenantId}::uuid,${userId}::uuid,'function.letterApproval.view',${other.id}::uuid) as allowed`);
 expect(stored.allowed).toBe(true);
 const narrowed={...await context(),grants:[{role:'employee',companyId:b.companyId}]};
 expect(await allowed('letterApproval','view',other.id,narrowed)).toBe(false);
});
it('My Letters keeps the signed-in empty-route course and private native hooks remain unavailable to runtime SQL',async()=>{
 const ctx=await context(),[own]=await withTenant(ctx,tx=>tx.execute<{allowed:boolean}>(sql`select app.letter_recipient_function_action('view') as allowed`));expect(own.allowed).toBe(true);
 await expect(withTenant(ctx,tx=>tx.execute(sql`select app.financial_function_legacy_allowed(${b.tenantId}::uuid,${userId}::uuid,'function.letterApproval.view',${b.companyId}::uuid)`))).rejects.toThrow();
});

it('a native Settings-only writer can manage the same configuration course but cannot grant native Issue authority it does not hold',async()=>{
 await acl('settings');const ctx=await context();
 await expect(saveLetterPermission(ctx,{companyId:b.companyId,role:'manager',capability:'issue',allowed:true})).rejects.toThrow();
 await saveLetterPermission(ctx,{companyId:b.companyId,role:'manager',capability:'settings',allowed:true});
 const grants=await readLetterPermissions(ctx,b.companyId);expect(grants).toContainEqual({role:'manager',capability:'settings',allowed:true});
 expect(grants.some(grant=>grant.role==='manager'&&grant.capability==='issue')).toBe(false);
});
