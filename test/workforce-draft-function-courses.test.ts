/** Actual stored draft-author scope remains distinct from company administration. */
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {employeeDraftCreateCompanies,getEmployeeDraft,saveEmployeeDraft} from '../core/employee-draft';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
it('preserves the actual author read after a scope move without granting another HR actor the draft',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other draft company'}).returning({id:s.company.id});
 const [author]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional draft author',primaryEmail:'draft-author@fixture.invalid'}).returning({id:s.person.id});
 const userId=await createAppUser(b.tenantId,author.id,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:b.companyId});
 const native:SessionContext={...adminCtx(b),userId,personId:author.id,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:b.companyId}]};
 expect(await employeeDraftCreateCompanies(native)).toEqual([b.companyId]);
 const saved=await saveEmployeeDraft(native,{currentStep:1,data:{profile:{fullName:'Fictional prospective hire'},employment:{companyId:b.companyId}}});
 expect(await getEmployeeDraft(native,saved.id)).toMatchObject({id:saved.id,companyId:b.companyId});
 await owner.db.update(s.roleAssignment).set({companyId:other.id}).where(and(eq(s.roleAssignment.appUserId,userId),eq(s.roleAssignment.role,'hr_admin')));
 const moved={...native,grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:other.id}]} satisfies SessionContext;
 expect(await getEmployeeDraft(moved,saved.id)).toMatchObject({id:saved.id,companyId:b.companyId,actions:{canEdit:true,canDiscard:true,canActivate:false}});
 expect(await employeeDraftCreateCompanies(moved)).toEqual([other.id]);
 const outsiderId=await createAppUser(b.tenantId,null,'employee');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:outsiderId,role:'hr_admin',companyId:other.id});
 expect(await getEmployeeDraft({...moved,userId:outsiderId,personId:null},saved.id)).toBeNull();
 let denial:unknown;try{await withTenant(moved,tx=>tx.execute(sql`select app.workforce_draft_purpose_allowed(${b.companyId}::uuid,${author.id}::uuid,'view')`));}catch(error){denial=error;}
 expect(pgSqlState(denial)).toBe('42501');
 const [authority]=await owner.client`select app.workforce_draft_author_legacy_allowed(${b.tenantId}::uuid,${userId}::uuid,'function.workforceDrafts.author.view',null) as author,app.workforce_function_legacy_allowed(${b.tenantId}::uuid,${userId}::uuid,'function.workforceDrafts.view',${b.companyId}::uuid) as administers`;
 expect(authority).toEqual({author:true,administers:false});
});
