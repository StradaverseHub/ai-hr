/** Fixed canonical SMTP record projection; operator drafts never leave this reader. */
import { z } from 'zod';
import { managedEmailSenderProfiles, type ManagedEmailSenderProfile } from '../managed-email-policy';
import { EmailSettingsError } from '../identity/email-model';
import { readRecord, type AuthSql } from './record-store';
import {storedEmailRelay,type StoredEmailRelay} from '../identity/email-relay';
export const INTERNAL_EMAIL_STATE_KEY = 'email-state';
const relay = storedEmailRelay;
// Canonical states start at "initial" and Apply assigns opaque()'s 43-character revision.
// Only this new projection is validated; existing settings/recovery callers retain their behavior.
const projection = z.object({
  revision: z.union([z.literal('initial'), z.string().regex(/^[A-Za-z0-9_-]{43}$/)]),
  active: relay.nullable(),
});
export type ActiveInternalRelay = { revision: string; relay: StoredEmailRelay };
/** lock=true holds the existing row only. A caller coordinating with settings writes must first
 * acquire the canonical internal-auth:email-state advisory lock in this same transaction. */
export async function readActiveRelayTx(tx: AuthSql, lock = false): Promise<ActiveInternalRelay | null> {
  const stored = await readRecord<unknown>(tx, INTERNAL_EMAIL_STATE_KEY, lock);
  if (stored === null) return null;
  const parsed = projection.safeParse(stored);
  if (!parsed.success) throw new EmailSettingsError('invalid');
  return parsed.data.active === null ? null : { revision: parsed.data.revision, relay: parsed.data.active };
}

const lifecycleBinding = z.object({ connectionId:z.string().min(1).max(120),version:z.string().min(1).max(120),relay,
 revision:z.string().regex(/^[A-Za-z0-9_-]{43}$/),appliedAt:z.number().int().positive(),appliedBy:z.string().min(1).max(500) }).strict();
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
/** The frozen sender version is separate from editable saved connections and the installation default. */
export async function readLifecycleRelayTx(tx:AuthSql,tenantId:string,profile:ManagedEmailSenderProfile):Promise<ActiveInternalRelay|null> {
 if(!managedEmailSenderProfiles.includes(profile)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(tenantId))throw new EmailSettingsError('invalid');
 const stored=await readRecord<unknown>(tx,INTERNAL_EMAIL_STATE_KEY);if(stored===null)return null;
 const parsed=projection.safeParse(stored);if(!parsed.success||!record(stored))throw new EmailSettingsError('invalid');
 const senders=stored.lifecycleSenders;
 if(senders!==undefined&&!record(senders))throw new EmailSettingsError('invalid');
 const scoped=record(senders)&&Object.hasOwn(senders,tenantId)?senders[tenantId]:undefined;
 if(scoped!==undefined&&!record(scoped))throw new EmailSettingsError('invalid');
 if(record(scoped)&&Object.hasOwn(scoped,profile)) {
  const binding=lifecycleBinding.safeParse(scoped[profile]);if(!binding.success)throw new EmailSettingsError('invalid');
  return {revision:binding.data.revision,relay:binding.data.relay};
 }
 return parsed.data.active===null?null:{revision:parsed.data.revision,relay:parsed.data.active};
}
