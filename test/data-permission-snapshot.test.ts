import {publishWorkforceForDataFixture} from './helpers/workforce-publication-fixture';
/** Actual RR owner port with fresh committed authority fences, not a second JS filter. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand} from '../core/data-permissions';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,limited:SessionContext,shown:string,hidden:string,gradeA:string,gradeB:string;
const publicationCleanups:(()=>Promise<void>)[]=[];
beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(async()=>{for(const clean of publicationCleanups.splice(0).reverse())await clean();});
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};await publishWorkforceForDataFixture(admin,publicationCleanups);
 const grades=await owner.db.insert(s.jobGrade).values([{tenantId:b.tenantId,code:'SNAPA',name:'Snapshot A'},{tenantId:b.tenantId,code:'SNAPB',name:'Snapshot B'}]).returning();gradeA=grades[0].id;gradeB=grades[1].id;
 shown=(await hireEmployee(admin,{person:{fullName:'Snapshot allowed',primaryEmail:'snapshot-allowed@fixture.invalid'},employeeCode:'SNAP-A',companyId:b.companyId,departmentId:b.deptA,gradeId:gradeA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 hidden=(await hireEmployee(admin,{person:{fullName:'Snapshot hidden',primaryEmail:'snapshot-hidden@fixture.invalid'},employeeCode:'SNAP-B',companyId:b.companyId,departmentId:b.deptA,gradeId:gradeB,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'snapshot-'+randomUUID()}).returning();await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:b.companyId});
 limited={...admin,userId:user.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const profileId=randomUUID();await change({kind:'create',profileId,name:'Snapshot scope',enabled:true,rules:{legacyCompany:false,predicates:[{field:'grade',values:[gradeA]}]}});await change({kind:'assign',userId:user.id,profileId});
});
async function change(command:DataPermissionCommand){const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,command);await saveDataPermission(admin,state.revision,command,preview.fingerprint);}
const rows=(tx:Parameters<Parameters<typeof withTenant>[1]>[0])=>tx.select({id:s.employment.id}).from(s.employment).orderBy(s.employment.id);
describe('native read-only source snapshots retain data scope and reject revoked publication',()=>{
 it('keeps filtered employee reads available inside actual read-only repeatable read',async()=>{
  const value=await withTenant(limited,async tx=>{const [state]=await tx.execute(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as readonly`) as unknown as {isolation:string;readonly:string}[];return {state,rows:await rows(tx)};},{readOnlySnapshot:true});
  expect(value.state).toEqual({isolation:'repeatable read',readonly:'on'});expect(value.rows).toEqual([{id:shown}]);expect(value.rows).not.toContainEqual({id:hidden});
 });
 it('keeps an unrelated workflow switch change outside the authority generation',async()=>{
  const result=await withTenant(limited,async tx=>{const before=await rows(tx);await owner.db.insert(s.tenantSetting).values({tenantId:b.tenantId,key:'notifications.readiness_nudge_enabled',value:true,source:'customer'}).onConflictDoUpdate({target:[s.tenantSetting.tenantId,s.tenantSetting.key],set:{value:true}});return {before,after:await rows(tx)};},{readOnlySnapshot:true});
  expect(result).toEqual({before:[{id:shown}],after:[{id:shown}]});
 });
 it('discards a source result when a profile input changes while its RR snapshot is open',async()=>{
  await expect(withTenant(limited,async tx=>{expect(await rows(tx)).toEqual([{id:shown}]);await owner.db.update(s.employment).set({gradeId:gradeA}).where(eq(s.employment.id,hidden));expect(await rows(tx)).toEqual([{id:shown}]);return 'private-result';},{readOnlySnapshot:true})).rejects.toThrow(/Data access changed/);
 });
 it('discards a snapshot when the real acting company role is revoked before return',async()=>{
  await expect(withTenant(limited,async tx=>{await rows(tx);await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,limited.userId!));return 'private-result';},{readOnlySnapshot:true})).rejects.toThrow(/Data access/);
 });
});
