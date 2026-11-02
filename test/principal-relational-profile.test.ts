/** Reversible native predicate experiment. No permission-result cache or application/migration edit. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('profiles direct relational grant matching against the exact original definer predicate and live authority changes',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const users=Array.from({length:500},()=>({userId:randomUUID(),personId:randomUUID(),employmentId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional principal profile',primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'principal_profile_'+u.userId})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:b.companyId})));
 for(const table of ['employment','person','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
 const ctx=(u:typeof users[number]):SessionContext=>({...adminCtx(b),userId:u.userId,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]});
 const signature='app.principal_snapshot_current()';
 const [original]=await owner.client`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,pg_get_userbyid(p.proowner)as owner_name,to_jsonb(p)-'prosrc'as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
 expect(original.body).toContain('jsonb_array_elements(p.grants) actual');expect(original.definition.split(signature)).toHaveLength(2);
 const replacement=`BEGIN RETURN (
 WITH actual_roles AS MATERIALIZED (
  SELECT ra.app_user_id,ra.role::text AS role,ra.company_id FROM public.role_assignment ra WHERE ra.app_user_id=app.current_user_id()
 ) SELECT EXISTS(SELECT 1 FROM public.app_user u
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND NOT EXISTS(SELECT 1 FROM unnest(app.current_roles())claimed(role) WHERE NOT EXISTS(
  SELECT 1 FROM actual_roles actual WHERE actual.app_user_id=u.id AND actual.role=claimed.role))
 AND NOT EXISTS(SELECT 1 FROM app.current_grants()claimed WHERE NOT EXISTS(
  SELECT 1 FROM actual_roles actual WHERE actual.app_user_id=u.id AND actual.role=claimed.role AND
   (actual.company_id IS NULL OR actual.company_id=claimed.company_id OR
    (claimed.company_id IS NOT NULL AND app.is_company_descendant(claimed.company_id,actual.company_id)))))
 )); END;`;
 const candidate=original.definition.replace(original.body,replacement);expect(candidate).not.toBe(original.definition);
 // The donor retains the original SECURITY DEFINER body, owner, volatility and search path.
 await owner.client.unsafe(original.definition.replace(signature,'app.perf_principal_original()'));
 await owner.client.unsafe('ALTER FUNCTION app.perf_principal_original() OWNER TO "'+original.owner_name.replaceAll('"','""')+'"; REVOKE ALL ON FUNCTION app.perf_principal_original() FROM PUBLIC; GRANT EXECUTE ON FUNCTION app.perf_principal_original() TO ai_hr_app');
 const profile={kind:'REVERSIBLE_COMPONENT_ONLY_NOT_500_USER_CAPACITY',actors:500,projectionRowsPerActor:20,rows:{}as Record<string,number[]>,controls:0,restoredByteExact:false,donorDropped:false};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/principal-relational-profile.json',JSON.stringify(profile,null,2));};
 const burst=async()=>{const start=performance.now();const results=await Promise.allSettled(users.map(async u=>{
  const rows=await withTenant(ctx(u),tx=>tx.execute<{valid:boolean}>(sql`select app.principal_snapshot_current()as valid from generate_series(1,20)n`));expect(rows).toHaveLength(20);expect(rows.every(row=>row.valid===true)).toBe(true);
 }));expect(results.filter(r=>r.status==='rejected')).toEqual([]);return performance.now()-start;};
 const outcome=async(tx:Tx,donor:boolean)=>{
  try{return await tx.transaction(async inner=>{const [row]=await inner.execute<{value:boolean}>(donor?sql`select app.perf_principal_original()as value`:sql`select app.principal_snapshot_current()as value`);return {value:row.value};});}
  catch(error){let cause:unknown=error;for(let i=0;i<8&&cause&&typeof cause==='object';i++){if('code'in cause)return {sqlState:String(cause.code)};cause='cause'in cause?cause.cause:undefined;}throw error;}
 };
 const oracle=async(tx:Tx,expected?:boolean)=>{const original=await outcome(tx,true),current=await outcome(tx,false);expect(current).toEqual(original);if(expected!==undefined)expect(current).toEqual({value:expected});profile.controls++;};
 try{
  await burst();profile.rows.original=[await burst(),await burst()];save();
  await owner.client.unsafe(candidate);
  const [changed]=await owner.client`select to_jsonb(p)-'prosrc'as attributes from pg_proc p where p.oid=${signature}::regprocedure`;expect(changed.attributes).toEqual(original.attributes);
  await burst();profile.rows.candidate=[await burst(),await burst()];save();
  for(const user of [users[0].userId,users[1].userId,randomUUID(),''])for(const tenant of [b.tenantId,foreign.tenantId])for(const roles of ['employee','super_admin',''])for(const grants of ['[]','null','{}','{broken',JSON.stringify([{role:'employee',companyId:b.companyId}]),JSON.stringify([{role:'employee',companyId:'invalid-uuid'}])]){
   await withTenant(ctx(users[0]),async tx=>{await tx.execute(sql`select set_config('app.user_id',${user},true),set_config('app.tenant_id',${tenant},true),set_config('app.roles',${roles},true),set_config('app.grants',${grants},true)`);await oracle(tx);});
  }
  await withTenant(adminCtx(b),tx=>oracle(tx,true));
  await withTenant(ctx(users[0]),async tx=>{
   await oracle(tx,true);
   await owner.client`update app_user set archived_at=now()where id=${users[0].userId}::uuid`;await oracle(tx,false);
   await owner.client`update app_user set archived_at=null where id=${users[0].userId}::uuid`;await oracle(tx,true);
   const roles=await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,users[0].userId));
   await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,users[0].userId));await oracle(tx,false);
   await owner.db.insert(s.roleAssignment).values(roles);await oracle(tx,true);
  });save();
 }finally{
  await owner.client.unsafe(original.definition);await owner.client.unsafe('DROP FUNCTION app.perf_principal_original()');profile.donorDropped=true;
  const [restored]=await owner.client`select pg_get_functiondef(${signature}::regprocedure)as definition`;profile.restoredByteExact=restored.definition===original.definition;save();expect(profile.restoredByteExact).toBe(true);
 }
 profile.rows.restored=[await burst(),await burst()];save();
},180000);
