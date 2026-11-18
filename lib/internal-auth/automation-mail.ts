import { client, withSystemWork } from '../../db/client';
import { lifecycleV9DeliveryRequest } from '../lifecycle-v9-delivery-model';
import type { AutomationDeliveryRequest, AutomationDeliveryResult, AutomationMailTarget } from '../automation-email-ipc';
import { notificationEmailLink, notificationSmtpFailure } from '../notification-email-model';
import { normaliseManagedEmailSender } from '../managed-email-policy';
import { managedEmailAttachment,type ManagedEmailAttachment,MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT,MANAGED_EMAIL_ATTACHMENT_MAX_BYTES } from '../managed-email-attachment';
import {sanitiseEmailHtml,resolveDocumentLinks,EMAIL_HTML_MAX_BYTES} from '../email-body/render';
import {v9ImageCid} from '../lifecycle-v9-email-content';
import { internalConfig, internalIssuer } from './config';
import { admittedAuthSql, readRecord } from './store';
import { assertActiveCredential, InternalAuthError, type Credential } from './service';
import { readLifecycleRelayTx } from './active-relay';
import { sendSmtp, type MailTransport } from './smtp';

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
  if (!normaliseManagedEmailSender(mail.delivery?.sender) || ![1,2].includes(mail.delivery?.version) || mail.to.length < 1 || mail.to.length > 8) return { outcome: 'skipped', error: 'notEligible' };
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
  let text: string;
  try { text = mail.body.split('{{case.link}}').join(notificationEmailLink(origin, target.payload.linkPath)); } catch { return { outcome: 'skipped', error: 'notEligible' }; }
  const attachments:ManagedEmailAttachment[]=[];let html:string|undefined;
  if(mail.delivery.version===2){
    try{
      if(typeof mail.delivery.html!=='string')return {outcome:'skipped',error:'notEligible'};
      const documentLinks=new Map((mail.delivery.documents??[]).filter(document=>document.link).map(document=>[document.templateId,notificationEmailLink(origin,document.path)]));
      html=sanitiseEmailHtml(resolveDocumentLinks(mail.delivery.html,text,documentLinks).html.split('&#123;&#123;case.link&#125;&#125;').join(notificationEmailLink(origin,target.payload.linkPath)));
      if(new TextEncoder().encode(html).length>EMAIL_HTML_MAX_BYTES)return {outcome:'skipped',error:'notEligible'};
      const documentRefs=(mail.delivery.documents??[]).filter(document=>document.attach);
      const storedDocuments=documentRefs.length?await withSystemWork(()=>client`select * from app.automation_email_document_files(${id}::uuid,${token}::uuid,${origin})`):[];
      if(storedDocuments.length!==documentRefs.length)return {outcome:'skipped',error:'notEligible'};
      for(const ref of documentRefs){const file=storedDocuments.find(row=>row.id===ref.id);if(!file)return {outcome:'skipped',error:'notEligible'};attachments.push(managedEmailAttachment.parse({filename:file.filename,contentType:file.mime_type,bytes:Buffer.from(file.bytes,'base64')}));}
      const links=(mail.delivery.documents??[]).filter(document=>document.link).map(document=>document.name+': '+notificationEmailLink(origin,document.path));
      if(links.length)text+='\n\n'+links.join('\n');
      const caseRefs=mail.delivery.caseFiles??[];
      const storedCaseFiles=caseRefs.length?await withSystemWork(()=>client`select * from app.automation_email_case_files(${id}::uuid,${token}::uuid,${origin})`):[];
      if(storedCaseFiles.length!==caseRefs.length)return {outcome:'skipped',error:'notEligible'};
      for(const ref of caseRefs){const file=storedCaseFiles.find(row=>row.id===ref.id);if(!file)return {outcome:'skipped',error:'notEligible'};attachments.push(managedEmailAttachment.parse({filename:file.filename,contentType:file.mime_type,bytes:Buffer.from(file.bytes,'base64')}));}
      const references=mail.delivery.assets??[];
      const rows=references.length?await withSystemWork(()=>client`select * from app.automation_email_assets(${id}::uuid,${token}::uuid,${origin})`):[];
      if(rows.length!==references.length)return {outcome:'skipped',error:'notEligible'};
      for(const ref of references){const asset=rows.find(row=>row.id===ref.id);if(!asset)return {outcome:'skipped',error:'notEligible'};attachments.push(managedEmailAttachment.parse({filename:asset.filename,contentType:asset.mime_type,bytes:Buffer.from(asset.bytes,'base64'),...(asset.kind==='image'?{cid:v9ImageCid(asset.id)}:{})}));}
      if(attachments.length>MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT||attachments.reduce((sum,a)=>sum+a.bytes.byteLength,0)>MANAGED_EMAIL_ATTACHMENT_MAX_BYTES)return {outcome:'skipped',error:'notEligible'};
    }catch{return {outcome:'skipped',error:'notEligible'};}
  }
  const currentRelay = await readLifecycleRelayTx(admittedAuthSql, target.tenantId);
  if (!currentRelay || currentRelay.revision !== active.revision || currentRelay.senderName !== active.senderName) return { outcome: 'skipped', error: 'relayUnavailable' };
  const proof = { bindings: target.bindings, addresses, relayRevision: active.revision, senderProfile: 'noreply', senderName: active.senderName ?? active.relay.config.fromName, senderAddress: active.relay.config.from };
  const started = (await withSystemWork(()=>client`select app.automation_email_start(${id}::uuid,${token}::uuid,${origin},${JSON.stringify(proof)}::jsonb) as started`))[0]?.started === true;
  if (!started) return { outcome: 'skipped', error: 'notEligible' };
  let result: AutomationDeliveryResult;
  try {
    await transport(active.relay, { to: toAddresses.length === 1 ? toAddresses[0] : toAddresses, cc: ccAddresses, subject: mail.subject, text, ...(html?{html}:{}), attachments, ...(active.senderName ? { senderName: active.senderName } : {}), messageId: `<automation.${id}@${new URL(origin).hostname}>` });
    result = { outcome: 'sent', error: null };
  } catch (error) { result = notificationSmtpFailure(error); }
  const finished = (await withSystemWork(()=>client`select app.automation_email_finish(${id}::uuid,${token}::uuid,${result.outcome},${result.error}) as finished`))[0]?.finished === true;
  if (!finished) return { outcome: 'uncertain', error: 'uncertain' };
  return result;
}
