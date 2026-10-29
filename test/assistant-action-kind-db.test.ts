/** WP7 (review R3): app.assistant_action_kind is the SQL side of lib/ai/agent-action-registry.ts. Fictional
 * storage fixtures inside rolled-back transactions only; they prove the reference, its grants and refusals,
 * never canonical action provenance. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {NEVER_AUTOMATIC_CATEGORIES} from '../lib/ai/agent-action-tiers';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
const ROLLBACK='ROLLBACK_WP7_FIXTURE';
const sqlCode=(error:unknown)=>{const value=error as {code?:string;cause?:{code?:string}};return value?.cause?.code??value?.code;};
async function refused(run:()=>Promise<unknown>,code:string){let caught:unknown=null;try{await run();}catch(error){caught=error;}expect(caught,`expected SQL refusal ${code}`).not.toBeNull();expect(sqlCode(caught)).toBe(code);}
const expected=()=>AGENT_ACTIONS.map(action=>({id:action.id,module:action.module,tier_ceiling:action.policy.tier,category:action.policy.category,review_kind:action.store==='human_workflow_only'?null:action.id}))
 .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);

describe('app.assistant_action_kind',()=>{
 it('holds exactly the registry, readable but not writable by the application role',async()=>{
  const rows=await owner.db.execute(sql`select id,module,tier_ceiling,category,review_kind from app.assistant_action_kind order by id collate "C"`);
  expect([...rows]).toEqual(expected());expect(rows.length).toBeGreaterThanOrEqual(30);
  const [grants]=await owner.db.execute<Record<string,boolean>>(sql`select has_table_privilege('ai_hr_app','app.assistant_action_kind','SELECT') as read,
   has_table_privilege('ai_hr_app','app.assistant_action_kind','INSERT') as insert,has_table_privilege('ai_hr_app','app.assistant_action_kind','UPDATE') as update,
   has_table_privilege('ai_hr_app','app.assistant_action_kind','DELETE') as delete,has_table_privilege('ai_hr_app','app.assistant_action_kind','TRUNCATE') as truncate,
   (select relrowsecurity from pg_class where oid='app.assistant_action_kind'::regclass) as rls`);
  expect(grants).toEqual({read:true,insert:false,update:false,delete:false,truncate:false,rls:true});
  const [visible]=await withTenant(adminCtx(base),tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from app.assistant_action_kind`));
  expect(visible?.n).toBe(AGENT_ACTIONS.length);
  await refused(()=>withTenant(adminCtx(base),tx=>tx.execute(sql`insert into app.assistant_action_kind values('leave.fabricated','leave','confirm','own_work','leave.fabricated')`)),'42501');
  await refused(()=>withTenant(adminCtx(base),tx=>tx.execute(sql`update app.assistant_action_kind set tier_ceiling='automatic' where id='leave.apply'`)),'42501');
 });

 it('replaces the closed CHECK lists with validated references from the store and the outcome association',async()=>{
  const constraints=await owner.db.execute<{conname:string;contype:string;convalidated:boolean;definition:string}>(sql`select conname,contype,convalidated,pg_get_constraintdef(oid) as definition from pg_constraint
   where conname in ('assistant_review_action_kind_registered','ai_native_outcome_association_action_registered','assistant_review_action_kind','ai_native_outcome_association_action') order by conname`);
  expect([...constraints]).toEqual([
   {conname:'ai_native_outcome_association_action_registered',contype:'f',convalidated:true,definition:'FOREIGN KEY (action) REFERENCES app.assistant_action_kind(id) ON UPDATE RESTRICT ON DELETE RESTRICT'},
   {conname:'assistant_review_action_kind_registered',contype:'f',convalidated:true,definition:'FOREIGN KEY (action_kind) REFERENCES app.assistant_action_kind(review_kind) ON UPDATE RESTRICT ON DELETE RESTRICT'},
  ]);
  // No closed membership list survives on either table (per-kind column rules use CASE and stay).
  const lists=await owner.db.execute(sql`select conname from pg_constraint where contype='c'
   and conrelid in ('app.assistant_own_leave_review'::regclass,'public.ai_native_outcome_association'::regclass)
   and (pg_get_constraintdef(oid) like 'CHECK ((action_kind = ANY (ARRAY[%' or pg_get_constraintdef(oid) like 'CHECK ((action = ANY (ARRAY[%')`);
  expect([...lists]).toEqual([]);
 });

 it('refuses never-Automatic categories as Automatic and an unregistered review kind, changing nothing',async()=>{
  await expect(owner.db.transaction(async tx=>{
   for(const category of NEVER_AUTOMATIC_CATEGORIES)
    await refused(()=>tx.transaction(nested=>nested.execute(sql`insert into app.assistant_action_kind values(${'test.'+category+'_automatic'},'payroll','automatic',${category},null)`)),'23514');
   await refused(()=>tx.transaction(nested=>nested.execute(sql`insert into app.assistant_action_kind values('test.own_work_automatic','leave','automatic','own_work',null)`)),'23514');
   await refused(()=>tx.transaction(nested=>nested.execute(sql`insert into app.assistant_action_kind values('test.mismatch','leave','confirm','own_work','test.other')`)),'23514');
   await tx.transaction(nested=>nested.execute(sql`insert into app.assistant_action_kind values('test.reminder_automatic','leave','automatic','reminder',null)`));
   // A store row that satisfies every per-kind column rule is refused by the reference alone once its kind
   // is not registered (the row is removed only inside this rolled-back transaction).
   await tx.execute(sql`delete from app.assistant_action_kind where id='typed_pay_components.create'`);
   const event=randomUUID();
   await tx.execute(sql`insert into public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${event}::uuid,${base.tenantId}::uuid,'fictional-wp7',${randomUUID()}::uuid,'fictional-wp7.created','user',${base.adminUserId}::uuid,'{}'::jsonb)`);
   await refused(()=>tx.transaction(nested=>nested.execute(sql`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,pay_component_id,pay_component_created_event_id,created_at,expires_at)
    values(${randomUUID()}::uuid,'typed_pay_components.create',${base.tenantId}::uuid,${base.adminUserId}::uuid,'completed',${randomUUID()}::uuid,${event}::uuid,now(),now()+interval '10 minutes')`)),'23503');
   throw Error(ROLLBACK);
  })).rejects.toThrow(ROLLBACK);
  const rows=await owner.db.execute(sql`select id,module,tier_ceiling,category,review_kind from app.assistant_action_kind order by id collate "C"`);
  expect([...rows]).toEqual(expected());
 });

 it('keeps a registered kind that the store references from being removed',async()=>{
  await expect(owner.db.transaction(async tx=>{
   const event=randomUUID();
   await tx.execute(sql`insert into public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${event}::uuid,${base.tenantId}::uuid,'fictional-wp7',${randomUUID()}::uuid,'fictional-wp7.created','user',${base.adminUserId}::uuid,'{}'::jsonb)`);
   await tx.execute(sql`insert into app.assistant_own_leave_review(id,action_kind,tenant_id,user_id,state,pay_component_id,pay_component_created_event_id,created_at,expires_at)
    values(${randomUUID()}::uuid,'typed_pay_components.create',${base.tenantId}::uuid,${base.adminUserId}::uuid,'completed',${randomUUID()}::uuid,${event}::uuid,now(),now()+interval '10 minutes')`);
   await refused(()=>tx.transaction(nested=>nested.execute(sql`delete from app.assistant_action_kind where id='typed_pay_components.create'`)),'23503');
   throw Error(ROLLBACK);
  })).rejects.toThrow(ROLLBACK);
 });
});
