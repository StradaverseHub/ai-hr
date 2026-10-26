/** Fixed canonical SMTP record projection; operator drafts never leave this reader. */
import { z } from 'zod';
import { EmailSettingsError } from '../identity/email-model';
import { readRecord, type AuthSql } from './record-store';
import {storedEmailRelay} from '../identity/email-relay';
export const INTERNAL_EMAIL_STATE_KEY = 'email-state';
const relay = storedEmailRelay;
// Canonical states start at "initial" and Apply assigns opaque()'s 43-character revision.
// Only this new projection is validated; existing settings/recovery callers retain their behavior.
const projection = z.object({
  revision: z.union([z.literal('initial'), z.string().regex(/^[A-Za-z0-9_-]{43}$/)]),
  active: relay.nullable(),
});
export type ActiveInternalRelay = { revision: string; relay: Relay };
/** lock=true holds the existing row only. A caller coordinating with settings writes must first
 * acquire the canonical internal-auth:email-state advisory lock in this same transaction. */
export async function readActiveRelayTx(tx: AuthSql, lock = false): Promise<ActiveInternalRelay | null> {
  const stored = await readRecord<unknown>(tx, INTERNAL_EMAIL_STATE_KEY, lock);
  if (stored === null) return null;
  const parsed = projection.safeParse(stored);
  if (!parsed.success) throw new EmailSettingsError('invalid');
  return parsed.data.active === null ? null : { revision: parsed.data.revision, relay: parsed.data.active };
}
