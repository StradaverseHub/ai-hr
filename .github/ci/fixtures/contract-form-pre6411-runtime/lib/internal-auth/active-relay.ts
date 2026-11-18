/** Fixed canonical SMTP record projection; operator drafts never leave this reader. */
import { z } from 'zod';
import { legacyManagedEmailSenderProfiles, validManagedEmailSenderName } from '../managed-email-policy';
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
const senderName = z.object({ name:z.string().min(1).max(160), setAt:z.number().int().positive(), setBy:z.string().min(1).max(500) }).strict();
export type LifecycleRelay = ActiveInternalRelay & { senderName: string | null };
const tenantPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** Pure resolution over the stored record; exported for the binding and fail-closed tests. */
export function resolveLifecycleSender(stored: unknown, tenantId: string): LifecycleRelay | null {
 if(!tenantPattern.test(tenantId))throw new EmailSettingsError('invalid');
 const parsed=projection.safeParse(stored);if(!parsed.success||!record(stored))throw new EmailSettingsError('invalid');
 const senders=stored.lifecycleSenders,names=stored.lifecycleSenderNames;
 if(senders!==undefined&&!record(senders)||names!==undefined&&!record(names))throw new EmailSettingsError('invalid');
 const scoped=record(senders)&&Object.hasOwn(senders,tenantId)?senders[tenantId]:undefined;
 if(scoped!==undefined&&!record(scoped))throw new EmailSettingsError('invalid');
 const binding=(profile:string)=>{
  if(!record(scoped)||!Object.hasOwn(scoped,profile))return null;
  const value=lifecycleBinding.safeParse(scoped[profile]);if(!value.success)throw new EmailSettingsError('invalid');return value.data;
 };
 const current=binding('noreply');
 // Fail closed: an earlier per-name binding to a different connection holds mail for review, never sends from another address.
 for(const profile of legacyManagedEmailSenderProfiles){const legacy=binding(profile);if(legacy&&(!current||legacy.connectionId!==current.connectionId||legacy.version!==current.version))return null;}
 const active=current?{revision:current.revision,relay:current.relay}:parsed.data.active===null?null:{revision:parsed.data.revision,relay:parsed.data.active};
 if(!active)return null;
 const named=record(names)&&Object.hasOwn(names,tenantId)?senderName.safeParse(names[tenantId]):null;
 if(named&&!named.success)throw new EmailSettingsError('invalid');
 const name=validManagedEmailSenderName(named?.data.name)??validManagedEmailSenderName(active.relay.config.fromName);
 return {...active,senderName:name};
}
/** The frozen sender version is separate from editable saved connections and the installation default.
 * The display name is the tenant's own setting; without one, the connection's own name is used. */
export async function readLifecycleRelayTx(tx:AuthSql,tenantId:string):Promise<LifecycleRelay|null> {
 const stored=await readRecord<unknown>(tx,INTERNAL_EMAIL_STATE_KEY);if(stored===null)return null;
 return resolveLifecycleSender(stored,tenantId);
}
/** Secret-free projection for the template editor: the display name only. */
export async function readLifecycleSenderNameTx(tx:AuthSql,tenantId:string):Promise<string|null> {
 return (await readLifecycleRelayTx(tx,tenantId))?.senderName??null;
}
