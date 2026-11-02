/** Isolated compatibility review of published security300fc; public owner functions are never replaced. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {closeAll,migrateTestDb,owner,resetDb} from './harness';
import {seedOrg,CONTEXTS,ALL_EMP,E,P,C,b,ctxByName} from './r395-org';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains the exact new data-permission filter and proves the old fallback is incompatible',async()=>{
 await resetDb();await seedOrg();
 const users=Array.from({length:500},()=>({userId:randomUUID(),personId:randomUUID(),employmentId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional compatibility reader',primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:C.A,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'compatibility_'+u.userId})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:C.A})));
 for(const table of ['employment','person','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const signature='app.visible_employment_ids()';
 const [original]=await owner.client`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
 expect(createHash('sha256').update(original.body).digest('hex')).toBe('28d07820f74c1f96028da856e12c851e301cf3a44e64907984338899af7973fb');
 const tailStart='SELECT coalesce(array_agg(v.id ORDER BY v.id)';expect(original.body.split(tailStart)).toHaveLength(2);
 const body=original.body.trim().replace(/;$/,''),tail=body.slice(body.indexOf(tailStart));
 expect(tail).toContain('app.data_permission_matches(v.id) OR EXISTS');expect(tail).toContain('u.tenant_id=own.tenant_id');
 const proposed=`SELECT CASE WHEN NOT app.is_admin() AND NOT EXISTS(
 SELECT 1 FROM public.employment me JOIN public.app_user u ON u.person_id=me.person_id
 JOIN public.reporting_line rl ON rl.manager_employment_id=me.id
 WHERE u.id=app.current_user_id() AND me.tenant_id=app.current_tenant_id() AND me.terminated_on IS NULL
  AND rl.line_type='administrative' AND rl.superseded_at IS NULL AND rl.valid_from<=current_date
  AND(rl.valid_to IS NULL OR rl.valid_to>current_date)
 ) THEN(WITH visible AS(
 SELECT e.id FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id
 WHERE e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()) ${tail})
 ELSE(${body})END;`;
 const clone=original.definition.replace(signature,'app.perf_scoped_visibility()').replace(original.body,proposed);
 const legacyBody=readFileSync('db/migrations/0515_set_based_visibility.sql','utf8').split('CREATE OR REPLACE FUNCTION app.visible_employment_ids()')[1].split('AS $$')[1].split('$$;')[0];
 const profile:Record<string,unknown>={kind:'SECURITY_VISIBILITY_COMPATIBILITY_NOT_IMPLEMENTATION_OR_CAPACITY',ownerSource:'300fc52f1556361de8b976092a9088f6b90b3c15',actors:500,contexts:CONTEXTS.length,controls:0,exactFilterRetained:true,publicDefinitionUnchanged:false,privateHelpersDropped:false,oldFallbackIncompatible:false};let controls=0;
 const save=()=>{profile.controls=controls;if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/security-visibility-compatibility.json',JSON.stringify(profile));};
 const ctx=(u:typeof users[number]):SessionContext=>({tenantId:b.tenantId,userId:u.userId,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:C.A}]});
 const compare=async(tx:Tx,expected?:string[])=>{
  const [row]=await tx.execute(sql`select app.visible_employment_ids()as actual,app.perf_scoped_visibility()as prototype`);
  expect(row.prototype).toEqual(row.actual);if(expected)expect(row.actual).toEqual([...expected].sort());controls++;return row.actual as string[];
 };
 const time=async(fn:'actual'|'prototype')=>withTenant(ctx(users[0]),async tx=>{
  const statement=sql.raw(fn==='actual'?'select app.visible_employment_ids()':'select app.perf_scoped_visibility()');
  for(let i=0;i<10;i++)await tx.execute(statement);
  const start=performance.now();for(let i=0;i<100;i++)await tx.execute(statement);return performance.now()-start;
 });
 try{
  await owner.client.unsafe(clone);
 await owner.client.unsafe('CREATE FUNCTION app.perf_legacy_visible() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $legacy$'+legacyBody+'$legacy$');
 await owner.client.unsafe('REVOKE ALL ON FUNCTION app.perf_scoped_visibility(),app.perf_legacy_visible() FROM PUBLIC,ai_hr_app;GRANT EXECUTE ON FUNCTION app.perf_scoped_visibility(),app.perf_legacy_visible() TO ai_hr_app');
  await Promise.all(users.map(u=>withTenant(ctx(u),tx=>compare(tx,[u.employmentId]))));
  const universe=[...ALL_EMP,...users.map(u=>u.employmentId)];
  for(const who of CONTEXTS)await withTenant(who,async tx=>{
   const ids=await compare(tx);const [row]=await tx.execute(sql`select array(select id from unnest(ARRAY[${sql.join(universe.map(id=>sql`${id}::uuid`),sql`, `)}])id where app.can_see_employment(id)order by id)as ids`);expect(ids).toEqual(row.ids);controls++;
  });
  for(const grants of ['{broken','{}','null','[]',JSON.stringify([{role:'employee',companyId:'invalid-uuid'}])]){
   const outcome=async(name:string)=>{
    try{return {ids:await withTenant(ctx(users[0]),async tx=>{await tx.execute(sql`select set_config('app.grants',${grants},true)`);return(await tx.execute(sql.raw('select '+name+'as ids')))[0].ids;})};}
    catch(error){let cause=error as {code?:string;cause?:unknown};while(cause?.cause&&!cause.code)cause=cause.cause as typeof cause;return {error:cause.code??String(cause)};}
   };
   expect(await outcome('app.perf_scoped_visibility()')).toEqual(await outcome('app.visible_employment_ids()'));controls++;
  }
  profile.timings100ReadsMs={owner1:await time('actual'),prototype1:await time('prototype'),owner2:await time('actual'),prototype2:await time('prototype')};save();
  const manager=ctxByName('manager top (ceo)'),hod=ctxByName('HOD (hod)');
  await owner.db.update(s.person).set({gender:'female'}).where(eq(s.person.id,P.mid));await owner.db.update(s.person).set({gender:'male'}).where(eq(s.person.id,P.leaf));
  await owner.db.update(s.person).set({gender:'female'}).where(eq(s.person.id,P.hSub));await owner.db.update(s.person).set({gender:'male'}).where(eq(s.person.id,P.hodsub));
  const before=await withTenant(manager,tx=>compare(tx));expect(before).toContain(E.leaf);
  const id=randomUUID(),revision=randomUUID(),maleRevision=randomUUID();
  await owner.client`insert into data_permission_profile(id,tenant_id,name,enabled)values(${id},${b.tenantId},'Fictional compatibility scope',true)`;
  await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${revision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'gender',values:['female']}]})}::jsonb,${b.adminUserId})`;
  await owner.client`update data_permission_profile set active_revision_id=${revision} where id=${id}`;
  for(const who of [manager,hod])await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${who.userId},${id},${b.adminUserId})`;
  await withTenant(manager,async tx=>{
   await compare(tx,[E.ceo,E.mid]);const [old]=await tx.execute(sql`select app.perf_legacy_visible()as ids,app.can_see_employment(${E.leaf}::uuid)as leaf`);expect(old.ids as string[]).toContain(E.leaf);expect(old.leaf).toBe(false);profile.oldFallbackIncompatible=true;controls++;
   await owner.client`update data_permission_profile set enabled=false where id=${id}`;await compare(tx,[E.ceo]);
   await owner.client`update data_permission_profile set enabled=true,retired_at=now()where id=${id}`;await compare(tx,[E.ceo]);
   await owner.client`update data_permission_profile set retired_at=null,active_revision_id=null where id=${id}`;await compare(tx,[E.ceo]);
   await owner.client`update data_permission_profile set active_revision_id=${revision} where id=${id}`;await compare(tx,[E.ceo,E.mid]);
   await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${maleRevision},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'gender',values:['male']}]})}::jsonb,${b.adminUserId})`;
   await owner.client`update data_permission_profile set active_revision_id=${maleRevision} where id=${id}`;await compare(tx,[E.ceo,E.leaf]);
   await owner.client`update data_permission_profile set active_revision_id=${revision} where id=${id}`;
  });
  await withTenant(hod,tx=>compare(tx,[E.hod,E.hSub]));
  await owner.client`delete from user_data_permission_assignment where tenant_id=${b.tenantId} and user_id=${manager.userId}`;
  await withTenant(manager,tx=>compare(tx,before));save();
 }finally{
  await owner.client.unsafe('DROP FUNCTION IF EXISTS app.perf_scoped_visibility();DROP FUNCTION IF EXISTS app.perf_legacy_visible()');profile.privateHelpersDropped=true;
  const [after]=await owner.client`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
  profile.publicDefinitionUnchanged=after.definition===original.definition;expect(after.definition).toBe(original.definition);expect(after.attributes).toEqual(original.attributes);save();
 }
},240000);
