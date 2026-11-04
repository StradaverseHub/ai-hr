/** Installed migration: real app-role readers share barriers; real admission remains exclusive. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {setAiFeature,setAiAllowance} from '../core/ai-management';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');
 ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};await setAiFeature(ctx,'hr_assistant',true);
});
const observe=()=>owner.client.begin(async observer=>{
 const [r]=await observer`select pg_try_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(${b.tenantId}))as reader,
  pg_try_advisory_xact_lock(hashtext('ai-control'),hashtext(${b.tenantId}))as writer`;return r;
});
const check=()=>withTenant(ctx,async tx=>{
 await tx.execute(sql`set transaction read only`);await assertAiPrincipalTx(tx,ctx);
 const [r]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);return r.allowed;
});
it('overlaps an independent read-only policy reader and excludes policy writers',async()=>{
 await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(${b.tenantId}))`;
  await withTenant(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);await tx.execute(sql`set local lock_timeout='1000ms'`);
   await assertAiPrincipalTx(tx,ctx);
   const [r]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);
   expect(r.allowed).toBe(true);expect(await observe()).toEqual({reader:true,writer:false});
  });
 });
});
it('retains exclusive read-write checks/admission and a non-upgradable read-only carrier',async()=>{
 await withTenant(ctx,async tx=>{
  await assertAiPrincipalTx(tx,ctx);await tx.execute(sql`select app.ai_action_unpaused('hr_assistant',false)`);
  expect(await observe()).toEqual({reader:false,writer:false});
 });
 let id:string|undefined;
 await withTenant(ctx,async tx=>{
  const [r]=await tx.execute<{allowed:boolean;run_id:string}>(sql`select * from app.ai_admit('hr_assistant','conversation','fixture','never-sent',1)`);
  expect(r.allowed).toBe(true);id=r.run_id;expect(await observe()).toEqual({reader:false,writer:false});
 });
 expect(id).toBeTruthy();await withTenant(ctx,tx=>tx.execute(sql`select app.ai_settle(${id}::uuid,false,null)`));
 const error=await withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);await assertAiPrincipalTx(tx,ctx);
  await tx.execute(sql`select app.ai_action_unpaused('hr_assistant',false)`);await tx.execute(sql`set transaction read write`);
 }).then(()=>null,(error:unknown)=>error);expect(pgSqlState(error)).toBe('25001');
});
it('reads fresh company and feature pauses rather than retaining an earlier allowed result',async()=>{
 expect(await check()).toBe(true);
 await setAiAllowance(ctx,{kind:'company',subjectId:b.companyId,enabled:false,dailyRequests:null,monthlyTokens:null});
 expect(await check()).toBe(false);
 await setAiAllowance(ctx,{kind:'company',subjectId:b.companyId,enabled:true,dailyRequests:null,monthlyTokens:null});
 expect(await check()).toBe(true);await setAiFeature(ctx,'hr_assistant',false);expect(await check()).toBe(false);
 await setAiFeature(ctx,'hr_assistant',true);expect(await check()).toBe(true);
});
