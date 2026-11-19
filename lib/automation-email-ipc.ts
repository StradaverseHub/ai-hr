import { internalSelected } from './internal-auth/config';
import { lifecycleV9DeliveryRequest, type LifecycleV9DeliveryRequest, type LifecycleV9DeliveryResult } from './lifecycle-v9-delivery-model';
import type {Document, EmailAsset} from './lifecycle-v9-model';
import type {AutomationEmailAsset} from './automation-email-assets';
import type {AutomationEmailLinkedDocument,AutomationRichEmailBody} from './automation-email-content';
/**
 * Shared workflow email (migration 5754) crosses the authentication boundary exactly like On/Off Boarding V9 mail: only
 * the durable delivery id and a one-attempt lease token. The private sender reads everything else itself.
 */
export type AutomationDeliveryRequest = LifecycleV9DeliveryRequest;
export type AutomationDeliveryResult = LifecycleV9DeliveryResult;
export type AutomationEmailCaseFileRef={id:string;slotId:string;name:string;contentHash:string};
export type AutomationEmailDocumentRef={id:string;templateId:string;name:string;contentHash:string;path:string;link:boolean;attach:boolean;outcome?:boolean;outcomeId?:string};
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
  payload: { version: 1; module: 'probation'|'contract_staff'|'off'; subjectId: string; linkPath: string; content?:AutomationEmailContent; purpose?:string;mail: { id: string; to: string[]; cc: string[]; subject: string; body: string;richBody?:AutomationRichEmailBody|null; delivery: { version: 1|2; sender: string;html?:string;caseFiles?:AutomationEmailCaseFileRef[];assets?:(AutomationEmailAsset|{id:string;kind:'file'|'image';contentHash:string})[];documents?:(AutomationEmailLinkedDocument|AutomationEmailDocumentRef)[] } } };
  bindings: { userId: string; subject: string; issuer: string }[];
};
/** Compatibility adapters do not claim support for a private capability they cannot verify. */
export async function automationEmailIpc(input: AutomationDeliveryRequest): Promise<AutomationDeliveryResult> {
  const request = lifecycleV9DeliveryRequest.parse(input);
  if (!internalSelected()) return { outcome: 'skipped', error: 'relayUnavailable' };
  return (await import('./internal-auth/automation-mail')).internalAutomationMail(request);
}
