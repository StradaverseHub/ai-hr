/** Authored UNRUN. Real native account/employment consent owners and shared custody; no mail or
 * provider network. The server identity reader alone is mocked with an actual bound fixture identity. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const provider=vi.hoisted(()=>({current:vi.fn()}));
vi.mock('../lib/identity/provider',()=>({currentProviderSession:provider.current}));
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {saveLetterEmailPreferences} from '../core/letter-email-preferences';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences,readNotificationEmailPreferences} from '../core/notification-email';
import {resolveOwnNotificationServerIdentity} from '../core/assistant-actions/own-notification-preferences-source';
import {prepareModuleActionReview,confirmModuleActionReview,reopenModuleActionReview,listModuleActionReviews} from '../core/assistant-actions/module-action-review-store';
import {notificationEmailCategory,notificationPreferenceCategory,notificationPreferenceCategories,employmentNotificationPreferenceCategories} from '../lib/notification-email-model';
import {OwnNotificationPreferencesIntent,OwnNotificationPreferencesReview,OwnNotificationPreferencesReceipt} from '../lib/assistant-actions/own-notification-preferences-contract';
import {MODULE_NOTIFICATION_ACTION,ModuleActionPrepare,ModuleActionCompletedReceipt} from '../lib/assistant-actions/module-action-review-contract';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const intent=()=>({version:1 as const,employmentId:randomUUID(),enabledCategories:['leave'],locale:'en' as const,consent:'selected_categories_only' as const});
const review=()=>({version:1,kind:'own_notification_preferences',employmentId:randomUUID(),before:employmentNotificationPreferenceCategories.map(category=>({category,enabled:false,locale:null})),after:{enabledCategories:['leave'],locale:'en'},reviewDigest:'a'.repeat(64)});
describe('Letters remains a native account category outside the closed employment Assistant action',()=>{
 it('retains Letters in native dispatch/policy vocabulary while the employment subset is exactly global minus Letters',()=>{
  expect(notificationEmailCategory.safeParse('letters').success).toBe(true);expect(notificationPreferenceCategory.safeParse('letters').success).toBe(true);
  expect(employmentNotificationPreferenceCategories).toEqual(notificationPreferenceCategories.filter(category=>category!=='letters'));
  expect(new Set(employmentNotificationPreferenceCategories).size).toBe(employmentNotificationPreferenceCategories.length);
 });
 it('refuses Letters alone or mixed with employment consent at the actual human prepare schema',()=>{
  for(const enabledCategories of [['letters'],['leave','letters']]){
   expect(OwnNotificationPreferencesIntent.safeParse({...intent(),enabledCategories}).success).toBe(false);
   expect(ModuleActionPrepare.safeParse({action:MODULE_NOTIFICATION_ACTION,contractVersion:1,intent:{...intent(),enabledCategories}}).success).toBe(false);
  }
 });
 it('refuses a Letters category in either literal before-state or selected after-state review',()=>{
  const original=review();expect(OwnNotificationPreferencesReview.safeParse(original).success).toBe(true);
  expect(OwnNotificationPreferencesReview.safeParse({...original,before:[...original.before,{category:'letters',enabled:true,locale:'en'}]}).success).toBe(false);
  expect(OwnNotificationPreferencesReview.safeParse({...original,after:{...original.after,enabledCategories:['leave','letters']}}).success).toBe(false);
 });
 it('refuses Letters in both private native receipt and public shared completed receipt',()=>{
  const base={employmentId:randomUUID(),enabledCategories:['leave'],locale:'en'},native={version:1,kind:'own_notification_preferences',...base,eventId:randomUUID(),resultDigest:'a'.repeat(64)},completed={action:MODULE_NOTIFICATION_ACTION,contractVersion:1,actionId:randomUUID(),state:'completed',...base,sourceEventId:randomUUID(),semantics:'recorded_effect_current_values'};
  expect(OwnNotificationPreferencesReceipt.safeParse(native).success).toBe(true);expect(ModuleActionCompletedReceipt.safeParse(completed).success).toBe(true);
  expect(OwnNotificationPreferencesReceipt.safeParse({...native,enabledCategories:['letters']}).success).toBe(false);
  expect(ModuleActionCompletedReceipt.safeParse({...completed,enabledCategories:['letters']}).success).toBe(false);
 });
});
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-letters-employment-boundary-key-123456');await resetDb();base=await seedBase();for(const code of ['assistant','notifications'])await setModule(base.tenantId,code,'active');provider.current.mockReset();});
async function fixture(){
 const email=randomUUID()+'@example.test',hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Distinct Consent Owner',primaryEmail:email},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}),userId=await createAppUser(base.tenantId,hired.personId,'employee');
 const identity={issuer:'https://fictional.test/identity',subject:randomUUID(),email,emailVerified:true};await owner.db.insert(schema.appExternalIdentity).values({issuer:identity.issuer,subject:identity.subject,appUserId:userId});await grantAssistant(adminCtx(base),{appUserId:userId});await saveNotificationEmailPolicy(adminCtx(base),['letters','leave','claims']);
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(base.tenantId)};provider.current.mockResolvedValue(identity);
 // Establish account consent through its real native owner, never an owner-inserted preference substitute.
 await saveLetterEmailPreferences(ctx,{enabled:true,locale:'ms'},identity);
 return {ctx,identity,intent:{...intent(),employmentId:hired.employmentId}};
}
async function letterState(a:Awaited<ReturnType<typeof fixture>>){return {preferences:await owner.db.select().from(schema.notificationPref).where(and(eq(schema.notificationPref.tenantId,base.tenantId),eq(schema.notificationPref.recipientUserId,a.ctx.userId!),eq(schema.notificationPref.category,'letters'))).orderBy(schema.notificationPref.id),events:await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,'notification-email.letter-consent-changed'))).orderBy(schema.domainEvent.id)};}
async function nativeEmploymentState(a:Awaited<ReturnType<typeof fixture>>){return owner.db.select().from(schema.notificationPref).where(and(eq(schema.notificationPref.tenantId,base.tenantId),eq(schema.notificationPref.recipientEmploymentId,a.intent.employmentId),eq(schema.notificationPref.channel,'email'))).orderBy(schema.notificationPref.category);}
describe('real native employment completion remains separate from recipient-user Letters consent',()=>{
 it('prepares, recovers, completes and repeatedly reopens exact employment-only custody without mutating Letters',async()=>{
  const a=await fixture(),letters=await letterState(a);expect(letters.preferences).toHaveLength(1);expect(letters.preferences[0]).toMatchObject({enabled:true,recipientEmploymentId:null,emailLocale:'ms'});expect(letters.events).toHaveLength(1);
  const prepared=await prepareModuleActionReview(a.ctx,{action:MODULE_NOTIFICATION_ACTION,contractVersion:1,intent:a.intent},await resolveOwnNotificationServerIdentity()),r=prepared.review;
  expect(r.review.before.map(row=>row.category)).toEqual(employmentNotificationPreferenceCategories);expect(r.review.after.enabledCategories).toEqual(['leave']);
  expect((await listModuleActionReviews(a.ctx)).reviews.map(row=>row.actionId)).toContain(r.actionId);
  expect(await reopenModuleActionReview(a.ctx,r.actionId,await resolveOwnNotificationServerIdentity())).toEqual(prepared);
  const confirmation={action:r.action,contractVersion:r.contractVersion,actionId:r.actionId,reviewedDigest:r.reviewedDigest},completed=await confirmModuleActionReview(a.ctx,confirmation,await resolveOwnNotificationServerIdentity());
  expect(completed.kind).toBe('completed');if(completed.kind!=='completed')throw Error('Expected native completed receipt');expect(completed.receipt.enabledCategories).toEqual(['leave']);
  const persisted=await nativeEmploymentState(a);expect(persisted.map(row=>row.category).sort()).toEqual([...employmentNotificationPreferenceCategories].sort());expect(persisted.find(row=>row.category==='leave')).toMatchObject({enabled:true,emailLocale:'en',emailConsentUserId:a.ctx.userId});
  const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,completed.receipt.sourceEventId));expect(event).toMatchObject({actorType:'user',actorId:a.ctx.userId,eventType:'notification-email.consent-changed',subjectEmploymentId:a.intent.employmentId,payload:{enabledCategories:['leave'],locale:'en'}});
  for(let n=0;n<2;n++)expect(await reopenModuleActionReview(a.ctx,r.actionId,await resolveOwnNotificationServerIdentity())).toEqual(completed);
  expect(await confirmModuleActionReview(a.ctx,confirmation,await resolveOwnNotificationServerIdentity())).toEqual(completed);expect(await nativeEmploymentState(a)).toEqual(persisted);expect(await letterState(a)).toEqual(letters);
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,'notification-email.consent-changed'),eq(schema.domainEvent.subjectEmploymentId,a.intent.employmentId)));expect(events.map(row=>row.id)).toEqual([completed.receipt.sourceEventId]);
  expect((await readNotificationEmailPreferences(a.ctx)).preferences.every(row=>row.recipientEmploymentId!==null&&row.category!=='letters')).toBe(true);
 });
 it('native employment owner refuses Letters without changing account consent or writing employment preferences',async()=>{
  const a=await fixture(),letters=await letterState(a);await expect(saveNotificationEmailPreferences(a.ctx,a.intent.employmentId,['leave','letters'],'en',a.identity)).rejects.toThrow('workflow-email:invalid');expect(await nativeEmploymentState(a)).toEqual([]);expect(await letterState(a)).toEqual(letters);
 });
 it('explicit withdrawal of every employment category leaves native account Letters consent intact',async()=>{
  const a=await fixture(),letters=await letterState(a);await saveNotificationEmailPreferences(a.ctx,a.intent.employmentId,['leave'],'en',a.identity);await saveNotificationEmailPreferences(a.ctx,a.intent.employmentId,[],'th',null);
  const rows=await nativeEmploymentState(a);expect(rows).toHaveLength(employmentNotificationPreferenceCategories.length);expect(rows.every(row=>!row.enabled&&row.emailConsentUserId===null&&row.emailAfterSequence===null&&row.emailLocale==='th')).toBe(true);expect(await letterState(a)).toEqual(letters);
 });
});
