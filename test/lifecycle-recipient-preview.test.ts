import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encryptRecord } from '../lib/internal-auth/crypto';
import { internalIssuer } from '../lib/internal-auth/config';
import type { Credential } from '../lib/internal-auth/credential';
import { lifecycleRecipientProjection, type LifecycleRecipientBinding } from '../lib/internal-auth/lifecycle-recipient-preview';
const tenant = '11111111-1111-4111-8111-111111111111', now = Date.UTC(2026, 10, 17);
beforeEach(() => { vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.fixture.test'); vi.stubEnv('AUTH_SESSION_KEY', '9'.repeat(64)); });
afterEach(() => vi.unstubAllEnvs());
function binding(patch: Partial<Credential> = {}, expiresAt: number | null = null): LifecycleRecipientBinding {
  const subject = randomUUID();
  const c: Credential = { subject, tenantId: tenant, issuer: internalIssuer(tenant), organization: 'fixture', username: 'fixture',
    email: 'account@fixture.test', enabled: true, emailVerified: true, password: 'fictional-hash', mustChange: false,
    totpSecret: 'fictional-secret', lastStep: -1, recoveryHashes: [], version: randomUUID(), ...patch };
  return { user_id: randomUUID(), tenant_id: tenant, name: 'Fictional account', department: 'Fictional People',
    subject, issuer: internalIssuer(tenant), sealed: encryptRecord(c, `credential:${subject}`, expiresAt), policy_sealed: null };
}
it('projects only account email/name/department, never encrypted material or credential fields', () => {
  const row = binding();
  const output = lifecycleRecipientProjection(tenant, [row], now);
  expect(output).toEqual([{ id: row.user_id, name: row.name, department: row.department, email: 'account@fixture.test' }]);
  for (const privateValue of [row.sealed, 'fictional-secret', 'fictional-hash', 'recoveryHashes', 'subject', 'sealed']) expect(JSON.stringify(output)).not.toContain(privateValue);
});
it.each([
  { enabled: false }, { suspended: true }, { mustChange: true }, { password: null }, { totpSecret: null },
  { emailVerified: false }, { accountActiveUntil: '2026-11-16' }, { tenantId: randomUUID() },
  { issuer: 'https://unrelated.fixture.test/auth' }, { subject: randomUUID() }, { email: 'invalid' },
])('refuses unavailable or changed canonical account state %j', patch => {
  expect(lifecycleRecipientProjection(tenant, [binding(patch)], now)).toEqual([]);
});
it('keeps inclusive HR account expiry, ciphertext expiry and tenant binding distinct', () => {
  expect(lifecycleRecipientProjection(tenant, [binding({ accountActiveUntil: '2026-11-17' })], now)).toHaveLength(1);
  expect(lifecycleRecipientProjection(tenant, [binding({}, now)], now)).toEqual([]);
  const row = binding();
  expect(lifecycleRecipientProjection(randomUUID(), [row], now)).toEqual([]);
  expect(lifecycleRecipientProjection(tenant, [{ ...row, issuer: 'https://other.fixture.test' }], now)).toEqual([]);
});
it('uses the canonical tenant password policy once for the batch, including expired-record semantics', () => {
  const row = binding();
  const key = `password-policy:${tenant}`;
  const policy = encryptRecord({ policy: { enabled: true, interval: 1, unit: 'days' }, revision: 1 }, key, null);
  expect(lifecycleRecipientProjection(tenant, [{ ...row, policy_sealed: policy }], now)).toEqual([]);
  const expired = encryptRecord({ policy: { enabled: true, interval: 1, unit: 'days' }, revision: 1 }, key, now);
  expect(lifecycleRecipientProjection(tenant, [{ ...row, policy_sealed: expired }], now)).toHaveLength(1);
});
it('fails closed on tampered ciphertext rather than falling back to a personnel address', () => {
  expect(() => lifecycleRecipientProjection(tenant, [{ ...binding(), sealed: 'tampered' }], now)).toThrow();
});
