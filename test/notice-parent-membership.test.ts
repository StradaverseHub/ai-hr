/** Native own-recipient read boundary: current identity, live authorization and version-bound tasks. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {acknowledgeNotice,createNotice,pendingNoticeAcknowledgementTasks,publishNotice,updateNotice} from '../core/notice';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps the helper private to app execution with the existing native owner and stable semantics',async()=>{
 const [row]=await owner.client`select p.prosecdef,p.provolatile,p.proisstrict,p.proconfig,p.proowner=(select proowner from pg_proc where oid='app.can_manage_notice(uuid)'::regprocedure) as same_owner,
 has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
 from pg_proc p where p.oid='app.has_own_notice_recipient(uuid)'::regprocedure`;
 expect(row).toEqual({prosecdef:true,provolatile:'s',proisstrict:false,proconfig:['search_path=pg_catalog, public, pg_temp'],same_owner:true,app_execute:true,public_execute:false});
 const policies=await owner.client`select polname,polpermissive from pg_policy where polrelid in ('public.employment'::regclass,'public.notice_recipient'::regclass)`;
 expect(policies.length).toBeGreaterThan(0);expect(policies.every(p=>p.polpermissive)).toBe(true);
});
it('returns all own employment tasks, excludes other people/tenants, and observes acknowledgement, version and live revocation',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const hire=async(base:typeof b,name:string)=>hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const one=await hire(b,'Fictional own membership'),other=await hire(b,'Fictional excluded colleague');
 const [two]=await owner.db.insert(s.employment).values({tenantId:b.tenantId,personId:one.personId,companyId:b.companyId,hiredOn:'2020-01-01'}).returning();
 await owner.db.insert(s.assignment).values({tenantId:b.tenantId,employmentId:two.id,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,one.personId,'employee');
 const ctx:SessionContext={...adminCtx(b),userId,personId:one.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const stranger=await hire(foreign,'Fictional foreign membership');
 const input={title:'Fictional pending task',body:'Fictional assigned content.',startOn:'2020-01-01',endOn:'2099-12-31',targetMode:'individual' as const,employmentIds:[one.employmentId,two.id,other.employmentId],requiresAcknowledgement:true};
 const n=await createNotice(adminCtx(b),input);expect((await publishNotice(adminCtx(b),n.id)).recipients).toBe(3);
 await owner.db.update(s.employment).set({terminatedOn:'2025-12-31'}).where(eq(s.employment.id,two.id));
 const f=await createNotice(adminCtx(foreign),{...input,employmentIds:[stranger.employmentId]});await publishNotice(adminCtx(foreign),f.id);
 const [source]=await owner.db.select().from(s.notice).where(eq(s.notice.id,n.id));
 const tasks=await pendingNoticeAcknowledgementTasks(ctx);expect(tasks.map(r=>r.employmentId).sort()).toEqual([one.employmentId,two.id].sort());
 expect(tasks.every(r=>r.noticeId===n.id&&r.title===input.title&&r.contentVersion===1&&r.sourceUpdatedAt.getTime()===source.updatedAt.getTime())).toBe(true);
 expect(Object.keys(tasks[0]).sort()).toEqual(['noticeId','employmentId','title','contentVersion','sourceUpdatedAt'].sort());
 await acknowledgeNotice(ctx,n.id,one.employmentId,1);expect((await pendingNoticeAcknowledgementTasks(ctx)).map(r=>r.employmentId)).toEqual([two.id]);
 await updateNotice(adminCtx(b),n.id,{...input,body:'Fictional changed assigned content.'});
 expect((await pendingNoticeAcknowledgementTasks(ctx)).map(r=>({employmentId:r.employmentId,version:r.contentVersion}))).toEqual([one.employmentId,two.id].sort().map(employmentId=>({employmentId,version:2})));
 await withTenant(ctx,async tx=>{
  const membership=async(id:string|null)=>{const [row]=await tx.execute<{allowed:boolean}>(sql`select app.has_own_notice_recipient(${id}::uuid) as allowed`);return row.allowed;};
  expect(await membership(n.id)).toBe(true);expect(await membership(f.id)).toBe(false);expect(await membership(randomUUID())).toBe(false);expect(await membership(null)).toBe(false);
  await tx.execute(sql`select set_config('app.roles','hr_admin',true)`);expect(await membership(n.id)).toBe(false);
  await tx.execute(sql`select set_config('app.roles','employee',true)`);
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,userId));expect(await membership(n.id)).toBe(false);
  await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,userId));expect(await membership(n.id)).toBe(true);
 });
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`select set_config('app.grants','{broken',true)`);return tx.execute(sql`select app.has_own_notice_recipient(${n.id}::uuid)`);})).rejects.toMatchObject({cause:{code:'22P02'}});
});
