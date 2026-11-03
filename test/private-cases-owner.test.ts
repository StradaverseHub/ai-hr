/** Migration 0959 under staging's restricted physical-owner shape: a NOSUPERUSER, NOBYPASSRLS role that owns the four
 * private case tables and their definer functions. CI's own owner is a superuser, which bypasses even forced row
 * security, so test/private-cases.test.ts cannot prove the owner-side policies. Here the tables and functions move to
 * such a role inside ONE transaction that is always rolled back, and, on fictional cases:
 *  1. the definer name lookup answers a handler with the case's names and anyone else with nothing; the intake lookup
 *     names the company's possible readers to a person who works there;
 *  2. a case opened on the group-administrator route, leaving out a group administrator, passes the insert guard, whose
 *     definer checks read the administrators, and the audit trigger writes its creation row as the author; a case on
 *     the handlers route gets its handler's content-free notice through the definer notice trigger; the author's
 *     has-reader check answers for each;
 *  3. person erasure, through the definer function and the admitted intent, deletes the subject's closed case and marks
 *     the open one, touching nobody else's, while the administrator's own session reads no case of the subject. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {designateCaseHandler,openPrivateCase,privateCaseAad,setPrivateCaseStatus} from '../core/private-cases';
import {encryptSecret} from '../lib/ai/crypto';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base;
type Actor={ctx:SessionContext&{userId:string};personId:string;employmentId:string};
async function hire(name:string,role:'employee'|'hr_admin'):Promise<Actor>{
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 return{ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]},personId:hired.personId,employmentId:hired.employmentId};
}
/** Acts as the application role for one login inside the shared transaction, as withTenant would. */
async function as(tx:Tx,ctx:SessionContext){
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 await tx.execute(sql`RESET ROLE`);
 await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
  set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.agent_principal_id','',true)`);
 await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
}
const ids=async(tx:Tx,query:ReturnType<typeof sql>)=>(await tx.execute<{id:string}>(query)).map(row=>String(row.id)).sort();

beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-restricted-case-owner-key');await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');});

