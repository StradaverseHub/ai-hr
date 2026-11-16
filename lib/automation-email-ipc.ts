import { internalSelected } from './internal-auth/config';
import { lifecycleV9DeliveryRequest, type LifecycleV9DeliveryRequest, type LifecycleV9DeliveryResult } from './lifecycle-v9-delivery-model';
import type {AutomationRichEmailBody} from './automation-email-content';
import type {Document, EmailAsset} from './lifecycle-v9-model';
/**
 * Shared workflow email (migration 5754) crosses the authentication boundary exactly like On/Off Boarding V9 mail: only
 * the durable delivery id and a one-attempt lease token. The private sender reads everything else itself.
 */
export type AutomationDeliveryRequest = LifecycleV9DeliveryRequest;
export type AutomationDeliveryResult = LifecycleV9DeliveryResult;
/** Frozen by the module in the same transaction as its workflow step. No addresses or SMTP settings. */
export type AutomationEmailContent = {
  number: string;
  emailTemplateId?: string;
  documents: Document[];
  pdfDocumentIds: string[];
  linkDocumentIds: string[];
  html?: string;
  assets?: EmailAsset[];
  files?: {id: string; storageId: string; name: string; contentHash: string}[];
};
export type AutomationMailTarget = {
  id: string; tenantId: string; module: 'probation'|'contract_staff'|'off'; subjectId: string;
  payload: { version: 1; module: 'probation'|'contract_staff'|'off'; subjectId: string; linkPath: string; content?:AutomationEmailContent;mail: { id: string; to: string[]; cc: string[]; subject: string; body: string;richBody?:AutomationRichEmailBody|null; delivery: { version: 1; sender: string } } };
  bindings: { userId: string; subject: string; issuer: string }[];
};
/** Compatibility adapters do not claim support for a private capability they cannot verify. */
export async function automationEmailIpc(input: AutomationDeliveryRequest): Promise<AutomationDeliveryResult> {
  const request = lifecycleV9DeliveryRequest.parse(input);
  if (!internalSelected()) return { outcome: 'skipped', error: 'relayUnavailable' };
  return (await import('./internal-auth/automation-mail')).internalAutomationMail(request);
}
