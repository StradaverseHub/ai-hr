import { internalSelected } from './internal-auth/config';
import { lifecycleV9DeliveryRequest, type LifecycleV9DeliveryRequest, type LifecycleV9DeliveryResult } from './lifecycle-v9-delivery-model';
import type {AutomationEmailAsset} from './automation-email-assets';
import type {AutomationEmailLinkedDocument,AutomationRichEmailBody} from './automation-email-content';
/**
 * Shared workflow email (migration 5754) crosses the authentication boundary exactly like On/Off Boarding V9 mail: only
 * the durable delivery id and a one-attempt lease token. The private sender reads everything else itself.
 */
export type AutomationDeliveryRequest = LifecycleV9DeliveryRequest;
export type AutomationDeliveryResult = LifecycleV9DeliveryResult;
export type AutomationMailTarget = {
  id: string; tenantId: string; module: 'probation'|'contract_staff'; subjectId: string;
  payload: { version: 1; module: 'probation'|'contract_staff'; subjectId: string; linkPath: string; purpose?:string;mail: { id: string; to: string[]; cc: string[]; subject: string; body: string;richBody?:AutomationRichEmailBody|null; delivery: { version: 1; sender: string;assets?:AutomationEmailAsset[];documents?:AutomationEmailLinkedDocument[] } } };
  bindings: { userId: string; subject: string; issuer: string }[];
};
/** Compatibility adapters do not claim support for a private capability they cannot verify. */
export async function automationEmailIpc(input: AutomationDeliveryRequest): Promise<AutomationDeliveryResult> {
  const request = lifecycleV9DeliveryRequest.parse(input);
  if (!internalSelected()) return { outcome: 'skipped', error: 'relayUnavailable' };
  return (await import('./internal-auth/automation-mail')).internalAutomationMail(request);
}
