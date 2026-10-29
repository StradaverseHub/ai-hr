/** Request parsing shared by the M07 v2 leave routes (app/api/mobile/v2/leave/requests/**). Server only. */
import { MobileBadRequest } from './handler';
import { mobileLocale } from './request';
import { mobileTranslator } from './server-text';
import type { KindLabel } from '@/core/mobile-leave-history';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `{id}` segment after `/leave/requests/`, a UUID or a 400 — read from the URL so every handler shares one rule. */
export function leaveRequestIdOf(req: Request): string {
  const parts = new URL(req.url).pathname.split('/');
  const id = parts[parts.indexOf('requests') + 1] ?? '';
  if (!parts.includes('requests') || !UUID.test(id)) throw new MobileBadRequest('Invalid leave request id');
  return id.toLowerCase();
}

/** The approver kinds' labels (`leaveApproval.*`), in the caller's language. */
export async function approverKindLabels(req: Request): Promise<KindLabel> {
  const t = await mobileTranslator(mobileLocale(req), 'leaveApproval');
  return (key) => t(key);
}
