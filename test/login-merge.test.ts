/** Board 0735d1b7 — login merge and Undo merge (core/login-merge.ts, migration 7600) on a real database.
 *
 * A merge combines LOGINS only. Proved here with fictional people and independent expected values:
 *  - refusals: a company-scoped administrator, a stale group (it changed after the screen opened), a member that is
 *    already a master, merging away the actor's own login, a wrong confirmation, a grant that was not offered, and the
 *    last-group-administrator guard;
 *  - effects: only the master can sign in (app.principal_by_subject / app.principal_by_identity refuse the merged
 *    login), internal sessions end (credential version rotated, credential kept), grants carry ONLY when ticked, the
 *    merged login's own grants stay on it, Restore and Archive are refused while merged;
 *  - Undo merge restores the exact earlier state (the app_user row byte for byte, including an earlier archived_at,
 *    every grant of both logins when HR ticks the carried ones for removal), keeps audit rows and original ids;
 *  - nothing in person, employment, statutory or payslip data changes;
 *  - another tenant can neither merge, undo nor read these logins or facts; the table is reachable only through its
 *    definers (row security on, no PUBLIC or application privilege). */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {generate} from 'otplib';
import {client,withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {assertGroupAdminRemainsTx,setAppUserArchived} from '../core/auth';
import {grantAssistant} from '../core/assistant-grant';
import {readLoginDuplicates} from '../core/login-duplicates';
import {LoginMergeError,listActiveMergedLogins,mergeLogins,readLoginMergeState,undoLoginMerge,type MergeInput} from '../core/login-merge';
import {createManualAccount} from '../core/manual-identity';
import {bootstrapInternalOwner} from '../lib/internal-auth/bootstrap';
import {changeInitialPassword,credentialByLogin,startLogin,verifyMfa,type AuthReply} from '../lib/internal-auth/service';
import {parseKeysetPageQuery} from '../lib/pagination';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,eventTypesFor,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let base:Base,ctx:SessionContext;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();ctx=adminCtx(base);});
afterEach(()=>{vi.unstubAllEnvs();});
afterAll(closeAll);

