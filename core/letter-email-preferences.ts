/** Account-addressed Letters consent lives in the existing notification preference owner. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {notificationPref,notificationEmailPolicy} from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {notificationEmailLocales,type NotificationEmailLocale} from '../lib/notification-email-model';
import {NotificationEmailSettingsError,type EmailConsentIdentity} from './notification-email';
import {isModuleEnabled} from './entitlements';
import {allowedCompanies} from './read';
async function requireAccess(ctx:SessionContext){
 if(!ctx.userId)throw new NotificationEmailSettingsError('forbidden');
 if(!isModuleEnabled(ctx,'notifications')&&!(await allowedCompanies(ctx)).some(company=>isModuleEnabled(ctx,'notifications',company.id)))throw new NotificationEmailSettingsError('notAvailable');
}
const own=(ctx:SessionContext)=>and(eq(notificationPref.tenantId,ctx.tenantId),eq(notificationPref.recipientUserId,ctx.userId!),eq(notificationPref.category,'letters'),eq(notificationPref.channel,'email'));
export async function readLetterEmailPreferences(ctx:SessionContext){
 await requireAccess(ctx);return withTenant(ctx,async tx=>{
  const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);if(!principal?.ok)throw new NotificationEmailSettingsError('forbidden');
  const [preference]=await tx.select().from(notificationPref).where(own(ctx)),[policy]=await tx.select({enabled:notificationEmailPolicy.enabled}).from(notificationEmailPolicy).where(and(eq(notificationEmailPolicy.tenantId,ctx.tenantId),eq(notificationEmailPolicy.category,'letters')));
  const [binding]=preference?.enabled?await tx.execute<{ok:boolean}>(sql`select app.letter_email_consent_identity(${preference.emailConsentIssuer},${preference.emailConsentSubject},${preference.emailConsentAddressHash}) as ok`):[];
  return {preference:preference??null,current:binding?.ok===true,enabledByPolicy:policy?.enabled===true};
 });
}
export async function saveLetterEmailPreferences(ctx:SessionContext,input:{enabled:boolean;locale:NotificationEmailLocale},identity:EmailConsentIdentity|null){
 await requireAccess(ctx);if(typeof input.enabled!=='boolean'||!notificationEmailLocales.includes(input.locale))throw new NotificationEmailSettingsError('invalid');
 return withTenant(ctx,async tx=>{
  const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);if(!principal?.ok)throw new NotificationEmailSettingsError('forbidden');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letter-email-consent:'+ctx.tenantId+':'+ctx.userId},0))`);
  const [before]=await tx.select().from(notificationPref).where(own(ctx));
  const proof=identity?.emailVerified&&identity.email&&identity.issuer&&identity.subject?{issuer:identity.issuer,subject:identity.subject,addressHash:createHash('sha256').update(identity.email.toLowerCase()).digest('hex')}:
   before?.enabled&&before.emailConsentUserId===ctx.userId&&before.emailConsentVerifiedAt&&before.emailAfterSequence!==null?{issuer:before.emailConsentIssuer,subject:before.emailConsentSubject,addressHash:before.emailConsentAddressHash}:null;
  if(input.enabled){if(!proof)throw new NotificationEmailSettingsError('identityRequired');const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.letter_email_consent_identity(${proof.issuer},${proof.subject},${proof.addressHash}) as ok`);if(!allowed?.ok)throw new NotificationEmailSettingsError('identityRequired');}
  // The database stamps the exact current cutoff when consent is first enabled or rebound.
  const value={enabled:input.enabled,emailLocale:input.locale,emailConsentIssuer:input.enabled?proof!.issuer:null,emailConsentSubject:input.enabled?proof!.subject:null,emailConsentAddressHash:input.enabled?proof!.addressHash:null};
  await tx.insert(notificationPref).values({tenantId:ctx.tenantId,recipientUserId:ctx.userId!,category:'letters',channel:'email',...value}).onConflictDoUpdate({target:[notificationPref.tenantId,notificationPref.recipientUserId,notificationPref.category,notificationPref.channel],set:{...value,updatedAt:sql`now()`}});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'notification-email-account',aggregateId:ctx.userId!,eventType:'notification-email.letter-consent-changed',actor:actorOf(ctx),payload:{enabled:input.enabled,locale:input.locale}});
 });
}
