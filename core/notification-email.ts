/** Workflow email configuration. Policy and consent have separate owners and never imply SMTP readiness. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { employment, notificationEmailPolicy, notificationPref, notificationDelivery } from '../db/schema';
import { isAdmin, isGroupAdmin, withEffectiveGrants } from '../lib/authz';
import { notificationEmailCategories, notificationEmailCategory, notificationEmailLocales, type NotificationEmailLocale } from '../lib/notification-email-model';
import { isModuleEnabled } from './entitlements';

export class NotificationEmailSettingsError extends Error {
  constructor(public readonly code: 'forbidden' | 'invalid' | 'identityRequired' | 'notAvailable') { super(`workflow-email:${code}`); }
}
function requireModule(ctx: SessionContext) {
  if (!isModuleEnabled(ctx, 'notifications')) throw new NotificationEmailSettingsError('notAvailable');
}
function requireAdmin(ctx: SessionContext) {
  requireModule(ctx);
  if (!isGroupAdmin(withEffectiveGrants(ctx))) throw new NotificationEmailSettingsError('forbidden');
}
function categories(input: readonly string[]) {
  if (input.length > notificationEmailCategories.length || new Set(input).size !== input.length || input.some(c => !notificationEmailCategory.safeParse(c).success))
    throw new NotificationEmailSettingsError('invalid');
  return new Set(input);
}
export async function readNotificationEmailPolicy(ctx: SessionContext) {
  requireModule(ctx); if (!isAdmin(ctx)) throw new NotificationEmailSettingsError('forbidden');
  return withTenant(ctx, tx => tx.select().from(notificationEmailPolicy).where(eq(notificationEmailPolicy.tenantId, ctx.tenantId)).orderBy(asc(notificationEmailPolicy.category)));
}
export async function saveNotificationEmailPolicy(ctx: SessionContext, enabledCategories: readonly string[]) {
  requireAdmin(ctx); const selected = categories(enabledCategories);
  await withTenant(ctx, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-email-policy:${ctx.tenantId}`},0))`);
    const current = await tx.select().from(notificationEmailPolicy).where(eq(notificationEmailPolicy.tenantId, ctx.tenantId));
    const [watermark] = await tx.execute(sql`select app.notification_email_watermark() as sequence`) as unknown as {sequence:string}[];
    for (const category of notificationEmailCategories) {
      const before = current.find(p => p.category === category), enabled = selected.has(category);
      const afterSequence = enabled && !before?.enabled ? Number(watermark.sequence) : before?.afterSequence ?? 0;
      await tx.insert(notificationEmailPolicy).values({tenantId:ctx.tenantId,category,enabled,afterSequence}).onConflictDoUpdate({
        target:[notificationEmailPolicy.tenantId,notificationEmailPolicy.category], set:{enabled,afterSequence,updatedAt:sql`now()`},
      });
    }
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'notification-email-policy',aggregateId:ctx.tenantId,eventType:'notification-email.policy-changed',actor:actorOf(ctx),payload:{enabledCategories:[...selected]}});
  });
}
export async function readNotificationEmailPreferences(ctx: SessionContext) {
  requireModule(ctx);
  if (!ctx.userId || !ctx.personId) return {employments:[],preferences:[],policy:[]};
  return withTenant(ctx, async tx => ({
    employments: await tx.select({id:employment.id,code:employment.employeeCode}).from(employment)
      .where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId!))).orderBy(asc(employment.employeeCode),asc(employment.id)),
    preferences: await tx.select().from(notificationPref).where(and(eq(notificationPref.tenantId,ctx.tenantId),eq(notificationPref.channel,'email'))).orderBy(asc(notificationPref.recipientEmploymentId),asc(notificationPref.category)),
    policy: await tx.select().from(notificationEmailPolicy).where(eq(notificationEmailPolicy.tenantId,ctx.tenantId)).orderBy(asc(notificationEmailPolicy.category)),
  }));
}
export type EmailConsentIdentity = {issuer:string;subject:string;email:string|null;emailVerified:boolean};
/** The action obtains identity from the verified server session, never from form fields. */
export async function saveNotificationEmailPreferences(ctx:SessionContext, employmentId:string, enabledCategories:readonly string[], locale:NotificationEmailLocale, identity:EmailConsentIdentity|null) {
  requireModule(ctx); const selected=categories(enabledCategories);
  if (!ctx.userId || !ctx.personId) throw new NotificationEmailSettingsError('forbidden');
  if (!notificationEmailLocales.includes(locale)) throw new NotificationEmailSettingsError('invalid');
  await withTenant(ctx,async tx=>{
    const [own]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,employmentId),eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId!))).limit(1);
    if (!own) throw new NotificationEmailSettingsError('forbidden');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-email-consent:${ctx.tenantId}:${employmentId}`},0))`);
    const current=await tx.select().from(notificationPref).where(and(eq(notificationPref.recipientEmploymentId,employmentId),eq(notificationPref.channel,'email')));
    const addingConsent=[...selected].some(category=>!current.some(p=>p.category===category&&p.enabled&&p.emailConsentUserId===ctx.userId&&p.emailAfterSequence!=null));
    if (addingConsent) {
      if (!identity?.emailVerified || !identity.email) throw new NotificationEmailSettingsError('identityRequired');
      const [allowed]=await tx.execute(sql`select app.notification_email_consent_identity(${identity.issuer},${identity.subject},${employmentId}::uuid,${identity.email}) as allowed`) as unknown as {allowed:boolean}[];
      if (!allowed?.allowed) throw new NotificationEmailSettingsError('identityRequired');
    }
    const [watermark]=await tx.execute(sql`select app.notification_email_watermark() as sequence`) as unknown as {sequence:string}[];
    for (const category of notificationEmailCategories) {
      const before=current.find(p=>p.category===category), enabled=selected.has(category);
      const value={enabled,emailConsentUserId:enabled?ctx.userId:null,emailLocale:locale,
        emailAfterSequence:enabled ? before?.enabled && before.emailConsentUserId===ctx.userId && before.emailAfterSequence!=null ? before.emailAfterSequence : Number(watermark.sequence) : null};
      await tx.insert(notificationPref).values({tenantId:ctx.tenantId,recipientEmploymentId:employmentId,category,channel:'email',...value}).onConflictDoUpdate({
        target:[notificationPref.tenantId,notificationPref.recipientEmploymentId,notificationPref.category,notificationPref.channel],set:{...value,updatedAt:sql`now()`},
      });
    }
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:employmentId,eventType:'notification-email.consent-changed',subjectEmploymentId:employmentId,actor:actorOf(ctx),payload:{enabledCategories:[...selected],locale}});
  });
}
export async function readNotificationEmailDeliveries(ctx:SessionContext) {
  requireModule(ctx); if (!isAdmin(ctx)) throw new NotificationEmailSettingsError('forbidden');
  // No addresses, employee names, frozen notification text or raw relay responses in this log.
  return withTenant(ctx,tx=>tx.select({id:notificationDelivery.id,category:notificationDelivery.category,status:notificationDelivery.status,attempts:notificationDelivery.attempts,error:notificationDelivery.lastError,createdAt:notificationDelivery.createdAt,sentAt:notificationDelivery.sentAt})
    .from(notificationDelivery).where(and(eq(notificationDelivery.tenantId,ctx.tenantId),eq(notificationDelivery.channel,'email')))
    .orderBy(sql`${notificationDelivery.createdAt} desc`,sql`${notificationDelivery.id} desc`).limit(50));
}
export async function retryNotificationEmail(ctx:SessionContext,id:string,acknowledged:boolean) {
  requireAdmin(ctx);
  if (!acknowledged || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotificationEmailSettingsError('invalid');
  await withTenant(ctx,async tx=>{
    const rows=await tx.update(notificationDelivery).set({status:'pending',lastError:null,attempts:0,startedAt:null,leaseToken:null,leaseUntil:null,nextAttemptAt:sql`now()`,updatedAt:sql`now()`})
      .where(and(eq(notificationDelivery.id,id),eq(notificationDelivery.tenantId,ctx.tenantId),eq(notificationDelivery.channel,'email'),eq(notificationDelivery.status,'failed'))).returning({id:notificationDelivery.id});
    if (!rows.length) throw new NotificationEmailSettingsError('invalid');
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'notification-delivery',aggregateId:id,eventType:'notification-email.retry-requested',actor:actorOf(ctx),payload:{possibleDuplicateAcknowledged:true}});
  });
}
