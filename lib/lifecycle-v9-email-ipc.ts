import { internalSelected } from './internal-auth/config';
import { lifecycleV9DeliveryRequest, type LifecycleV9DeliveryRequest, type LifecycleV9DeliveryResult } from './lifecycle-v9-delivery-model';
/** Compatibility adapters do not claim support for a private capability they cannot verify. */
export async function lifecycleV9EmailIpc(input: LifecycleV9DeliveryRequest): Promise<LifecycleV9DeliveryResult> {
  const request = lifecycleV9DeliveryRequest.parse(input);
  if (!internalSelected()) return { outcome: 'skipped', error: 'relayUnavailable' };
  return (await import('./internal-auth/lifecycle-v9-mail')).internalLifecycleV9Mail(request);
}
