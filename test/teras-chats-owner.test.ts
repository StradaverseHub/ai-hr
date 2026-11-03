/** Migration 0952 under staging's restricted physical-owner shape: a NOSUPERUSER, NOBYPASSRLS role that owns the chat
 * tables and their definer functions. CI's own owner is a superuser, which bypasses even forced row security, so the
 * superuser runs in test/teras-chats.test.ts cannot prove the owner-side policies. Here the tables and functions move to
 * such a role inside ONE transaction that is always rolled back, and, on fictional chats:
 *  1. the retention runner's pass, as that role's own session, sees and hard-deletes expired chats only; their turns go
 *     by the cascade and their task memory by the trigger; the session cannot read or select any turn, live or expired,
 *     and cannot delete a live chat;
 *  2. a group administrator's shortened setting brings other logins' expiries forward through the definer trigger,
 *     changing nothing else;
 *  3. person erasure, through the definer function and the admitted intent, deletes the subject's chats only, while the
 *     administrator's own session reads no chat of the subject even inside the erasure transaction;
 *  4. (migration 0973) on both deleting paths, the definer trigger on teras_chat, owned by the same role and bound by
 *     forced row security on letter_request, clears the card id (client_key) on the subject login's letter requests and
 *     nothing else, and never another login's. The letter requests here are synthetic storage rows written with the
 *     database's triggers off inside the rolled-back transaction; test/letter-request-chat-custody.test.ts covers the
 *     real chat card, owner and lifecycle. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {recordChatTurn} from '../core/teras-chats';
import {retireExpiredTerasChatsTx} from '../core/teras-chat-expiry';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base;
type Person={ctx:SessionContext&{userId:string};employmentId:string;personId:string};
async function hire(name:string,role:'employee'|'hr_admin'):Promise<Person>{
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);await grantAssistant(adminCtx(b),{appUserId:userId});
 return{ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]},employmentId:hired.employmentId,personId:hired.personId};
}
async function chat(ctx:SessionContext,question:string){
 const conversationId=randomUUID();
 const id=await recordChatTurn(ctx,{conversationId,conversationScope:JSON.stringify([b.companyId]),companyId:b.companyId,question,reply:'A fictional reply about '+question,
  modelRows:[{role:'user',content:question},{role:'assistant',content:'A fictional model-side reply.'}],withheld:false});
 if(id!==conversationId)throw Error('Chat fixture not stored.');
 await owner.db.execute(sql`insert into public.teras_task_memory(tenant_id,app_user_id,conversation_id,memory) values(${ctx.tenantId}::uuid,${ctx.userId}::uuid,${id},'{"fictional":true}'::jsonb)`);
 return id;
}
const ids=async(tx:Tx,query:ReturnType<typeof sql>)=>(await tx.execute<{id:string}>(query)).map(row=>String(row.id)).sort();

beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-restricted-chat-owner-key');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');});

it('retention, a shortened setting and person erasure work under forced RLS for a restricted owner, and none of them reads a turn',async()=>{
 const me=await hire('Fictional Restricted Owner Subject','employee'),peer=await hire('Fictional Restricted Owner Peer','employee'),admin=await hire('Fictional Restricted Owner Administrator','hr_admin');
 const expired=await chat(me.ctx,'an old fictional question'),live=await chat(me.ctx,'a new fictional question'),theirs=await chat(peer.ctx,'a neighbour fictional question');
 await owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);
  await tx.execute(sql`update public.teras_chat set created_at=now()-interval '41 days',last_message_at=now()-interval '40 days',expires_at=now()-interval '10 days' where id=${expired}::uuid`);});
 const role='teras_chat_owner_'+randomUUID().replaceAll('-',''),rollback=new Error('rollback-restricted-chat-owner');
 let verified=0;
 await expect(owner.withTenant(admin.ctx,async tx=>{
  await tx.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`));
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public,app TO ${role}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role}`));
  await tx.execute(sql.raw(`GRANT SELECT ON public.app_user TO ${role}`));
  for(const table of ['public.teras_chat','public.teras_chat_turn','public.teras_chat_retention','public.teras_task_memory','app.assistant_review_erasure_intent','public.letter_request'])
   await tx.execute(sql.raw(`ALTER TABLE ${table} OWNER TO ${role}`));
  for(const fn of ['app.teras_chat_memory_erased()','app.teras_chat_retention_applied()','app.teras_chats_redact(uuid)','app._teras_chat_erasure_subject(uuid,uuid,uuid)','app.teras_chat_letter_card_keys_forgotten()'])
   await tx.execute(sql.raw(`ALTER FUNCTION ${fn} OWNER TO ${role}`));
  const [shape]=await tx.execute<Record<string,boolean>>(sql`select r.rolsuper as super,r.rolbypassrls as bypass,pg_has_role('ai_hr_app',r.oid,'MEMBER') as app_member,
   (select bool_and(c.relforcerowsecurity and c.relrowsecurity and c.relowner=r.oid) from pg_class c where c.oid in ('public.teras_chat'::regclass,'public.teras_chat_turn'::regclass,'public.teras_chat_retention'::regclass,'public.letter_request'::regclass)) as forced_owned
   from pg_roles r where r.rolname=${role}`);
  expect(shape).toEqual({super:false,bypass:false,app_member:false,forced_owned:true});
  // Synthetic letter requests of one synthetic template, written with the triggers off (no option, version or guard is
  // needed), each carrying a chat card's id. Their foreign keys are real: PostgreSQL re-checks every foreign key of a row
  // updated in the transaction that inserted it.
  const cards={mine:randomUUID(),theirs:randomUUID(),later:randomUUID()},templateId=randomUUID();
  await tx.execute(sql`set local session_replication_role=replica`);
  await tx.execute(sql`insert into public.letter_template(id,tenant_id,company_id,code,created_by) values(${templateId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'FICTIONAL',${admin.ctx.userId}::uuid)`);
  await tx.execute(sql`set local session_replication_role=origin`);
  const request=async(who:Person,key:string)=>{await tx.execute(sql`set local session_replication_role=replica`);
   const [row]=await tx.execute<{id:string}>(sql`insert into public.letter_request(tenant_id,company_id,employment_id,requested_by,template_id,letter_type_name,client_key)
    values(${b.tenantId}::uuid,${b.companyId}::uuid,${who.employmentId}::uuid,${who.ctx.userId}::uuid,${templateId}::uuid,'Fictional letter',${key}::uuid) returning id`);
   await tx.execute(sql`set local session_replication_role=origin`);return row.id;};
  const mineRequest=await request(me,cards.mine),theirRequest=await request(peer,cards.theirs);
  const letterKeys=async()=>Object.fromEntries((await tx.execute<{id:string;client_key:string|null;version:number;status:string}>(sql`select id,client_key,version,status from public.letter_request order by id`))
   .map(row=>[row.id,[row.client_key,row.status,row.version]]));
  // Non-vacuity: the superuser sees every chat and turn.
  expect(await ids(tx,sql`select id from public.teras_chat`)).toEqual([expired,live,theirs].sort());
  expect((await tx.execute(sql`select 1 from public.teras_chat_turn`)).length).toBe(3);

  // 1. Retention, as the restricted owner's own session.
  await tx.execute(sql.raw(`SET LOCAL SESSION AUTHORIZATION ${role}`));
  const [who]=await tx.execute<{current:string;session:string}>(sql`select current_user as current,session_user as session`);
  expect(who).toEqual({current:role,session:role});
  expect(await tx.execute(sql`select question_ciphertext,reply_ciphertext,model_ciphertext from public.teras_chat_turn`)).toEqual([]);
  expect(await tx.execute(sql`select count(*)::int as n from public.teras_chat_turn`)).toEqual([{n:0}]);
  expect(await ids(tx,sql`select id from public.teras_chat`)).toEqual([expired]);
  expect(await retireExpiredTerasChatsTx(tx)).toBe(1);
  expect(await ids(tx,sql`select id from public.teras_chat`)).toEqual([]);
  expect(await tx.execute(sql`delete from public.teras_chat where id=${live}::uuid returning id`)).toEqual([]);
  expect(await tx.execute(sql`update public.teras_chat set turn_count=turn_count where id=${live}::uuid returning id`)).toEqual([]);
  await tx.execute(sql`RESET SESSION AUTHORIZATION`);
  expect(await ids(tx,sql`select id from public.teras_chat`)).toEqual([live,theirs].sort());
  expect(await ids(tx,sql`select chat_id as id from public.teras_chat_turn`)).toEqual([live,theirs].sort());
  expect(await ids(tx,sql`select conversation_id as id from public.teras_task_memory`)).toEqual([live,theirs].sort());
  // 4a. The expired chat's login loses its card ids; the other login keeps its own; nothing else changes.
  expect(await letterKeys()).toEqual({[mineRequest]:[null,'requested',1],[theirRequest]:[cards.theirs,'requested',1]});
  expect(await tx.execute(sql`select coalesce(current_setting('app.letter_request_card_keys',true),'') as marker`)).toEqual([{marker:''}]);
  verified++;

  // 2. A shortened setting, written by the group administrator's own application session.
  await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
  await tx.execute(sql`insert into public.teras_chat_retention(tenant_id,keep_days,changed_by_user_id) values(${b.tenantId}::uuid,1,${admin.ctx.userId}::uuid)`);
  // The administrator still reads no chat.
  expect(await tx.execute(sql`select id from public.teras_chat`)).toEqual([]);
  await tx.execute(sql`RESET ROLE`);
  const windows=await tx.execute<{id:string;days:number;turns:number}>(sql`select id,round(extract(epoch from expires_at-last_message_at)/86400)::int as days,turn_count as turns from public.teras_chat order by id`);
  expect(windows).toEqual([live,theirs].sort().map(id=>({id,days:1,turns:1})));
  expect(await tx.execute(sql`select current_setting('app.teras_chat_restamp',true) as marker`)).toEqual([{marker:''}]);
  verified++;

  const laterRequest=await request(me,cards.later);
  // 3. Person erasure: the admitted intent for the subject in THIS transaction (as app.assistant_own_leave_reviews_redact
  //    records it), then the definer function from the administrator's application session.
  await tx.execute(sql`insert into app.assistant_review_erasure_intent(xact_id,tenant_id,user_id,person_id,employment_id,cleared,event_id,review_ids)
   values(pg_current_xact_id(),${b.tenantId}::uuid,${admin.ctx.userId}::uuid,${me.personId}::uuid,${me.employmentId}::uuid,0,null,'{}'::uuid[])`);
  await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
  expect(await tx.execute(sql`select id from public.teras_chat`)).toEqual([]);
  expect(await tx.execute(sql`select 1 from public.teras_chat_turn`)).toEqual([]);
  expect(await tx.execute(sql`select app.teras_chats_redact(${me.employmentId}::uuid) as cleared`)).toEqual([{cleared:1}]);
  await tx.execute(sql`RESET ROLE`);
  expect(await ids(tx,sql`select id from public.teras_chat`)).toEqual([theirs]);
  expect(await ids(tx,sql`select chat_id as id from public.teras_chat_turn`)).toEqual([theirs]);
  expect(await ids(tx,sql`select conversation_id as id from public.teras_task_memory`)).toEqual([theirs]);
  // 4b. The erased subject's card id confirmed during their live chat goes; the other login's stays.
  expect(await letterKeys()).toEqual({[mineRequest]:[null,'requested',1],[laterRequest]:[null,'requested',1],[theirRequest]:[cards.theirs,'requested',1]});
  verified++;
  throw rollback;
 })).rejects.toBe(rollback);
 expect(verified).toBe(3);
 // Rolled back: every chat, turn and the original owner are back.
 const [after]=await owner.db.execute<{chats:number;turns:number;owned:boolean}>(sql`select (select count(*)::int from public.teras_chat) as chats,(select count(*)::int from public.teras_chat_turn) as turns,
  (select pg_get_userbyid(relowner)=current_user from pg_class where oid='public.teras_chat'::regclass) as owned`);
 expect(after).toEqual({chats:3,turns:3,owned:true});
});