it('definer lookups, the insert guard, the audit trigger and person erasure work under forced RLS for a restricted owner, and none of them widens a read',async()=>{
 const group=adminCtx(b),author=await hire('Fictional Owner Author','employee'),handler=await hire('Fictional Owner Handler','employee'),peer=await hire('Fictional Owner Peer','employee');
 const second=await hire('Fictional Owner Second Group Administrator','hr_admin');
 await designateCaseHandler(group,{companyId:b.companyId,appUserId:handler.ctx.userId});
 const open=(who:Actor)=>openPrivateCase(who.ctx,{companyId:b.companyId,category:'safety',text:'Fictional restricted-owner text.'}).then(row=>row.caseId);
 const closed=await open(author),live=await open(author),theirs=await open(peer);
 await setPrivateCaseStatus(handler.ctx,{caseId:closed,expected:'received',status:'closed'});
 const role='private_case_owner_'+randomUUID().replaceAll('-',''),rollback=new Error('rollback-restricted-case-owner');
 let verified=0;
 await expect(owner.withTenant(group,async tx=>{
  await tx.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`));
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public,app TO ${role}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role}`));
  // Staging's physical owner owns every table, so the definers read the (unforced) people tables as their owner too.
  for(const table of ['public.app_user','public.person','public.role_assignment','public.employment','public.company','public.tenant_module','public.notification',
   'public.private_case_handler','public.private_case','public.private_case_note','public.private_case_event','app.assistant_review_erasure_intent'])
   await tx.execute(sql.raw(`ALTER TABLE ${table} OWNER TO ${role}`));
  for(const fn of ['app._private_case_login_current(uuid)','app._private_case_handler_eligible(uuid,uuid,uuid)','app.private_case_route_configured(uuid,uuid)',
   'app._private_case_handler_remains(uuid,uuid,uuid,uuid[],uuid[])','app.private_case_author_company(uuid)','app._private_case_group_admin_available(uuid,uuid,uuid[])',
   'app._private_case_possible_reader(uuid,uuid,uuid)','app.private_case_has_reader(uuid,uuid,uuid,text,uuid[],uuid[])','app.private_case_notify()',
   'app.private_case_intake_readers(uuid)','app.private_case_names(uuid)','app._private_case_erasure_subject(uuid,uuid,uuid)','app.private_cases_redact(uuid)'])
   await tx.execute(sql.raw(`ALTER FUNCTION ${fn} OWNER TO ${role}`));
  const [shape]=await tx.execute<Record<string,boolean>>(sql`select r.rolsuper as super,r.rolbypassrls as bypass,pg_has_role('ai_hr_app',r.oid,'MEMBER') as app_member,
   (select bool_and(c.relforcerowsecurity and c.relrowsecurity and c.relowner=r.oid) from pg_class c where c.oid in ('public.private_case'::regclass,'public.private_case_note'::regclass,
    'public.private_case_event'::regclass,'public.private_case_handler'::regclass)) as forced_owned
   from pg_roles r where r.rolname=${role}`);
  expect(shape).toEqual({super:false,bypass:false,app_member:false,forced_owned:true});
  // Non-vacuity: the superuser sees every case.
  expect(await ids(tx,sql`select id from public.private_case`)).toEqual([closed,live,theirs].sort());

  // 1. Definer lookups answer for the calling login only.
  await as(tx,handler.ctx);
  expect((await tx.execute<{display_name:string}>(sql`select display_name from app.private_case_names(${live}::uuid)`)).map(row=>row.display_name)).toContain('Fictional Owner Author');
  expect(await ids(tx,sql`select id from public.private_case`)).toEqual([closed,live,theirs].sort());
  await as(tx,peer.ctx);
  expect(await tx.execute(sql`select * from app.private_case_names(${live}::uuid)`)).toEqual([]);
  await as(tx,author.ctx);
  expect((await tx.execute<{app_user_id:string;reader_kind:string}>(sql`select app_user_id,reader_kind from app.private_case_intake_readers(${b.companyId}::uuid)`)).map(row=>[row.app_user_id,row.reader_kind]))
   .toEqual([[handler.ctx.userId,'handler'],[second.ctx.userId,'group_admin'],[group.userId,'group_admin']]);
  verified++;

  // 2. The group-administrator route, leaving out the second group administrator: the guard's definer checks read the
  //    administrators; the audit row is the author's; the has-reader check answers.
  const routed=randomUUID(),notified=randomUUID();
  await tx.execute(sql`insert into public.private_case(id,tenant_id,company_id,author_user_id,author_person_id,category,route,excluded_user_ids,body_ciphertext)
   values(${routed}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${author.ctx.userId}::uuid,${author.personId}::uuid,'other','group_admin',
    array[${second.ctx.userId}::uuid],${encryptSecret('Fictional routed text.',privateCaseAad(b.tenantId,routed,author.ctx.userId))})`);
  expect(await tx.execute<{kind:string}>(sql`select kind from public.private_case_event where case_id=${routed}::uuid`).then(rows=>rows.map(row=>row.kind))).toEqual(['created']);
  expect(await tx.execute(sql`select app.private_case_has_reader(c.tenant_id,c.company_id,c.author_user_id,c.route,c.excluded_user_ids,c.handler_user_ids) as reachable
   from public.private_case c where c.id=${routed}::uuid`)).toEqual([{reachable:true}]);
  // The handlers route: the definer notice trigger writes the handler's content-free notice.
  await tx.execute(sql`insert into public.private_case(id,tenant_id,company_id,author_user_id,author_person_id,category,body_ciphertext)
   values(${notified}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${author.ctx.userId}::uuid,${author.personId}::uuid,'grievance',
    ${encryptSecret('Fictional notified text.',privateCaseAad(b.tenantId,notified,author.ctx.userId))})`);
  // The guard froze the handler through the definer eligibility check, under the restricted owner.
  expect(await tx.execute(sql`select route,handler_user_ids as handlers from public.private_case where id=${notified}::uuid`)).toEqual([{route:'handlers',handlers:[handler.ctx.userId]}]);
  expect(await tx.execute(sql`select app.private_case_route_configured(${b.tenantId}::uuid,${b.companyId}::uuid) as configured`)).toEqual([{configured:true}]);
  await as(tx,handler.ctx);
  expect(await ids(tx,sql`select id from public.private_case`)).not.toContain(routed);
  expect(await tx.execute(sql`select kind,title,body,link_path from public.notification where kind like 'private-case.%' and link_path=${'/cases/'+notified}`))
   .toEqual([{kind:'private-case.waiting',title:'A private case is waiting',body:'Open Private cases to read it.',link_path:'/cases/'+notified}]);
  await as(tx,second.ctx);
  expect(await ids(tx,sql`select id from public.private_case where id=${routed}::uuid`)).toEqual([]);
  await as(tx,group);
  expect(await ids(tx,sql`select id from public.private_case`)).toEqual([routed]);
  verified++;

  // 3. Person erasure: the admitted intent for the subject in THIS transaction (as app.assistant_own_leave_reviews_redact
  //    records it), then the definer function from the administrator's application session.
  await tx.execute(sql`RESET ROLE`);
  await tx.execute(sql`insert into app.assistant_review_erasure_intent(xact_id,tenant_id,user_id,person_id,employment_id,cleared,event_id,review_ids)
   values(pg_current_xact_id(),${b.tenantId}::uuid,${group.userId}::uuid,${author.personId}::uuid,${author.employmentId}::uuid,0,null,'{}'::uuid[])`);
  await as(tx,group);
  expect(await ids(tx,sql`select id from public.private_case where author_user_id=${author.ctx.userId}::uuid and route='handlers'`)).toEqual([]);
  expect(await tx.execute(sql`select app.private_cases_redact(${author.employmentId}::uuid) as touched`)).toEqual([{touched:4}]);
  await tx.execute(sql`RESET ROLE`);
  const left=await tx.execute<{id:string;erasure:boolean;status:string}>(sql`select id,erasure_requested_at is not null as erasure,status from public.private_case order by id`);
  expect(left.map(row=>({...row}))).toEqual([{id:live,erasure:true,status:'received'},{id:routed,erasure:true,status:'received'},{id:notified,erasure:true,status:'received'},
   {id:theirs,erasure:false,status:'received'}].sort((x,y)=>x.id<y.id?-1:1));
  expect(await tx.execute(sql`select 1 from public.private_case_event where case_id=${closed}::uuid`)).toEqual([]);
  expect(await tx.execute(sql`select current_setting('app.private_case_erasure',true) as marker`)).toEqual([{marker:''}]);
  verified++;
  throw rollback;
 })).rejects.toBe(rollback);
 expect(verified).toBe(3);
 // Rolled back: every case and the original owner are back.
 const [after]=await owner.db.execute<{cases:number;owned:boolean}>(sql`select (select count(*)::int from public.private_case) as cases,
  (select pg_get_userbyid(relowner)=current_user from pg_class where oid='public.private_case'::regclass) as owned`);
 expect(after).toEqual({cases:3,owned:true});
});
