/** Actual current-principal controls, authored UNRUN; no provider/network execution. */
import { eq,sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { assertAiPrincipalTx } from '../core/ai-principal';
import {pgSqlState} from '../lib/db-error';
import { resolveActiveAiConfig } from '../core/ai-config';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('OPENAI_API_KEY','fixture-only');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');await resetDb();b=await seedBase();});afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});
describe('current AI calling principal prerequisite',()=>{
 it('accepts its actual transaction carrier, refuses mismatched tenant/user/grant carriers, and does not mutate context',async()=>{
  const ctx=adminCtx(b),before=JSON.stringify(ctx);await withTenant(ctx,tx=>assertAiPrincipalTx(tx,ctx));
  const other=await seedBase();await expect(withTenant(ctx,tx=>assertAiPrincipalTx(tx,adminCtx(other)))).rejects.toThrow('Current AI calling authority');
  await expect(withTenant(ctx,tx=>assertAiPrincipalTx(tx,{...ctx,userId:other.adminUserId}))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>assertAiPrincipalTx(tx,{...ctx,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]}))).rejects.toThrow();
  expect(JSON.stringify(ctx)).toBe(before);
 });
 it('refuses a retained role snapshot after canonical revocation',async()=>{
  const ctx=adminCtx(b);await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
  await expect(withTenant(ctx,tx=>assertAiPrincipalTx(tx,ctx))).rejects.toThrow();
 });
 it('refuses an archived calling login without substituting a more privileged principal',async()=>{
  const ctx=adminCtx(b);await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,b.adminUserId));
  await expect(withTenant(ctx,tx=>assertAiPrincipalTx(tx,ctx))).rejects.toThrow();
 });
 it('refuses an old no-person binding after the login is relinked',async()=>{
  const ctx=adminCtx(b),[person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Relinked Principal',primaryEmail:'fictional-relinked@fixture.test'}).returning({id:schema.person.id});
  await owner.db.update(schema.appUser).set({personId:person.id}).where(eq(schema.appUser.id,b.adminUserId));
  await expect(withTenant(ctx,tx=>assertAiPrincipalTx(tx,ctx))).rejects.toThrow();
 });
 it.each([false,true])('uses the native transaction access mode for the revocation barrier (readOnly=%s)',async readOnly=>{
  const ctx=adminCtx(b),key='access-configuration:'+b.tenantId;
  await withTenant(ctx,async tx=>{
   if(readOnly)await tx.execute(sql`set transaction read only`);
   await assertAiPrincipalTx(tx,ctx);
   const observed=await owner.client.begin(async observer=>{
    const [row]=await observer`select pg_try_advisory_xact_lock_shared(hashtextextended(${key},0))as reader,
     pg_try_advisory_xact_lock(hashtextextended(${key},0))as writer`;
    return row;
   });
   expect(observed).toEqual({reader:readOnly,writer:false});
  });
 });
 it('lets a real read-only principal overlap an independently held reader',async()=>{
  const ctx=adminCtx(b),key='access-configuration:'+b.tenantId;
  await owner.client.begin(async holder=>{
   await holder`select pg_advisory_xact_lock_shared(hashtextextended(${key},0))`;
   await withTenant(ctx,async tx=>{
    await tx.execute(sql`set transaction read only`);await tx.execute(sql`set local lock_timeout='1000ms'`);
    await assertAiPrincipalTx(tx,ctx);
   });
  });
 });
 it('keeps the native read-only carrier from being upgraded into an effect transaction',async()=>{
  const ctx=adminCtx(b);
  const error=await withTenant(ctx,async tx=>{
   await tx.execute(sql`set transaction read only`);await assertAiPrincipalTx(tx,ctx);
   await tx.execute(sql`set transaction read write`);
  }).then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(error)).toBe('25001');
 });
 it.each(['revoked','archived','relinked'] as const)('refuses a %s principal through the shared read-only path',async mode=>{
  const ctx=adminCtx(b);
  if(mode==='revoked')await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
  else if(mode==='archived')await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,b.adminUserId));
  else{
   const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional readonly relink',primaryEmail:'readonly-relink@example.invalid'}).returning({id:schema.person.id});
   await owner.db.update(schema.appUser).set({personId:person.id}).where(eq(schema.appUser.id,b.adminUserId));
  }
  await expect(withTenant(ctx,async tx=>{await tx.execute(sql`set transaction read only`);await assertAiPrincipalTx(tx,ctx);})).rejects.toThrow('Current AI calling authority');
 });
 it('rechecks the frozen governance binding at actual admission, before a supplied provider callback can run',async()=>{
  const ctx=adminCtx(b),cfg=(await withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx,'hr_assistant')))!;
  expect(Object.isFrozen(cfg)).toBe(true);expect(Object.isFrozen(cfg.governance)).toBe(true);
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
  let invoked=false;
  await expect(cfg.governance!.run({operation:'draft',reservedTokens:10},async()=>{invoked=true;return 'must not run';})).rejects.toThrow();
  expect(invoked).toBe(false);
 });
});
