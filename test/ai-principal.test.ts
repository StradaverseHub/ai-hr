/** Actual current-principal controls, authored UNRUN; no provider/network execution. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { assertAiPrincipalTx } from '../core/ai-principal';
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
  const ctx=adminCtx(b),[person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Relinked Principal'}).returning({id:schema.person.id});
  await owner.db.update(schema.appUser).set({personId:person.id}).where(eq(schema.appUser.id,b.adminUserId));
  await expect(withTenant(ctx,tx=>assertAiPrincipalTx(tx,ctx))).rejects.toThrow();
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
