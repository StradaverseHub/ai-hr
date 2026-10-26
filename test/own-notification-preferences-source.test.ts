/** Authored UNRUN: actual canonical consent writes/RLS/rollback; provider session is server-only mock. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const provider=vi.hoisted(()=>({current:vi.fn()}));vi.mock('../lib/identity/provider',()=>({currentProviderSession:provider.current}));
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {resolveOwnNotificationServerIdentity,prepareOwnNotificationPreferencesTx,confirmOwnNotificationPreferencesTx,reopenOwnNotificationPreferencesTx} from '../core/assistant-actions/own-notification-preferences-source';
import {OwnNotificationPreferencesIntent} from '../lib/assistant-actions/own-notification-preferences-contract';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'notifications','active');await setModule(base.tenantId,'assistant','active');provider.current.mockReset();});
async function fixture(){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Preference Owner',primaryEmail:'fictional@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,'employee'),identity={issuer:'https://fixture.test/identity',subject:randomUUID(),email:'fictional@example.test',emailVerified:true};
 await owner.db.insert(schema.appExternalIdentity).values({issuer:identity.issuer,subject:identity.subject,appUserId:userId});await grantAssistant(adminCtx(base),{appUserId:userId});await saveNotificationEmailPolicy(adminCtx(base),['leave','claims']);
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(base.tenantId)};provider.current.mockResolvedValue(identity);
 const intent=OwnNotificationPreferencesIntent.parse({version:1,employmentId:hired.employmentId,enabledCategories:['leave'],locale:'en',consent:'selected_categories_only'});
 return {ctx,intent,identity};
}
async function prepare(a:Awaited<ReturnType<typeof fixture>>){const cap=await resolveOwnNotificationServerIdentity();return withTenant(a.ctx,tx=>prepareOwnNotificationPreferencesTx(tx,a.ctx,a.intent,cap));}
async function confirm(a:Awaited<ReturnType<typeof fixture>>,digest:string){const cap=await resolveOwnNotificationServerIdentity();return withTenant(a.ctx,tx=>confirmOwnNotificationPreferencesTx(tx,a.ctx,a.intent,digest,cap));}
async function state(){return {preferences:await owner.db.select().from(schema.notificationPref).orderBy(schema.notificationPref.id),events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'notification-email.consent-changed')).orderBy(schema.domainEvent.id)};}
describe('unmounted own notification consent action source',()=>{
 it('accepts only explicit category/locale consent, never a posted identity, recipient or delivery operation',()=>{
  const input={version:1,employmentId:randomUUID(),enabledCategories:['leave'],locale:'en',consent:'selected_categories_only'};
  for(const field of ['identity','email','recipient','sender','template','retry'])expect(OwnNotificationPreferencesIntent.safeParse({...input,[field]:'posted'}).success).toBe(false);
  expect(OwnNotificationPreferencesIntent.safeParse({...input,enabledCategories:['leave','leave']}).success).toBe(false);expect(OwnNotificationPreferencesIntent.safeParse({...input,consent:false}).success).toBe(false);
 });
 it('writes the exact native event, reconciles without another write, and rejects a second uncustodied confirmation',async()=>{
  const a=await fixture(),review=await prepare(a);expect(review.after).toEqual({enabledCategories:['leave'],locale:'en'});expect(JSON.stringify(review)).not.toContain(a.identity.email);expect(JSON.stringify(review)).not.toContain(a.identity.subject);
  const receipt=await confirm(a,review.reviewDigest),before=await state();expect(before.events).toHaveLength(1);expect(before.events[0].id).toBe(receipt.eventId);
  const cap=await resolveOwnNotificationServerIdentity();expect(await withTenant(a.ctx,tx=>reopenOwnNotificationPreferencesTx(tx,a.ctx,receipt,cap))).toEqual(receipt);expect(await state()).toEqual(before);
  await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('refuses actual preference or policy drift before any consent event',async()=>{
  const a=await fixture(),review=await prepare(a);await saveNotificationEmailPolicy(adminCtx(base),['leave']);const before=await state();await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state()).toEqual(before);
  const again=await prepare(a);await saveNotificationEmailPreferences(a.ctx,a.intent.employmentId,['claims'],'ms',a.identity);const changed=await state();await expect(confirm(a,again.reviewDigest)).rejects.toThrow();expect(await state()).toEqual(changed);
 });
 it('refuses grant revocation and a revoked provider binding before effects',async()=>{
  const a=await fixture(),review=await prepare(a);await revokeAssistant(adminCtx(base),{appUserId:a.ctx.userId!});const before=await state();await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state()).toEqual(before);
  await grantAssistant(adminCtx(base),{appUserId:a.ctx.userId!});const fresh=await prepare(a);await owner.db.delete(schema.appExternalIdentity).where(and(eq(schema.appExternalIdentity.issuer,a.identity.issuer),eq(schema.appExternalIdentity.subject,a.identity.subject)));await expect(confirm(a,fresh.reviewDigest)).rejects.toThrow();expect(await state()).toEqual(before);
 });
 it('requires server identity, refuses changed identity and allows explicitly reviewed withdrawal only',async()=>{
  const a=await fixture(),review=await prepare(a);provider.current.mockResolvedValue({...a.identity,email:'changed@example.test'});await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect((await state()).events).toHaveLength(0);
  provider.current.mockResolvedValue(a.identity);await confirm(a,review.reviewDigest);provider.current.mockResolvedValue(null);a.intent={...a.intent,enabledCategories:[]};const withdrawal=await prepare(a);await confirm(a,withdrawal.reviewDigest);expect((await state()).preferences.every(row=>!row.enabled)).toBe(true);
  const forged={...a.identity};await expect(withTenant(a.ctx,tx=>prepareOwnNotificationPreferencesTx(tx,a.ctx,a.intent,forged as never))).rejects.toThrow();
 });
 it('captures human selection before its first await and never retargets mutated input',async()=>{
  const a=await fixture(),cap=await resolveOwnNotificationServerIdentity(),original=structuredClone(a.intent);
  const review=await withTenant(a.ctx,async tx=>{const pending=prepareOwnNotificationPreferencesTx(tx,a.ctx,a.intent,cap);a.intent.enabledCategories.push('payroll');a.intent.locale='ms';return pending;});expect(review.after).toEqual({enabledCategories:['leave'],locale:'en'});
  await expect(confirm(a,review.reviewDigest)).rejects.toThrow();a.intent=original;await confirm(a,review.reviewDigest);expect((await state()).events).toHaveLength(1);
 });
 it('rolls back native preference/event together when enclosing custody fails, then permits the original retry',async()=>{
  const a=await fixture(),review=await prepare(a),before=await state(),cap=await resolveOwnNotificationServerIdentity();await expect(withTenant(a.ctx,async tx=>{await confirmOwnNotificationPreferencesTx(tx,a.ctx,a.intent,review.reviewDigest,cap);throw Error('fictional custody failure');})).rejects.toThrow('fictional custody failure');expect(await state()).toEqual(before);await confirm(a,review.reviewDigest);expect((await state()).events).toHaveLength(1);
 });
 it('commits one native effect across two actual competing uncustodied confirmations',async()=>{
  const a=await fixture(),review=await prepare(a),outcomes=await Promise.allSettled([confirm(a,review.reviewDigest),confirm(a,review.reviewDigest)]);expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect((await state()).events).toHaveLength(1);
 });
 it('refuses current module revocation and a cross-person subject without leaking preferences',async()=>{
  const a=await fixture(),review=await prepare(a);await setModule(base.tenantId,'notifications','disabled');await expect(confirm(a,review.reviewDigest)).rejects.toThrow();await setModule(base.tenantId,'notifications','active');a.intent={...a.intent,employmentId:randomUUID()};await expect(prepare(a)).rejects.toThrow();expect((await state()).events).toHaveLength(0);
 });
});
