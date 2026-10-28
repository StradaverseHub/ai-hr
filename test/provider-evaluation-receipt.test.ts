/** Authored UNRUN. Cryptographic custody tests do not attest provider capability. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProviderEvaluationReceipt, sealProviderEvaluationReceipt } from '../lib/ai/provider-evaluation-receipt';
const binding = { tenantId: 'fictional-tenant', userId: 'fictional-user' };
const receipt = () => ({ version: 1, evaluationId: randomUUID(), candidateId: randomUUID(), candidateVersion: randomUUID(), candidateFingerprint: 'a'.repeat(64), principalFingerprint: 'b'.repeat(64), suiteVersion: 1, accountReviewVersion: 1, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString() } as const);
beforeEach(() => vi.stubEnv('AI_CONFIG_SECRET', 'fictional-provider-receipt-test-passphrase'));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('provider evaluation receipt custody', () => {
  it('round-trips exact server fields and binds both tenant and human reviewer', () => {
    const proof = receipt(), token = sealProviderEvaluationReceipt(binding, proof);
    expect(token).not.toContain(proof.candidateFingerprint);
    expect(openProviderEvaluationReceipt(binding, token)).toEqual(proof);
    expect(openProviderEvaluationReceipt({ ...binding, tenantId: 'other' }, token)).toBeNull();
    expect(openProviderEvaluationReceipt({ ...binding, userId: 'other' }, token)).toBeNull();
    expect(openProviderEvaluationReceipt(binding, token+'=')).toBeNull();
    expect(openProviderEvaluationReceipt(binding, token.slice(0, 18)+'!'+token.slice(19))).toBeNull();
  });
  it('refuses expired, future, excessive-lifetime and unavailable-secret receipts even in a warm process', () => {
    const proof = receipt(), token = sealProviderEvaluationReceipt(binding, proof);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now+31000);
    expect(openProviderEvaluationReceipt(binding, token)).toBeNull(); vi.restoreAllMocks();
    expect(openProviderEvaluationReceipt(binding, sealProviderEvaluationReceipt(binding, { ...proof, issuedAt: new Date(now+1000).toISOString() }))).toBeNull();
    expect(openProviderEvaluationReceipt(binding, sealProviderEvaluationReceipt(binding, { ...proof, expiresAt: new Date(now+3600001).toISOString() }))).toBeNull();
    vi.stubEnv('AI_CONFIG_SECRET','');
    expect(openProviderEvaluationReceipt(binding, token)).toBeNull();
    expect(() => sealProviderEvaluationReceipt(binding, proof)).toThrow();
  });
});
