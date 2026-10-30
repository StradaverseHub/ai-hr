import { v9LiteralAddress } from '../lifecycle-v9-recipient';
import { v9EmailContent, v9ImageCid } from '../lifecycle-v9-email-content';
import { client } from '../../db/client';
import { renderV9DocumentPdf } from '../lifecycle-v9-pdf';
import { lifecycleV9DeliveryRequest, type LifecycleV9DeliveryRequest, type LifecycleV9DeliveryResult, type LifecycleV9MailTarget } from '../lifecycle-v9-delivery-model';
import { managedEmailAttachment, MANAGED_EMAIL_ATTACHMENT_MAX_BYTES, MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT, type ManagedEmailAttachment } from '../managed-email-attachment';
import { notificationEmailLink, notificationSmtpFailure } from '../notification-email-model';
import { internalConfig, internalIssuer } from './config';
import { readRecord } from './store';
import { assertActiveCredential, InternalAuthError, type Credential } from './service';
import { readLifecycleRelayTx } from './active-relay';
import { sendSmtp, type MailTransport } from './smtp';

/** Authentication owns credential verification and the applied relay. The caller supplies neither
 * addresses, message text, documents, file paths, relay settings nor an alternate installation URL. */
export async function internalLifecycleV9Mail(input: LifecycleV9DeliveryRequest, transport: MailTransport = sendSmtp): Promise<LifecycleV9DeliveryResult> {
  const { deliveryId: id, leaseToken: token } = lifecycleV9DeliveryRequest.parse(input), origin = internalConfig().origin;
  const target = (await client`select app.lc_v9_email_target(${id}::uuid,${token}::uuid,${origin}) as target`)[0]?.target as LifecycleV9MailTarget | null;
  if (!target) return { outcome: 'skipped', error: 'notEligible' };
  const profile = target.payload.mail.delivery?.sender;
  if (!profile || !['onboarding','hr','noreply'].includes(profile)) return { outcome: 'skipped', error: 'notEligible' };
  const active = await readLifecycleRelayTx(client, target.tenantId, profile);
  if (!active) return { outcome: 'skipped', error: 'relayUnavailable' };
  const byRecipient = new Map<string, string>();
  if (target.contact) byRecipient.set(target.contact.email, target.contact.email);
  for (const literal of target.literals ?? []) {
    if (v9LiteralAddress(literal.key) !== literal.email) return { outcome: 'skipped', error: 'recipientUnavailable' };
    byRecipient.set(literal.key, literal.email);
  }
  for (const binding of target.bindings) {
    const credential = await readRecord<Credential>(client, `credential:${binding.subject}`);
    if (!credential || credential.subject !== binding.subject || credential.tenantId !== target.tenantId || credential.issuer !== internalIssuer(target.tenantId) || credential.issuer !== binding.issuer)
      return { outcome: 'skipped', error: 'recipientChanged' };
    try {
      const principal = await assertActiveCredential(client, credential);
      if (principal.app_user_id !== binding.userId) return { outcome: 'skipped', error: 'recipientChanged' };
    } catch (error) {
      if (error instanceof InternalAuthError) return { outcome: 'skipped', error: 'recipientChanged' };
      throw error;
    }
    byRecipient.set(binding.userId, credential.email);
  }
  const addresses = [...target.payload.mail.to, ...target.payload.mail.cc].map(key => byRecipient.get(key));
  if (addresses.some(address => !address) || addresses.length !== target.payload.mail.to.length + target.payload.mail.cc.length || new Set(addresses.map(address => address!.toLowerCase())).size !== addresses.length)
    return { outcome: 'skipped', error: 'recipientUnavailable' };
  const { mail, documents, files } = target.payload;
  if (!mail.delivery || mail.delivery.version !== 1 || mail.to.length !== 1) return { outcome: 'skipped', error: 'notEligible' };
  const attachments: ManagedEmailAttachment[] = [];
  for (const documentId of mail.delivery.pdfDocumentIds) {
    const document = documents.find(document => document.id === documentId);
    if (!document) return { outcome: 'skipped', error: 'notEligible' };
    const { bytes } = await renderV9DocumentPdf(document, target.payload.number, document.templateType === 'Attachment');
    attachments.push(managedEmailAttachment.parse({ filename: document.name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 180) + '.pdf', contentType: 'application/pdf', bytes }));
  }
  const storedFiles = await client`select * from app.lc_v9_email_files(${id}::uuid,${token}::uuid,${origin})`;
  if (storedFiles.length !== files.length) return { outcome: 'skipped', error: 'notEligible' };
  for (const reference of files) { const file = storedFiles.find(file => file.id === reference.id); if (!file) return { outcome: 'skipped', error: 'notEligible' }; attachments.push(managedEmailAttachment.parse({ filename: file.filename, contentType: file.mime_type, bytes: Buffer.from(file.bytes, 'base64') })); }
  const assetReferences = mail.delivery.assets ?? [];
  const assets = assetReferences.length ? await client`select * from app.lc_v9_email_assets(${id}::uuid,${token}::uuid,${origin})` : [];
  if (assets.length !== assetReferences.length) return { outcome: 'skipped', error: 'notEligible' };
  for (const reference of assetReferences) { const asset = assets.find(asset => asset.id === reference.id); if (!asset) return { outcome: 'skipped', error: 'notEligible' }; attachments.push(managedEmailAttachment.parse({ filename: asset.filename, contentType: asset.mime_type, bytes: Buffer.from(asset.bytes, 'base64'), ...(asset.kind === 'image' ? { cid: v9ImageCid(asset.id) } : {}) })); }
  if (attachments.length > MANAGED_EMAIL_ATTACHMENTS_MAX_COUNT || attachments.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MANAGED_EMAIL_ATTACHMENT_MAX_BYTES)
    return { outcome: 'skipped', error: 'notEligible' };
  const links = mail.delivery.linkDocumentIds.map(documentId => {
    const document = documents.find(document => document.id === documentId);
    if (!document) throw new Error('Queued document link is unavailable');
    return document.name + ': ' + notificationEmailLink(origin, `/me/lifecycle?case=${encodeURIComponent(target.caseId)}&document=${encodeURIComponent(documentId)}`);
  });
  const content = v9EmailContent(mail.body + (links.length ? '\n\n' + links.join('\n') : ''), assetReferences.filter(asset => asset.kind === 'image'));
  const currentRelay = await readLifecycleRelayTx(client, target.tenantId, profile);
  if (!currentRelay || currentRelay.revision !== active.revision) return { outcome: 'skipped', error: 'relayUnavailable' };
  const proof = { bindings: target.bindings, contact: target.contact ?? null, literals: target.literals ?? [], addresses, relayRevision: active.revision, senderProfile: profile, senderAddress: active.relay.config.from };
  // A separate completed statement persists start BEFORE any external message bytes are sent.
  const started = (await client`select app.lc_v9_email_start(${id}::uuid,${token}::uuid,${origin},${JSON.stringify(proof)}::jsonb) as started`)[0]?.started === true;
  if (!started) return { outcome: 'skipped', error: 'notEligible' };
  let result: LifecycleV9DeliveryResult;
  try {
    await transport(active.relay, { to: addresses[0]!, cc: addresses.slice(1) as string[], subject: mail.subject, ...content, attachments, senderProfile: mail.delivery.sender, messageId: `<lifecycle-v9.${id}@${new URL(origin).hostname}>` });
    result = { outcome: 'sent', error: null };
  } catch (error) { result = notificationSmtpFailure(error); }
  const finished = (await client`select app.lc_v9_email_finish(${id}::uuid,${token}::uuid,${result.outcome},${result.error}) as finished`)[0]?.finished === true;
  // The worker reads the durable receipt. A lost finish acknowledgement never authorizes replay.
  if (!finished) return { outcome: 'uncertain', error: 'uncertain' };
  return result;
}
