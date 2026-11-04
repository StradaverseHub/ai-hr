/** Reversible native lock experiment. No installed migration or application behavior changes.
 * Actual app-role transactions compare the same policy owner before/after/restoration. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {setAiAllowance,setAiFeature} from '../core/ai-management';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
it('qualifies shared native read-only AI policy lookup without sharing admission or weakening revocation',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const other:SessionContext={...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]};
 await setModule(b.tenantId,'assistant','active');await setModule(foreign.tenantId,'assistant','active');
 await setAiFeature(ctx,'hr_assistant',true);await setAiFeature(other,'hr_assistant',true);
 const signature='app._ai_control_context(text,boolean)';
 const snapshot=async()=>{const [row]=await owner.client<{ddl:string;attributes:Record<string,unknown>}[]>`
  select pg_get_functiondef(oid)as ddl,to_jsonb(p)-'prosrc' as attributes from pg_proc p where oid=${signature}::regprocedure`;return row;};
 const original=await snapshot();
 const exclusive="PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));";
 expect(original.ddl.split(exclusive)).toHaveLength(2);
 const shared=`IF current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='on' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(tid::text));
 ELSE ${exclusive} END IF;`;
 const candidate=original.ddl.replace(exclusive,shared);
 const measurements:unknown[]=[],verified:string[]=[];
 const check=(who=ctx,readOnly=true)=>withTenant(who,async tx=>{
  if(readOnly)await tx.execute(sql`set transaction read only`);
  await assertAiPrincipalTx(tx,who);
  const [row]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);
  return row.allowed;
 });
 const underReader=()=>owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(${b.tenantId}))`;
  return withTenant(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);await tx.execute(sql`set local lock_timeout='250ms'`);
   await assertAiPrincipalTx(tx,ctx);
   const [row]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);
   return row.allowed;
  });
 });
 const observedLocks=()=>owner.client.begin(async observer=>{
  const [row]=await observer`select pg_try_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(${b.tenantId}))as reader,
   pg_try_advisory_xact_lock(hashtext('ai-control'),hashtext(${b.tenantId}))as writer`;return row;
 });
 const matrix=async(phase:string)=>{
  const started=performance.now(),outcomes:boolean[]=[];
  for(const readOnly of [true,false]){
   outcomes.push(await check(ctx,readOnly),await check(other,readOnly));
   await setAiAllowance(ctx,{kind:'company',subjectId:b.companyId,enabled:false,dailyRequests:null,monthlyTokens:null});
   try{outcomes.push(await check(ctx,readOnly),await check(other,readOnly));}
   finally{await setAiAllowance(ctx,{kind:'company',subjectId:b.companyId,enabled:true,dailyRequests:null,monthlyTokens:null});}
   await setAiFeature(ctx,'hr_assistant',false);
   try{outcomes.push(await check(ctx,readOnly),await check(other,readOnly));}
   finally{await setAiFeature(ctx,'hr_assistant',true);}
  }
  expect(outcomes).toEqual([true,true,false,true,false,true,true,true,false,true,false,true]);
  measurements.push({phase,elapsedMs:performance.now()-started,outcomes});return outcomes;
 };
 try{
  // A shared independent reader reproduces the unnecessary exclusive native read bottleneck.
  const baselineError=await underReader().then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(baselineError)).toBe('55P03');
  verified.push('original exclusive read blocked by independent shared reader');
  const expected=await matrix('original');
  await owner.client.unsafe(candidate);
  expect(await underReader()).toBe(true);
  verified.push('candidate read overlaps independent shared reader');
  expect(await matrix('candidate')).toEqual(expected);
  expect((await snapshot()).attributes).toEqual(original.attributes);
  for(const readOnly of [true,false])await withTenant(ctx,async tx=>{
   if(readOnly)await tx.execute(sql`set transaction read only`);
   await assertAiPrincipalTx(tx,ctx);
   const [row]=await tx.execute<{allowed:boolean}>(sql`select app.ai_action_unpaused('hr_assistant',false)as allowed`);
   expect(row.allowed).toBe(true);expect(await observedLocks()).toEqual({reader:readOnly,writer:false});
  });
  // Real admission is still a read-write, exclusively locked effect; no provider is invoked.
  let runId:string|undefined;
  await withTenant(ctx,async tx=>{
   const [row]=await tx.execute<{allowed:boolean;run_id:string}>(sql`select * from app.ai_admit('hr_assistant','conversation','fixture','never-sent',1)`);
   expect(row.allowed).toBe(true);runId=row.run_id;
   expect(await observedLocks()).toEqual({reader:false,writer:false});
  });
  expect(runId).toBeTruthy();
  await withTenant(ctx,tx=>tx.execute(sql`select app.ai_settle(${runId}::uuid,false,null)`));
  verified.push('actual admission remains exclusive; failed settlement completed without provider');
  const noUpgrade=await withTenant(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);await assertAiPrincipalTx(tx,ctx);
   await tx.execute(sql`select app.ai_action_unpaused('hr_assistant',false)`);
   await tx.execute(sql`set transaction read write`);
  }).then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(noUpgrade)).toBe('25001');
  verified.push('native read-only carrier cannot upgrade to read-write');
  // A policy writer in another transaction still excludes this read-only path.
  await owner.client.begin(async writer=>{
   await writer`select pg_advisory_xact_lock(hashtext('ai-control'),hashtext(${b.tenantId}))`;
   const blocked=await withTenant(ctx,async tx=>{
    await tx.execute(sql`set transaction read only`);await tx.execute(sql`set local lock_timeout='250ms'`);
    await assertAiPrincipalTx(tx,ctx);await tx.execute(sql`select app.ai_action_unpaused('hr_assistant',false)`);
   }).then(()=>null,(error:unknown)=>error);
   expect(pgSqlState(blocked)).toBe('55P03');
  });
  verified.push('independent exclusive policy lock still blocks candidate read');
  // Each fresh read must still refuse archived or foreign identities.
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,b.adminUserId));
  try{await expect(check()).rejects.toThrow('Current AI calling authority');}
  finally{await owner.db.update(s.appUser).set({archivedAt:null}).where(eq(s.appUser.id,b.adminUserId));}
  await expect(check({...ctx,tenantId:foreign.tenantId})).rejects.toThrow('Current AI calling authority');
  verified.push('archived and foreign actor contexts refused');
  await owner.client.unsafe(original.ddl);
  expect(await matrix('restored')).toEqual(expected);
  const restoredError=await underReader().then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(restoredError)).toBe('55P03');
  verified.push('restored original reproduces the exclusive read bottleneck');
 }finally{
  await owner.client.unsafe(original.ddl);
  expect(await snapshot()).toEqual(original);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-navigation-read-lock-plan.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_AI_READ_LOCK_COMPONENT_ONLY',measurements,verified,originalRestored:true,providerCalls:0},null,2));
 }
},180000);
