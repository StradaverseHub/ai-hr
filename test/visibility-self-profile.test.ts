/** Reversible native necessary-only visibility fast path; no application or migration change. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {closeAll,migrateTestDb,owner} from './harness';
import {setupOrg,CONTEXTS,ALL_EMP,E,C,b,ctxByName} from './r395-org';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares the exact original ordered visibility and native row predicates across500 actors and live reporting changes',async()=>{
 await setupOrg();
 const users=Array.from({length:500},()=>({userId:randomUUID(),personId:randomUUID(),employmentId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional visibility profile',primaryEmail:u.userId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:C.A,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.userId,tenantId:b.tenantId,personId:u.personId,workosUserId:'visibility_self_'+u.userId})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.userId,role:'employee' as const,companyId:C.A})));
 for(const table of ['employment','person','app_user','role_assignment','reporting_line'])await owner.client.unsafe('analyze '+table);
 const signature='app.visible_employment_ids()';
 const [original]=await owner.client`select pg_get_functiondef(p.oid)as definition,p.prosrc as body,to_jsonb(p)-'prosrc'as attributes from pg_proc p where p.oid=${signature}::regprocedure`;
 expect(createHash('sha256').update(original.body).digest('hex')).toBe('a7e62cb809d2050c93759aee28c76f0da49a56f697ce4717ccb216b2c8ec6e30');
 const anchor=' END IF;\n  RETURN (';expect(original.body.split(anchor)).toHaveLength(2);
 // Both non-self branches require an active administrative edge from an active caller employment.
 // Keep the original grants parsing/admin decision above this necessary-only check.
 const fast=` END IF;
 IF NOT performance_has_admin AND NOT EXISTS(
  SELECT 1 FROM employment me JOIN app_user u ON u.person_id=me.person_id
  JOIN reporting_line rl ON rl.manager_employment_id=me.id
  WHERE u.id=app.current_user_id() AND me.tenant_id=app.current_tenant_id()
   AND me.terminated_on IS NULL AND rl.line_type='administrative' AND rl.superseded_at IS NULL
   AND rl.valid_from<=current_date AND(rl.valid_to IS NULL OR rl.valid_to>current_date)
 ) THEN
  RETURN(SELECT coalesce(array_agg(DISTINCT e.id ORDER BY e.id),'{}'::uuid[])
   FROM employment e JOIN app_user u ON u.person_id=e.person_id
   WHERE e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id());
 END IF;
  RETURN (`;
 const candidateBody=original.body.replace(anchor,fast),candidate=original.definition.replace(original.body,candidateBody);
 const ctx=(u:typeof users[number]):SessionContext=>({tenantId:b.tenantId,userId:u.userId,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:C.A}]});
 const universe=[...ALL_EMP,...users.map(u=>u.employmentId)];
 const profile:Record<string,unknown>={kind:'REVERSIBLE_VISIBILITY_SELF_PROFILE_NOT_CAPACITY',actors:500,contexts:CONTEXTS.length,rows:{},controls:0,restoredByteExact:false,donorDropped:false};let controls=0;
 const save=()=>{profile.controls=controls;if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/visibility-self-profile.json',JSON.stringify(profile));};
 expect(original.definition.split(signature)).toHaveLength(2);
 await owner.client.unsafe(original.definition.replace(signature,'app.perf_visible_original()'));
 await owner.client.unsafe('REVOKE ALL ON FUNCTION app.perf_visible_original() FROM PUBLIC,ai_hr_app; GRANT EXECUTE ON FUNCTION app.perf_visible_original() TO ai_hr_app');
 const pair=async(tx:Tx,expected?:string[])=>{
  const [row]=await tx.execute(sql`select app.visible_employment_ids()as actual,app.perf_visible_original()as original`);
  expect(row.actual).toEqual(row.original);if(expected)expect(row.actual).toEqual([...expected].sort());controls++;
  return row.actual as string[];
 };
 const burst=()=>withTenant(ctx(users[0]),async tx=>{
  for(let i=0;i<10;i++)await tx.execute(sql`select app.visible_employment_ids()`);
  const start=performance.now();for(let i=0;i<100;i++)await tx.execute(sql`select app.visible_employment_ids()`);return performance.now()-start;
 });
 const readErrors=async()=>{
  const results=[];
  for(const grants of ['{broken','{}','null','[]',JSON.stringify([{role:'employee',companyId:'invalid-uuid'}])]){
   for(const fn of ['app.visible_employment_ids()','app.perf_visible_original()']){
    try{results.push(await withTenant(ctx(users[0]),async tx=>{await tx.execute(sql`select set_config('app.grants',${grants},true)`);return (await tx.execute(sql.raw('select '+fn+' as ids')))[0].ids;}));}
    catch(error){let e=error as {code?:string;cause?:unknown};while(e?.cause&&!e.code)e=e.cause as typeof e;results.push({error:e.code??String(e)});}
   }
   expect(results.at(-2)).toEqual(results.at(-1));controls++;
  }
  return results;
 };
 try{
  profile.rows={original:[await burst(),await burst()]};save();
  await owner.client.unsafe(candidate);
  const [attributes]=await owner.client`select to_jsonb(p)-'prosrc'as value from pg_proc p where p.oid=${signature}::regprocedure`;expect(attributes.value).toEqual(original.attributes);
  const roles=await withTenant(ctx(users[0]),tx=>tx.execute(sql`select current_user as role`));expect(roles[0].role).toBe('ai_hr_app');
  await Promise.all(users.map(u=>withTenant(ctx(u),tx=>pair(tx,[u.employmentId]))));
  for(const context of CONTEXTS){
   await withTenant(context,async tx=>{
    const actual=await pair(tx);
    const [row]=await tx.execute(sql`select array(select id from unnest(ARRAY[${sql.join(universe.map(id=>sql`${id}::uuid`),sql`, `)}])id where app.can_see_employment(id)order by id)as ids`);expect(actual).toEqual(row.ids);controls++;
   });
  }
  const hod=await withTenant(ctxByName('HOD (hod)'),tx=>pair(tx));for(const id of [E.hod,E.hodsub,E.hSub,E.hA1,E.hSubTerminated])expect(hod).toContain(id);
  await readErrors();
  await withTenant(ctx(users[0]),async tx=>{
   await pair(tx,[users[0].employmentId]);
   const [edge]=await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:users[0].employmentId,subordinateEmploymentId:users[1].employmentId,lineType:'administrative',validFrom:'2099-01-01'}).returning({id:s.reportingLine.id});
   try{
    await pair(tx,[users[0].employmentId]);
    await owner.db.update(s.reportingLine).set({validFrom:'2020-01-01'}).where(eq(s.reportingLine.id,edge.id));await pair(tx,[users[0].employmentId,users[1].employmentId]);
    await owner.db.update(s.reportingLine).set({lineType:'functional'}).where(eq(s.reportingLine.id,edge.id));await pair(tx,[users[0].employmentId]);
    await owner.db.update(s.reportingLine).set({lineType:'administrative',supersededAt:new Date()}).where(eq(s.reportingLine.id,edge.id));await pair(tx,[users[0].employmentId]);
    await owner.db.update(s.reportingLine).set({supersededAt:null}).where(eq(s.reportingLine.id,edge.id));await pair(tx,[users[0].employmentId,users[1].employmentId]);
    await tx.execute(sql`select set_config('app.user_id',${users[1].userId},true)`);await pair(tx,[users[1].employmentId]);
    await tx.execute(sql`select set_config('app.user_id',${users[0].userId},true)`);await pair(tx,[users[0].employmentId,users[1].employmentId]);
   }finally{await owner.db.delete(s.reportingLine).where(eq(s.reportingLine.id,edge.id));}
   await pair(tx,[users[0].employmentId]);
  });
  (profile.rows as Record<string,unknown>).candidate=[await burst(),await burst()];save();
 }finally{
  await owner.client.unsafe(original.definition);await owner.client.unsafe('DROP FUNCTION app.perf_visible_original()');profile.donorDropped=true;
  const [restored]=await owner.client`select pg_get_functiondef(${signature}::regprocedure)as definition`;profile.restoredByteExact=restored.definition===original.definition;save();expect(profile.restoredByteExact).toBe(true);
 }
 (profile.rows as Record<string,unknown>).restored=[await burst(),await burst()];save();
},240000);
