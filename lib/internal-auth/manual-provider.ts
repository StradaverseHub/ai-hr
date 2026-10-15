import { client } from '../../db/client';
import { internalIssuer } from './config';
import { readRecord } from './store';
import { createDisabledCredential, updateDisabledCredential, InternalAuthError, type Credential } from './service';
import { ManualIdentityError, type ManualIdentityEnrollment } from '../identity/manual-model';
import type { ManualAccountProvider } from '../identity/manual-provider';
export function internalManualProvider(): ManualAccountProvider {
  async function translated<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof InternalAuthError) throw new ManualIdentityError(error.code === 'conflict' ? 'conflict' : error.code === 'passwordPolicy' ? 'invalid' : 'unavailable');
      throw error;
    }
  }
  async function checked(e: ManualIdentityEnrollment, allowMissing = false) {
    if (e.issuer !== internalIssuer(e.tenant_id) || !e.subject) throw new ManualIdentityError('forbidden');
    const c = await readRecord<Credential>(client, `credential:${e.subject}`);
    if (!c && allowMissing) return null;
    if (!c || c.issuer !== e.issuer || c.tenantId !== e.tenant_id || c.username !== e.username || c.email !== e.email || c.subject !== e.subject)
      throw new ManualIdentityError('conflict');
    return c;
  }
  return {
    create: e => {
      if (e.issuer !== internalIssuer(e.tenant_id)) throw new ManualIdentityError('forbidden');
      return translated(() => createDisabledCredential({ tenantId: e.tenant_id, username: e.username, email: e.email, enrollmentId: e.id }));
    },
    async setPassword(e, password) { await checked(e); await translated(() => updateDisabledCredential(e.subject!, 'password', password)); },
    async enable(e) { await checked(e); await translated(() => updateDisabledCredential(e.subject!, 'enable')); },
    async cancel(e) {
      const known = e.subject || (await readRecord<{ subject: string }>(client, `manual-intent:${e.id}`))?.subject;
      if (!known) return;
      const c = await checked({ ...e, subject: known }, true);
      if (!c) return;
      if (c.enrollmentId !== e.id) throw new ManualIdentityError('conflict');
      await translated(() => updateDisabledCredential(known, 'cancel'));
    },
  };
}
