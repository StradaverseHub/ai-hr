/** Real display readers must overlap metadata readers; write owners still need exclusive barriers. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {hireEmployee} from '../core/org';
import {hasPersonPhoto} from '../core/person-photo';
import {readProfilePresentationPolicy} from '../core/profile-edit-policy';
import {pgSqlState} from '../lib/db-error';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('overlaps real profile presentation and Home photo checks with an independent metadata reader',async()=>{
 await resetDb();const b=await seedBase();
 const employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional policy reader',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,employee.personId,'employee'),personId:employee.personId,roles:['employee']};
 const expected=await readProfilePresentationPolicy(ctx),expectedPhoto=await hasPersonPhoto(ctx,employee.personId);
 expect(expected.visible.size).toBeGreaterThan(0);expect(expectedPhoto).toBe(false);
 const modes:boolean[]=[];
 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  // The observer delegates to real withTenant and native business readers. Only bounded native
  // diagnostic timeouts are added; identity, permission, policy and data queries are never mocked.
  const actual=database.withTenant;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:{readOnlySnapshot:true})=>actual(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);
   const result=await read(tx),[mode]=await tx.execute<{readOnly:boolean}>(sql`select current_setting('transaction_read_only')='on' as "readOnly"`);
   modes.push(mode.readOnly);return result;
  },options));
  try{
   const outcomes=await Promise.allSettled([readProfilePresentationPolicy(ctx),hasPersonPhoto(ctx,employee.personId)]);
   if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'profile-presentation-read-locks.json'),JSON.stringify({kind:'REAL_PROFILE_DISPLAY_READ_LOCK_COMPONENT_ONLY',releaseEligible:false,outcomes:outcomes.map(row=>({status:row.status,sqlState:row.status==='rejected'?pgSqlState(row.reason):null})),nativeReadOnlyModes:modes},null,2));
   expect(outcomes.map(row=>row.status)).toEqual(['fulfilled','fulfilled']);
   const policy=outcomes[0];if(policy.status==='fulfilled'&&typeof policy.value!=='boolean'){
    for(const key of ['editable','legacyPrimary','visible']as const)expect([...policy.value[key]].sort()).toEqual([...expected[key]].sort());
    expect(policy.value.ctx.userId).toBe(ctx.userId);
   }
   expect(outcomes[1]).toMatchObject({status:'fulfilled',value:expectedPhoto});expect(modes).toEqual([true,true]);
  }finally{spy.mockRestore();}
 });
});

it('admits only native read-only Read Committed carriers and preserves both exclusive write barriers',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 const readLock=(tx:Tx)=>tx.execute(sql`select app.access_profile_policy_read_lock()`);
 const state=(error:unknown)=>pgSqlState(error);
 expect(await database.withTenant(ctx,readLock).then(()=>null,state)).toBe('42501');
 expect(await database.withTenant(ctx,readLock,{readOnlySnapshot:true}).then(()=>null,state)).toBe('42501');
 for(const namespace of ['access-configuration:','profile-edit-policy:']){
  await owner.client.begin(async holder=>{
   await holder`select pg_advisory_xact_lock(hashtextextended(${namespace+b.tenantId},0))`;
   expect(await database.withTenant(ctx,async tx=>{
    await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`SET TRANSACTION READ ONLY`);return readLock(tx);
   }).then(()=>null,state)).toBe('55P03');
  });
 }
 await database.withTenant(ctx,async reader=>{
  await reader.execute(sql`SET TRANSACTION READ ONLY`);await readLock(reader);
  // The actual canonical write helper and a raw relevant settings writer must both wait.
  expect(await database.withTenant(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);
   await tx.execute(sql`select app.access_profile_policy_write_lock()`);
  }).then(()=>null,state)).toBe('55P03');
  expect(await owner.client.begin(async writer=>{
   await writer`set local lock_timeout='300ms'`;
   await writer`insert into tenant_setting(tenant_id,key,value) values(${b.tenantId},'ess.profile_photo_edit','false'::jsonb)
    on conflict(tenant_id,key) do update set value=excluded.value`;
  }).then(()=>null,state)).toBe('55P03');
 });
 // A presentation carrier must never be upgraded into a write transaction.
 expect(await database.withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);await readLock(tx);
  await tx.execute(sql`SET TRANSACTION READ WRITE`);
 }).then(()=>null,state)).toBe('25001');
});

it('refuses a missing native policy generation anchor without granting access to the private table',async()=>{
 await resetDb();const b=await seedBase();
 const [permission]=await owner.client<{allowed:boolean}[]>`select has_table_privilege('ai_hr_app','app.access_profile_write_generation','SELECT') as allowed`;
 expect(permission.allowed).toBe(false);
 await owner.client`delete from app.access_profile_write_generation where tenant_id=${b.tenantId}`;
 expect(await readProfilePresentationPolicy(adminCtx(b)).then(()=>null,error=>pgSqlState(error))).toBe('42501');
});


it('reads the policy committed by a settings writer it actually waited behind',async()=>{
 await resetDb();const b=await seedBase(),ctx=adminCtx(b);
 expect((await readProfilePresentationPolicy(ctx)).visible.size).toBeGreaterThan(0);
 const hidden={version:3,fields:Object.fromEntries(essVisibleFields().map(field=>[field.id,'hide'])),primaryOnly:[]};
 let ready!:()=>void,release!:()=>void,fail!:(error:unknown)=>void;
 const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const watchdog=setTimeout(()=>{fail(Error('policy writer handshake timed out'));release();},10000);
 const writing=owner.client.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  ready();await finish;
  await tx`insert into tenant_setting(tenant_id,key,value) values(${b.tenantId},'ess.profile_change_fields',${JSON.stringify(hidden)}::jsonb)
   on conflict(tenant_id,key) do update set value=excluded.value`;
 });void writing.catch(fail);
 let reading:ReturnType<typeof readProfilePresentationPolicy>|undefined;
 try{
  await started;reading=readProfilePresentationPolicy(ctx);void reading.catch(()=>{});
  const deadline=Date.now()+4000;let waiting=false;
  while(Date.now()<deadline){
   const [row]=await owner.client<{waiting:boolean}[]>`select exists(select 1 from pg_locks l where l.locktype='advisory'
    and not l.granted and l.objsubid=1 and l.database=(select oid from pg_database where datname=current_database())
    and ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(${'access-configuration:'+b.tenantId},0)) as waiting`;
   if(row.waiting){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
  }
  expect(waiting,'actual presentation read must wait for the uncommitted writer').toBe(true);
 }finally{release();clearTimeout(watchdog);await writing;}
 expect(reading).toBeDefined();const result=await reading!;
 expect([...result.visible]).toEqual([]);expect([...result.editable]).toEqual([]);
 expect([...(await readProfilePresentationPolicy(ctx)).visible]).toEqual([]);
});
