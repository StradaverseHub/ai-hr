import { client, withSystemWork } from '../../db/client';
import { lifecycleV9DeliveryRequest } from '../lifecycle-v9-delivery-model';
import type { AutomationDeliveryRequest, AutomationDeliveryResult, AutomationMailTarget } from '../automation-email-ipc';
import { notificationSmtpFailure } from '../notification-email-model';
import {automationEmailContent,type AutomationStoredFile} from '../automation-email-content';
import { normaliseManagedEmailSender } from '../managed-email-policy';
import { internalConfig, internalIssuer } from './config';
import { admittedAuthSql, readRecord } from './store';
import { assertActiveCredential, InternalAuthError, type Credential } from './service';
import { readLifecycleRelayTx } from './active-relay';
import { sendSmtp, type MailTransport } from './smtp';
import {sharedAutomationEmailContent} from '../shared-automation-email-content';

/**
 * Shared workflow email (migration 5754), sent the way On/Off Boarding V9 mail is (lib/internal-auth/lifecycle-v9-mail.ts):
 * authentication owns credential verification and the tenant's applied workflow relay; the caller supplies only the
 * delivery id and lease. Plain text: the frozen subject and body, with `{{case.link}}` made absolute for this
 * installation. The start marker is committed before any message byte is sent and a lost receipt is never replayed.
 */
export async function internalAutomationMail(input: AutomationDeliveryRequest, transport: MailTransport = sendSmtp): Promise<AutomationDeliveryResult> {
  const { deliveryId: id, leaseToken: token } = lifecycleV9DeliveryRequest.parse(input), origin = internalConfig().origin;
  const target = (await withSystemWork(()=>client`select app.automation_email_target(${id}::uuid,${token}::uuid,${origin}) as target`))[0]?.target as AutomationMailTarget | null;
  if (!target) return { outcome: 'skipped', error: 'notEligible' };
  const { mail } = target.payload;
  if (!normaliseManagedEmailSender(mail.delivery?.sender) || mail.delivery?.version !== 1 || mail.to.length < 1 || mail.to.length > 8) return { outcome: 'skipped', error: 'notEligible' };
  const active = await readLifecycleRelayTx(admittedAuthSql, target.tenantId);
  if (!active) return { outcome: 'skipped', error: 'relayUnavailable' };
  const byRecipient = new Map<string, string>();
  for (const binding of target.bindings) {
    const credential = await readRecord<Credential>(admittedAuthSql, `credential:${binding.subject}`);
    if (!credential || credential.subject !== binding.subject || credential.tenantId !== target.tenantId || credential.issuer !== internalIssuer(target.tenantId) || credential.issuer !== binding.issuer)
      return { outcome: 'skipped', error: 'recipientChanged' };
    try {
      const principal = await assertActiveCredential(admittedAuthSql, credential);
      if (principal.app_user_id !== binding.userId) return { outcome: 'skipped', error: 'recipientChanged' };
    } catch (error) {
      if (error instanceof InternalAuthError) return { outcome: 'skipped', error: 'recipientChanged' };
      throw error;
    }
    byRecipient.set(binding.userId, credential.email);
  }
  const addresses = [...mail.to, ...mail.cc].map(userId => byRecipient.get(userId));
  if (addresses.some(address => !address)) return { outcome: 'skipped', error: 'recipientUnavailable' };
  // One copy per address; To wins over CC.
  const seen = new Set<string>(), unique = (list: (string | undefined)[]) => list.filter((address): address is string => { const key = address!.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  const toAddresses = unique(addresses.slice(0, mail.to.length)), ccAddresses = unique(addresses.slice(mail.to.length));
  let content: Awaited<ReturnType<typeof automationEmailContent>>;
  try {
    // Every file/link is materialized privately from the frozen native delivery capability.
    // Offboarding keeps its existing document/attachment owner and renderer.
    content=target.module==='off'?await automationEmailContent(target,origin,{
      files:async()=>await withSystemWork(()=>client`select * from app.resignation_email_files(${id}::uuid,${token}::uuid,${origin})`) as unknown as AutomationStoredFile[],
      assets:async()=>await withSystemWork(()=>client`select * from app.resignation_email_assets(${id}::uuid,${token}::uuid,${origin})`) as unknown as AutomationStoredFile[],
    }):await sharedAutomationEmailContent(target,origin,{
      assets:async()=>await withSystemWork(()=>client`select * from app.automation_email_assets(${id}::uuid,${token}::uuid,${origin})`),
      documents:async()=>(await withSystemWork(()=>client`select app.automation_email_documents(${id}::uuid,${token}::uuid,${origin}) as allowed`))[0]?.allowed,
    });
  } catch { return { outcome: 'skipped', error: 'notEligible' }; }
  const currentRelay = await readLifecycleRelayTx(admittedAuthSql, target.tenantId);
  if (!currentRelay || currentRelay.revision !== active.revision || currentRelay.senderName !== active.senderName) return { outcome: 'skipped', error: 'relayUnavailable' };
  const hasSharedReferences=target.module!=='off'&&Boolean(mail.delivery.assets?.length||mail.delivery.documents?.length);
  const sharedMaterialization=hasSharedReferences?(await withSystemWork(()=>client`select app.automation_email_materialization(${id}::uuid,${token}::uuid,${origin}) as proof`))[0]?.proof:null;
  if(hasSharedReferences&&!sharedMaterialization)return {outcome:'skipped',error:'notEligible'};
  const proof = { ...(hasSharedReferences?{sharedMaterialization}:{}),bindings: target.bindings, addresses, relayRevision: active.revision, senderProfile: 'noreply', senderName: active.senderName ?? active.relay.config.fromName, senderAddress: active.relay.config.from };
  const started = (await withSystemWork(()=>client`select app.automation_email_start(${id}::uuid,${token}::uuid,${origin},${JSON.stringify(proof)}::jsonb) as started`))[0]?.started === true;
  if (!started) return { outcome: 'skipped', error: 'notEligible' };
  let result: AutomationDeliveryResult;
  try {
    await transport(active.relay, { to: toAddresses.length === 1 ? toAddresses[0] : toAddresses, cc: ccAddresses, subject: mail.subject, ...content, ...(active.senderName ? { senderName: active.senderName } : {}), messageId: `<automation.${id}@${new URL(origin).hostname}>` });
    result = { outcome: 'sent', error: null };
  } catch (error) { result = notificationSmtpFailure(error); }
  const finished = (await withSystemWork(()=>client`select app.automation_email_finish(${id}::uuid,${token}::uuid,${result.outcome},${result.error}) as finished`))[0]?.finished === true;
  if (!finished) return { outcome: 'uncertain', error: 'uncertain' };
  return result;
}