type Login={appUserId:string;personId:string;subject:string};
async function login(b:Base,name:string,opts:{ic?:string;email?:string;employed?:boolean}={}):Promise<Login>{
 let personId:string;const email=opts.email??`${randomUUID()}@example.test`;
 if(opts.employed){
  personId=(await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`${randomUUID()}@hire.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'})).personId;
  await owner.db.update(schema.person).set({primaryEmail:email}).where(sql`id=${personId}::uuid`);
 }else personId=(await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:name,primaryEmail:email}).returning({id:schema.person.id}))[0].id;
 if(opts.ic)await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId,icNumber:opts.ic})
  .onConflictDoUpdate({target:schema.employeeStatutoryMy.personId,set:{icNumber:opts.ic}});
 const subject=`user_${randomUUID()}`;
 const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:subject,personId}).returning({id:schema.appUser.id});
 return {appUserId:u.id,personId,subject};
}
async function role(b:Base,appUserId:string,roleName:'employee'|'manager'|'hr_admin'|'payroll_partner',companyId:string|null=null){
 const [r]=await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId,role:roleName,companyId}).returning({id:schema.roleAssignment.id});
 return r.id;
}
const identityGroup=async(c:SessionContext=ctx)=>(await readLoginDuplicates(c,'identity',parseKeysetPageQuery({}))).groups[0];
const input=(over:Partial<MergeInput>&Pick<MergeInput,'groupDigest'|'masterId'|'mergedIds'>):MergeInput=>({basis:'ic',carry:{roleAssignmentIds:[],assistant:false},
 reason:'Fictional duplicate login of one person',confirmation:'MERGE',...over});
const signsIn=async(subject:string)=>(await client`select app_user_id from app.principal_by_subject(${subject})`).length>0;
const rowOf=async(id:string)=>(await owner.client`select to_jsonb(u)::text as row from app_user u where id=${id}::uuid`)[0]?.row as string;
const grantsOf=async(id:string)=>(await owner.client`select string_agg(r.id::text||':'||r.role::text||':'||coalesce(r.company_id::text,'-'),',' order by r.id) as g from role_assignment r where r.app_user_id=${id}::uuid`)[0]?.g as string|null;
const liveAssistant=async(id:string)=>(await owner.client`select string_agg(id::text,',' order by id) as g from assistant_grant where app_user_id=${id}::uuid and revoked_at is null`)[0]?.g as string|null;
const hrDigest=async(tenantId:string)=>(await owner.client`select
  (select md5(coalesce(string_agg(to_jsonb(p)::text,',' order by p.id),'')) from person p where p.tenant_id=${tenantId}::uuid) as person,
  (select md5(coalesce(string_agg(to_jsonb(e)::text,',' order by e.id),'')) from employment e where e.tenant_id=${tenantId}::uuid) as employment,
  (select md5(coalesce(string_agg(to_jsonb(s)::text,',' order by s.id),'')) from employee_statutory_my s where s.tenant_id=${tenantId}::uuid) as statutory,
  (select count(*)::int from payslip x where x.tenant_id=${tenantId}::uuid) as payslips,
  (select count(*)::int from app_user u where u.tenant_id=${tenantId}::uuid) as logins`)[0];
async function refused(work:Promise<unknown>,code:LoginMergeError['code']){
 const error=await work.then(()=>null,(e:unknown)=>e);
 expect(error,`expected ${code}`).toBeInstanceOf(LoginMergeError);expect((error as LoginMergeError).code).toBe(code);
}

describe('board 0735d1b7: merge logins',()=>{
 it('merges, carries only ticked grants, switches the merged login off and Undo restores the exact earlier state',async()=>{
  const a=await login(base,'Fictional Siti Master',{ic:'900303-14-1111',employed:true});
  const b=await login(base,'Fictional Siti Copy',{ic:'900303141111',employed:true});
  const aEmployee=await role(base,a.appUserId,'employee');
  const bEmployee=await role(base,b.appUserId,'employee');
  const bPayroll=await role(base,b.appUserId,'payroll_partner',base.companyId);
  await role(base,b.appUserId,'manager');
  await grantAssistant(ctx,{appUserId:b.appUserId});
  const before={a:await rowOf(a.appUserId),b:await rowOf(b.appUserId),aGrants:await grantsOf(a.appUserId),bGrants:await grantsOf(b.appUserId),
   aAssistant:await liveAssistant(a.appUserId),bAssistant:await liveAssistant(b.appUserId),hr:await hrDigest(base.tenantId)};
  expect(before.aGrants).toBe(`${aEmployee}:employee:-`);
  const group=await identityGroup();
  expect(group.accounts.map(x=>x.appUserId).sort()).toEqual([a.appUserId,b.appUserId].sort());
  expect(await signsIn(b.subject)).toBe(true);
  // An offered grant that the master already holds is refused (b's employee role is not on offer).
  await refused(mergeLogins(ctx,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[b.appUserId],carry:{roleAssignmentIds:[bEmployee],assistant:false}})),'carry');
  await refused(mergeLogins(ctx,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[b.appUserId],confirmation:'merge please'})),'confirmation');
  // Only the payroll role is ticked; the manager role and the assistant stay where they are.
  const {mergeIds}=await mergeLogins(ctx,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[b.appUserId],carry:{roleAssignmentIds:[bPayroll],assistant:false}}));
  expect(mergeIds).toHaveLength(1);
  expect(await signsIn(b.subject)).toBe(false);
  expect(await signsIn(a.subject)).toBe(true);
  const master=(await owner.client`select role::text,company_id::text from role_assignment where app_user_id=${a.appUserId}::uuid order by role::text`).map(r=>`${r.role}:${r.company_id??'-'}`);
  expect(master).toEqual(['employee:-',`payroll_partner:${base.companyId}`]);
  expect(await grantsOf(b.appUserId)).toBe(before.bGrants);
  expect(await liveAssistant(a.appUserId)).toBeNull();
  expect(await liveAssistant(b.appUserId)).toBe(before.bAssistant);
  expect([...(await listActiveMergedLogins(ctx)).entries()]).toEqual([[b.appUserId,a.appUserId]]);
  // Archive and Restore belong to Undo merge while the login is merged.
  await expect(setAppUserArchived(ctx,{appUserId:b.appUserId,archived:false})).rejects.toThrow(/Undo merge/);
  await expect(setAppUserArchived(ctx,{appUserId:b.appUserId,archived:true})).rejects.toThrow(/Undo merge/);
  const state=await readLoginMergeState(ctx,b.appUserId);
  expect(state.mergedInto).toMatchObject({id:mergeIds[0],masterId:a.appUserId,mergedId:b.appUserId,basis:'ic',reason:'Fictional duplicate login of one person',
   carried:{roles:[{role:'payroll_partner',companyId:base.companyId}],assistant:false}});
  expect((await readLoginMergeState(ctx,a.appUserId)).mergedLogins.map(m=>m.appUserId)).toEqual([b.appUserId]);
  // A merge never touches HR records and deletes no login.
  expect(await hrDigest(base.tenantId)).toEqual(before.hr);
  // Undo with the carried role ticked for removal: both logins are exactly as before.
  const carried=state.mergedInto!.carried.roles.map(r=>r.roleAssignmentId);
  await refused(undoLoginMerge(ctx,{mergeId:mergeIds[0],reason:'Fictional reviewed undo',removeCarried:{roleAssignmentIds:[aEmployee],assistant:false}}),'carry');
  await undoLoginMerge(ctx,{mergeId:mergeIds[0],reason:'Fictional reviewed undo',removeCarried:{roleAssignmentIds:carried,assistant:false}});
  expect(await rowOf(a.appUserId)).toBe(before.a);
  expect(await rowOf(b.appUserId)).toBe(before.b);
  expect(await grantsOf(a.appUserId)).toBe(before.aGrants);
  expect(await grantsOf(b.appUserId)).toBe(before.bGrants);
  expect(await liveAssistant(a.appUserId)).toBe(before.aAssistant);
  expect(await liveAssistant(b.appUserId)).toBe(before.bAssistant);
  expect(await signsIn(b.subject)).toBe(true);
  expect(await hrDigest(base.tenantId)).toEqual(before.hr);
  await refused(undoLoginMerge(ctx,{mergeId:mergeIds[0],reason:'Fictional second undo',removeCarried:{roleAssignmentIds:[],assistant:false}}),'already-undone');
  // Audit on both logins; the fact is kept, stamped undone, with the original ids.
  for(const id of [a.appUserId,b.appUserId])expect(await eventTypesFor(base.tenantId,id)).toEqual(expect.arrayContaining(['app-user.merged','app-user.merge-undone']));
  const facts=await owner.client`select master_app_user_id::text,merged_app_user_id::text,undone_at is not null as undone,merged_by::text,undone_by::text from app_user_merge where tenant_id=${base.tenantId}::uuid`;
  expect(facts.map(f=>({...f}))).toEqual([{master_app_user_id:a.appUserId,merged_app_user_id:b.appUserId,undone:true,merged_by:base.adminUserId,undone_by:base.adminUserId}]);
  expect((await readLoginMergeState(ctx,b.appUserId)).mergedInto).toBeNull();
 });

 it('restores an earlier archived_at exactly and carries the assistant only when ticked',async()=>{
  const a=await login(base,'Fictional Arif Master',{ic:'850505-05-5050'});
  const c=await login(base,'Fictional Arif Old',{ic:'850505055050'});
  await owner.client`update app_user set archived_at='2024-02-03 04:05:06.789123+00' where id=${c.appUserId}::uuid`;
  await grantAssistant(ctx,{appUserId:c.appUserId});
  const before=await rowOf(c.appUserId);
  const group=await identityGroup();
  const {mergeIds}=await mergeLogins(ctx,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[c.appUserId],carry:{roleAssignmentIds:[],assistant:true}}));
  const carriedGrant=await liveAssistant(a.appUserId);
  expect(carriedGrant).not.toBeNull();
  expect((await readLoginMergeState(ctx,c.appUserId)).mergedInto?.carried.assistant).toBe(true);
  // Undo without ticking the assistant keeps it on the master (listed, never removed automatically).
  await undoLoginMerge(ctx,{mergeId:mergeIds[0],reason:'Fictional reviewed undo',removeCarried:{roleAssignmentIds:[],assistant:false}});
  expect(await rowOf(c.appUserId)).toBe(before);
  expect(await liveAssistant(a.appUserId)).toBe(carriedGrant);
 });

 it('refuses stale groups, a member that is already a master, the actor\'s own login and anyone but a group administrator',async()=>{
  const a=await login(base,'Fictional Lee Master',{ic:'800808-08-8080',email:'lee@example.test'});
  const b=await login(base,'Fictional Lee Copy',{ic:'800808088080'});
  const group=await identityGroup();
  const scoped:SessionContext={...ctx,grants:[{role:'hr_admin',companyId:base.companyId}]};
  await refused(mergeLogins(scoped,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[b.appUserId]})),'forbidden');
  // The group gains a member after the screen opened: refused, nothing written.
  const late=await login(base,'Fictional Lee Third',{ic:'800808 088080'});
  await refused(mergeLogins(ctx,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[b.appUserId]})),'stale');
  await refused(mergeLogins(ctx,input({groupDigest:'f'.repeat(64),masterId:a.appUserId,mergedIds:[b.appUserId,late.appUserId]})),'stale');
  expect((await owner.client`select count(*)::int as n from app_user_merge`)[0].n).toBe(0);
  expect(await signsIn(b.subject)).toBe(true);
  const fresh=await identityGroup();
  await mergeLogins(ctx,input({groupDigest:fresh.digest,masterId:a.appUserId,mergedIds:[b.appUserId,late.appUserId]}));
  // A new login shares the master's email: the group shows the master locked, and it cannot be merged away.
  const d=await login(base,'Fictional Lee Email',{email:'LEE@example.test'});
  const email=(await readLoginDuplicates(ctx,'email',parseKeysetPageQuery({}))).groups[0];
  expect(email.lockedMasterId).toBe(a.appUserId);
  await refused(mergeLogins(ctx,input({basis:'email',groupDigest:email.digest,masterId:d.appUserId,mergedIds:[a.appUserId]})),'member-is-master');
  // The actor's own login can never be merged away.
  const self=await login(base,'Fictional Self Admin',{ic:'700101-01-0101'});
  const twin=await login(base,'Fictional Self Twin',{ic:'700101010101'});
  await role(base,self.appUserId,'hr_admin');
  const selfCtx:SessionContext={tenantId:base.tenantId,userId:self.appUserId,roles:['hr_admin']};
  const selfGroup=(await readLoginDuplicates(ctx,'identity',parseKeysetPageQuery({}))).groups.find(g=>g.accounts.some(x=>x.appUserId===self.appUserId))!;
  await refused(mergeLogins(selfCtx,input({groupDigest:selfGroup.digest,masterId:twin.appUserId,mergedIds:[self.appUserId]})),'own-login');
 });

 it('keeps one group administrator able to sign in',async()=>{
  const other=await login(base,'Fictional Other Admin');
  await role(base,other.appUserId,'hr_admin');
  // Switching off every group-wide administrator is refused; leaving one is allowed.
  await expect(withTenant(ctx,tx=>assertGroupAdminRemainsTx(tx,[base.adminUserId,other.appUserId]))).rejects.toThrow(/last group administrator/);
  await expect(withTenant(ctx,tx=>assertGroupAdminRemainsTx(tx,[other.appUserId]))).resolves.toBeUndefined();
 });

 it('keeps another tenant out and the merge facts behind their definers',async()=>{
  const a=await login(base,'Fictional Tan Master',{ic:'660606-06-6060'});
  const b=await login(base,'Fictional Tan Copy',{ic:'660606066060'});
  const group=await identityGroup();
  const other=await seedBase(),otherCtx=adminCtx(other);
  await refused(mergeLogins(otherCtx,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[b.appUserId]})),'stale');
  const {mergeIds}=await mergeLogins(ctx,input({groupDigest:group.digest,masterId:a.appUserId,mergedIds:[b.appUserId]}));
  await refused(undoLoginMerge(otherCtx,{mergeId:mergeIds[0],reason:'Fictional foreign undo',removeCarried:{roleAssignmentIds:[],assistant:false}}),'forbidden');
  expect((await listActiveMergedLogins(otherCtx)).size).toBe(0);
  expect(await readLoginMergeState(otherCtx,b.appUserId)).toEqual({mergedInto:null,mergedLogins:[],history:[]});
  expect(await signsIn(b.subject)).toBe(false);
  // The application role reaches the table only through the definers.
  const denied=async(work:Promise<unknown>)=>pgSqlState(await work.then(()=>null,(e:unknown)=>e));
  expect(await denied(withTenant(ctx,tx=>tx.execute(sql`select count(*) from app_user_merge`)))).toBe('42501');
  expect(await denied(withTenant(ctx,tx=>tx.execute(sql`insert into app_user_merge(tenant_id,master_app_user_id,merged_app_user_id,match_basis,group_key_digest,merged_by,reason)
   values(${base.tenantId}::uuid,${b.appUserId}::uuid,${a.appUserId}::uuid,'ic',${'0'.repeat(64)},${base.adminUserId}::uuid,'forged merge')`)))).toBe('42501');
  const [catalog]=await owner.client`select c.relrowsecurity as rls,
   has_table_privilege('ai_hr_app','public.app_user_merge','SELECT') as app_select,
   has_table_privilege('ai_hr_app','public.app_user_merge','INSERT') as app_insert,
   coalesce((select bool_or(a.grantee=0) from aclexplode(c.relacl) a),false) as public_grant,
   (select bool_and(has_function_privilege('ai_hr_app',p.oid,'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'login_merge%') as app_execute,
   (select bool_or(coalesce((select bool_or(a.grantee=0) from aclexplode(p.proacl) a),true)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'login_merge%') as public_execute,
   (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'login_merge%' and p.prosecdef) as definers,
   (select count(*)::int from pg_policies where tablename='app_user_merge') as policies
   from pg_class c where c.oid='public.app_user_merge'::regclass`;
  expect({...catalog}).toEqual({rls:true,app_select:false,app_insert:false,public_grant:false,app_execute:true,public_execute:false,definers:4,policies:0});
  const [kind]=await owner.client`select exclusive,input_max_bytes from bulk_job_kind where kind='account_invitation_batch'`;
  expect({...kind}).toEqual({exclusive:'tenant',input_max_bytes:262144});
 });
});

describe('board 0735d1b7: merging a login with an embedded HR credential',()=>{
 const temp='Fictional temporary passphrase 7311!',final='Fictional final passphrase 7312!';
 const challenge=(value:AuthReply)=>{if(!('challenge' in value))throw new Error('Expected challenge');return value.challenge;};
 beforeEach(async()=>{
  vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','7'.repeat(64));vi.stubEnv('AUTH_DEFAULT_ORGANIZATION','alpha');
  await bootstrapInternalOwner(owner.client,{appUserId:base.adminUserId,organization:'alpha',username:'owner',email:'owner@example.test',password:temp,installationOperator:true});
  // The acting administrator completes the first sign-in, as test/internal-auth.test.ts does before account actions.
  const first=await startLogin({organization:'alpha',username:'owner',password:temp,native:false});
  const setup=await changeInitialPassword(challenge(first),final,false);
  if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected MFA setup');
  await verifyMfa(challenge(setup),await generate({secret:setup.secret}),false,false);
 });

 it('ends the merged login\'s sessions by rotating its credential, keeps the credential, and only the master resolves at sign-in',async()=>{
  const group:SessionContext={...ctx,grants:[{role:'hr_admin',companyId:null}]};
  const a=await login(base,'Fictional Nur Master',{ic:'910909-09-9090'});
  const hired=await hireEmployee(group,{person:{fullName:'Fictional Nur Copy',primaryEmail:'nur.copy@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2021-01-01'});
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:base.tenantId,personId:hired.personId,icNumber:'910909099090'})
   .onConflictDoUpdate({target:schema.employeeStatutoryMy.personId,set:{icNumber:'910909099090'}});
  const b=await createManualAccount(group,{id:randomUUID(),personId:hired.personId,username:'nur.copy',email:'nur.copy@example.test',role:'employee',companyId:null,password:temp,ownershipAttested:true});
  const credential=await credentialByLogin('alpha','nur.copy');
  expect(credential).toBeTruthy();
  const resolves=async()=>(await client`select app_user_id from app.principal_by_identity(${credential!.issuer},${credential!.subject})`).length>0;
  expect(await resolves()).toBe(true);
  const digest=(await identityGroup(group)).digest;
  const {mergeIds}=await mergeLogins(group,input({groupDigest:digest,masterId:a.appUserId,mergedIds:[b]}));
  const after=await credentialByLogin('alpha','nur.copy');
  expect(after?.subject).toBe(credential!.subject);
  expect(after?.version).not.toBe(credential!.version);
  expect(await resolves()).toBe(false);
  const payload=(await owner.client`select payload from domain_event where aggregate_id=${b}::uuid and event_type='app-user.merged'`)[0]?.payload as {sessionsEnded?:boolean};
  expect(payload?.sessionsEnded).toBe(true);
  await undoLoginMerge(group,{mergeId:mergeIds[0],reason:'Fictional reviewed undo',removeCarried:{roleAssignmentIds:[],assistant:false}});
  expect(await resolves()).toBe(true);
 });
});
