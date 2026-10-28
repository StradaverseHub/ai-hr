import { createHash } from 'node:crypto';
/** Workflow email configuration. Policy and consent have separate owners and never imply SMTP readiness. */
import { and, asc, eq, getTableColumns, isNotNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Grant, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { company, employment, notificationEmailPolicy, notificationPref, notificationDelivery } from '../db/schema';
import { isAdmin, isGroupAdmin, withEffectiveGrants } from '../lib/authz-model';
import { notificationPreferenceCategories, notificationPreferenceCategory, notificationEmailLocales, type NotificationEmailLocale } from '../lib/notification-email-model';
import { isModuleEnabled, resolveEntitlementsTx } from './entitlements';
import { allowedCompanies } from './read';
import type { MasterRecipient, MasterRecipientIdentity } from './employee-master-recipient-types';
export type { MasterRecipient, MasterRecipientIdentity, MasterConsentRevision } from './employee-master-recipient-types';

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
  if (input.length > notificationPreferenceCategories.length || new Set(input).size !== input.length || input.some(c => !notificationPreferenceCategory.safeParse(c).success))
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
    for (const category of notificationPreferenceCategories) {
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
    preferences: await tx.select().from(notificationPref).where(and(eq(notificationPref.tenantId,ctx.tenantId),eq(notificationPref.channel,'email'),isNotNull(notificationPref.recipientEmploymentId))).orderBy(asc(notificationPref.recipientEmploymentId),asc(notificationPref.category)),
    policy: await tx.select().from(notificationEmailPolicy).where(eq(notificationEmailPolicy.tenantId,ctx.tenantId)).orderBy(asc(notificationEmailPolicy.category)),
  }));
}
/** Canonical salary-free own-subject choices for the reviewed preferences flow. The caller must
 * prove the fresh current login/Assistant/module before invoking this supplied-Tx reader. */
export async function readOwnNotificationEmailChoiceSubjectsTx(tx:Tx,ctx:SessionContext){
 requireModule(ctx);if(!ctx.userId||!ctx.personId)return [];
 return tx.select({employmentId:employment.id,employeeCode:employment.employeeCode,companyName:company.legalName})
  .from(employment).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,ctx.tenantId)))
  .where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId))).orderBy(asc(employment.employeeCode),asc(employment.id)).limit(17);
}
export type EmailConsentIdentity = {issuer:string;subject:string;email:string|null;emailVerified:boolean};
/** The action obtains identity from the verified server session, never from form fields. */
export async function saveNotificationEmailPreferences(ctx:SessionContext, employmentId:string, enabledCategories:readonly string[], locale:NotificationEmailLocale, identity:EmailConsentIdentity|null):Promise<void> {
  const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))}, selected=[...enabledCategories], proof=identity?{...identity}:null;
  await withTenant(captured,tx=>saveNotificationEmailPreferencesTx(tx,captured,employmentId,selected,locale,proof));
}
/** Same canonical consent owner, joined to an enclosing human command. The exact event is not proof
 * of commit; an enclosing custody owner must commit its completion receipt in this transaction. */
