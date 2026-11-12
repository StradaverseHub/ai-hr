import 'server-only';
import { internalSelected } from './internal-auth/config';
export type LifecycleV9Sender = { name: string | null; configured: boolean };
/** Secret-free display projection for the email template editor. The caller must already hold
 * On/Off Boarding administration; this returns the display name only, never an address or credential. */
export async function lifecycleV9SenderName(tenantId: string): Promise<LifecycleV9Sender> {
  if (!internalSelected()) return { name: null, configured: false };
  const [{ readLifecycleSenderNameTx }, { admittedAuthSql }] = await Promise.all([import('./internal-auth/active-relay'), import('./internal-auth/store')]);
  try {
    const name = await readLifecycleSenderNameTx(admittedAuthSql, tenantId);
    return { name, configured: name !== null };
  } catch { return { name: null, configured: false }; }
}
