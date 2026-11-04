/** Staging, 25 October to 4 November 2026: the review and notification sweeps logged in as a NOSUPERUSER
 * owner that had no SET edge to ai_hr_app, so projection's `SET LOCAL ROLE ai_hr_app` was refused (42501)
 * whenever events were pending. CI's superuser owner can always SET ROLE, so this file reproduces the
 * installed topology inside one rolled-back transaction: a non-superuser LOGIN (session authorization, not
 * merely an effective role, because PostgreSQL 16 checks SET ROLE against the session user). BYPASSRLS
 * stands in for table ownership; the edge under test is the only difference between the two cases. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createNotice,publishNotice} from '../core/notice';
import {NOTIFICATION_ROLE_MISSING,notificationDowngradeReady} from '../scripts/lib/notification-sweep-role';
import {dispatchNotificationsFromSweep} from '../core/notifications';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');});

async function publishedNotice(){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional sweep recipient',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const n=await createNotice(adminCtx(b),{title:'Fictional sweep notice',body:'Fictional content.',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur(),targetMode:'individual',employmentIds:[e.employmentId],notifyOnPublish:true});
 await publishNotice(adminCtx(b),n.id);
 return e.employmentId;
}
function sqlState(error:unknown){let item=error as {code?:string;cause?:unknown}|undefined;while(item){if(item.code)return item.code;item=item.cause as typeof item;}return undefined;}

/** Runs the real sweep entry point as a restricted login, then rolls every role and row change back. */
async function sweepAsRestrictedLogin(edge:boolean){
 const role='notification_sweep_'+randomUUID().replaceAll('-',''),rollback=new Error('rollback-notification-sweep-login');
 const seen:{who?:Record<string,unknown>;ready?:boolean;result?:unknown;error?:unknown;rawSet?:string;notifications?:{recipient:string;kind:string}[]}={};
 const connection:Parameters<typeof dispatchNotificationsFromSweep>[1]={withTenant:(context,fn,options)=>owner.withTenant(context,async tx=>{
  await tx.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS`));
  await tx.execute(sql.raw(`GRANT USAGE ON SCHEMA public,app TO ${role}`));
  await tx.execute(sql.raw(`GRANT ALL ON ALL TABLES IN SCHEMA public,app TO ${role}`));
  await tx.execute(sql.raw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public,app TO ${role}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role}`));
  if(edge)await tx.execute(sql.raw(`GRANT ai_hr_app TO ${role} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`));
  await tx.execute(sql.raw(`SET LOCAL SESSION AUTHORIZATION ${role}`));
  [seen.who]=await tx.execute<Record<string,unknown>>(sql`select session_user::text as session,current_user::text as current,
   (select rolsuper from pg_roles where rolname=session_user) as super,pg_has_role(session_user,'ai_hr_app','USAGE') as inherits_app`);
  seen.ready=await notificationDowngradeReady(tx);
  // The real entry point runs inside a savepoint so a refused SET ROLE leaves the fixture readable afterwards.
  await tx.execute(sql`SAVEPOINT sweep`);
  try{seen.result=await fn(tx);}catch(error){seen.error=error;seen.rawSet=sqlState(error);await tx.execute(sql`ROLLBACK TO SAVEPOINT sweep`);}
  seen.notifications=await tx.execute<{recipient:string;kind:string}>(sql`select recipient_employment_id::text as recipient,kind from public.notification
   where tenant_id=${b.tenantId}::uuid and kind='notice.published'`);
  throw rollback;
 },options)};
 await expect(dispatchNotificationsFromSweep({...adminCtx(b),userId:undefined},connection)).rejects.toBe(rollback);
 expect(seen.who).toEqual({session:role,current:role,super:false,inherits_app:false});
 return seen;
}

describe('The sweep login switches down to APP only through the installation edge',()=>{
 it('reproduces the staging refusal: the probe reports the gap and projection fails at SET ROLE with 42501',async()=>{
  await publishedNotice();
  const seen=await sweepAsRestrictedLogin(false);
  expect(seen.ready).toBe(false);
  expect(seen.rawSet).toBe('42501');
  expect(String((seen.error as Error).message)).toContain('SET LOCAL ROLE ai_hr_app');
  expect(seen.notifications).toEqual([]);
  expect(NOTIFICATION_ROLE_MISSING).toContain('deploy/runner-control/notification-role-prerequisite.sql');
 });
 it('projects the pending notice under the same restricted login once the INHERIT FALSE/SET TRUE edge exists',async()=>{
  const recipient=await publishedNotice();
  const seen=await sweepAsRestrictedLogin(true);
  expect(seen.ready).toBe(true);
  expect(seen.error).toBeUndefined();expect(seen.rawSet).toBeUndefined();
  expect(seen.result).toMatchObject({created:1});
  expect(seen.notifications).toEqual([{recipient,kind:'notice.published'}]);
 });
 it('the superuser test owner and the shipped prerequisite agree on the edge shape',async()=>{
  expect(await notificationDowngradeReady(owner.db)).toBe(true);
  const prerequisite=readFileSync('deploy/runner-control/notification-role-prerequisite.sql','utf8');
  const bootstrap=readFileSync('deploy/bootstrap-db.sql','utf8');
  for(const source of [prerequisite,bootstrap])expect(source).toContain('GRANT ai_hr_app TO ai_hr_owner WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;');
 });
});

describe('The deploy refuses a missing edge before it changes anything',()=>{
 it('runs the role preflight after the audit-chain gate and before build, migrate and restart',()=>{
  const sh=readFileSync('deploy/deploy.sh','utf8');
  const at=(needle:string)=>{const index=sh.indexOf(needle);expect(index,needle).toBeGreaterThan(-1);return index;};
  const check=at('node --env-file=.env.production --import tsx scripts/check-notification-role.ts');
  expect(check).toBeGreaterThan(at('node --env-file=.env.production --import tsx scripts/check-audit-chain-gate.ts'));
  expect(check).toBeLessThan(at('pnpm build'));
  expect(check).toBeLessThan(at('pnpm db:migrate'));
  expect(check).toBeLessThan(at('systemctl restart'));
 });
});