export async function saveNotificationEmailPreferencesTx(tx:Tx,ctx:SessionContext, employmentId:string, enabledCategories:readonly string[], locale:NotificationEmailLocale, identity:EmailConsentIdentity|null):Promise<{employmentId:string;eventId:string}> {
  ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};enabledCategories=[...enabledCategories];identity=identity?{...identity}:null;
  requireModule(ctx); const selected=categories(enabledCategories);if(selected.has('letters'))throw new NotificationEmailSettingsError('invalid');
  if (!ctx.userId || !ctx.personId) throw new NotificationEmailSettingsError('forbidden');
  if (!notificationEmailLocales.includes(locale)) throw new NotificationEmailSettingsError('invalid');
  const [own]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,employmentId),eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId!))).limit(1);
    if (!own) throw new NotificationEmailSettingsError('forbidden');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-email-consent:${ctx.tenantId}:${employmentId}`},0))`);
    const current=await tx.select().from(notificationPref).where(and(eq(notificationPref.recipientEmploymentId,employmentId),eq(notificationPref.channel,'email')));
    const reportBefore=current.find(p=>p.category==='employee_master_reports');
    const addressHash=identity?.email?createHash('sha256').update(identity.email.toLowerCase()).digest('hex'):null;
    const reportBindingCurrent=!!reportBefore?.enabled&&reportBefore.emailConsentUserId===ctx.userId&&reportBefore.emailAfterSequence!=null&&!!reportBefore.reportConsentVerifiedAt&&reportBefore.reportConsentIssuer===identity?.issuer&&reportBefore.reportConsentSubject===identity?.subject&&reportBefore.reportConsentAddressHash===addressHash;
    // Existing workflow consent is unchanged. A report address/binding change requires fresh proof.
    const addingConsent=[...selected].some(category=>category==='employee_master_reports'?!reportBindingCurrent:!current.some(p=>p.category===category&&p.enabled&&p.emailConsentUserId===ctx.userId&&p.emailAfterSequence!=null));
    if (addingConsent) {
      if (!identity?.emailVerified || !identity.email) throw new NotificationEmailSettingsError('identityRequired');
      const [allowed]=await tx.execute(sql`select app.notification_email_consent_identity(${identity.issuer},${identity.subject},${employmentId}::uuid,${identity.email}) as allowed`) as unknown as {allowed:boolean}[];
      if (!allowed?.allowed) throw new NotificationEmailSettingsError('identityRequired');
    }
    const [watermark]=await tx.execute(sql`select app.notification_email_watermark() as sequence`) as unknown as {sequence:string}[];
    for (const category of notificationPreferenceCategories.filter(category=>category!=='letters')) {
      const before=current.find(p=>p.category===category), enabled=selected.has(category);
      const value={enabled,emailConsentUserId:enabled?ctx.userId:null,emailLocale:locale,
        emailAfterSequence:enabled ? before?.enabled && before.emailConsentUserId===ctx.userId && before.emailAfterSequence!=null && (category!=='employee_master_reports'||reportBindingCurrent) ? before.emailAfterSequence : Number(watermark.sequence) : null,
        ...(category==='employee_master_reports'?{
          reportConsentIssuer:enabled?identity!.issuer:null,reportConsentSubject:enabled?identity!.subject:null,
          reportConsentAddressHash:enabled?addressHash:null,
          reportConsentVerifiedAt:enabled?(reportBindingCurrent?before!.reportConsentVerifiedAt:new Date()):null,
        }:{}),};
      await tx.insert(notificationPref).values({tenantId:ctx.tenantId,recipientEmploymentId:employmentId,category,channel:'email',...value}).onConflictDoUpdate({
        target:[notificationPref.tenantId,notificationPref.recipientEmploymentId,notificationPref.category,notificationPref.channel],set:{...value,updatedAt:sql`now()`},
      });
    }
    const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:employmentId,eventType:'notification-email.consent-changed',subjectEmploymentId:employmentId,actor:actorOf(ctx),payload:{enabledCategories:[...selected],locale}},{returnId:true});
    return {employmentId,eventId};
}
/** Private canonical source snapshot for a supplied-Tx review. Locks only this owner's existing
 * policy/consent keys; any busy acquisition requires whole-Tx rollback. Caller already owns Access
 * before employment reads (the workforce statement trigger joins that same canonical interval).
 * Caller owns fresh login/module/Assistant authority; these rows must never become model context. */
export async function readOwnNotificationEmailPreferenceSourceTx(tx:Tx,ctx:SessionContext,employmentId:string){
  requireModule(ctx);if(!ctx.userId||!ctx.personId)throw new NotificationEmailSettingsError('forbidden');
  const [policyLock]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${'workflow-email-policy:'+ctx.tenantId},0)) as owned`);
  if(policyLock?.owned!==true)throw new NotificationEmailSettingsError('notAvailable');
  const [consentLock]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'workflow-email-consent:'+ctx.tenantId+':'+employmentId},0)) as owned`);
  if(consentLock?.owned!==true)throw new NotificationEmailSettingsError('notAvailable');
  const [own]=await tx.select({id:employment.id,personId:employment.personId,companyId:employment.companyId,version:sql<string>`xmin::text`}).from(employment)
    .where(and(eq(employment.id,employmentId),eq(employment.tenantId,ctx.tenantId),eq(employment.personId,ctx.personId))).limit(1);
  if(!own)throw new NotificationEmailSettingsError('forbidden');
  const preferences=await tx.select({...getTableColumns(notificationPref),version:sql<string>`xmin::text`}).from(notificationPref)
    .where(and(eq(notificationPref.tenantId,ctx.tenantId),eq(notificationPref.recipientEmploymentId,employmentId),eq(notificationPref.channel,'email'))).orderBy(asc(notificationPref.category));
  const policy=await tx.select({...getTableColumns(notificationEmailPolicy),version:sql<string>`xmin::text`}).from(notificationEmailPolicy)
    .where(eq(notificationEmailPolicy.tenantId,ctx.tenantId)).orderBy(asc(notificationEmailPolicy.category));
  return {own,preferences,policy};
}
export async function readNotificationEmailDeliveries(ctx:SessionContext) {
  requireModule(ctx); if (!isAdmin(ctx)) throw new NotificationEmailSettingsError('forbidden');
  // No addresses, employee names, frozen notification text or raw relay responses in this log.
  return withTenant(ctx,tx=>tx.select({id:notificationDelivery.id,recipientCode:sql<string|null>`app.notification_email_recipient_code(${notificationDelivery.id})`,category:notificationDelivery.category,status:notificationDelivery.status,attempts:notificationDelivery.attempts,error:notificationDelivery.lastError,createdAt:notificationDelivery.createdAt,sentAt:notificationDelivery.sentAt})
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

/** Resolves exact opted-in employment/user pairs using live Notifications-owned policy and bindings.
 * A verified opt-in is not a claim of current provider verification: managed SMTP must recheck that.
 * Browser options receive only identity/label; contexts and consent revisions remain server-side.
 */
export async function resolveEmployeeMasterRecipients(ctx:SessionContext, identity?:MasterRecipientIdentity):Promise<MasterRecipient[]> {
  requireModule(ctx);
  if(!ctx.userId)throw new NotificationEmailSettingsError('forbidden');
  if(identity && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.userId)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.employmentId)))throw new NotificationEmailSettingsError('invalid');
  type Candidate={user_id:string;person_id:string;employment_id:string;company_id:string;employee_code:string;full_name:string;company_name:string;consent_after_sequence:string;policy_after_sequence:string;consent_updated_at:string;policy_updated_at:string;consent_verified_at:string};
  const candidates=await withTenant(ctx,async tx=>{
    const [actor]=await tx.execute(sql`select p.tenant_id,p.person_id,p.grants,u.archived_at,app.login_blocked(u.id) as blocked from app.principal(${ctx.userId}::uuid) p join app_user u on u.id=${ctx.userId}::uuid`) as unknown as {tenant_id:string;person_id:string|null;grants:Grant[];archived_at:Date|null;blocked:boolean}[];
    const grantsKey=(grants:readonly Grant[])=>JSON.stringify(grants.map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
    if(!actor||actor.tenant_id!==ctx.tenantId||actor.person_id!==(ctx.personId??null)||grantsKey(actor.grants)!==grantsKey(ctx.grants??[])||JSON.stringify([...new Set(actor.grants.map(grant=>grant.role))].sort())!==JSON.stringify([...new Set(ctx.roles??[])].sort())||actor.archived_at||actor.blocked)throw new NotificationEmailSettingsError('forbidden');
    if(!isModuleEnabled({...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)},'notifications'))throw new NotificationEmailSettingsError('notAvailable');
    return await tx.execute(sql`select r.user_id,r.person_id,r.employment_id,r.company_id,r.employee_code,r.full_name,r.company_name,r.consent_after_sequence,r.policy_after_sequence,
      to_char(r.consent_updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as consent_updated_at,
      to_char(r.policy_updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as policy_updated_at,
      to_char(r.consent_verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as consent_verified_at
      from app.employee_master_report_recipients(${identity?.userId??null}::uuid,${identity?.employmentId??null}::uuid) r`) as unknown as Candidate[];
  });
  if(candidates.length>1000)throw new NotificationEmailSettingsError('notAvailable');
  const recipients:MasterRecipient[]=[],contexts=new Map<string,{context:SessionContext;scopeIds:string[]}>();
  for(const candidate of candidates){
    let resolved=contexts.get(candidate.user_id);
    if(!resolved){
      const principal=await withTenant(ctx,async tx=>{
        const [row]=await tx.execute(sql`select tenant_id,person_id,grants from app.principal(${candidate.user_id}::uuid)`) as unknown as {tenant_id:string;person_id:string|null;grants:Grant[]}[];
        return row;
      });
      if(!principal||principal.tenant_id!==ctx.tenantId||principal.person_id!==candidate.person_id)continue;
      // Build a new recipient context; never copy the sender's roles, exemptions or scope.
      const base:SessionContext={tenantId:principal.tenant_id,userId:candidate.user_id,personId:principal.person_id,grants:principal.grants,roles:[...new Set(principal.grants.map(grant=>grant.role))]};
      const context={...base,entitlements:await withTenant(base,tx=>resolveEntitlementsTx(tx,base.tenantId))};
      if(!isModuleEnabled(context,'notifications'))continue;
      resolved={context,scopeIds:(await allowedCompanies(context)).map(company=>company.id)};contexts.set(candidate.user_id,resolved);
    }
    if(!resolved.scopeIds.includes(candidate.company_id))continue;
    recipients.push({userId:candidate.user_id,employmentId:candidate.employment_id,label:`${candidate.full_name} · ${candidate.employee_code} · ${candidate.company_name}`,...resolved,
      consentAfterSequence:Number(candidate.consent_after_sequence),policyAfterSequence:Number(candidate.policy_after_sequence),consentUpdatedAt:candidate.consent_updated_at,policyUpdatedAt:candidate.policy_updated_at,consentVerifiedAt:candidate.consent_verified_at});
  }
  return recipients;
}
