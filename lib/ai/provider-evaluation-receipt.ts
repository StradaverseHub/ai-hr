/** Opaque server-issued evidence: synthetic protocol behaviour and explicit human policy review only. */
import { z } from 'zod';
import { decryptSecret, encryptSecret, isSecretStorable } from './crypto';
export const PROVIDER_ACCOUNT_REVIEW_VERSION = 1;
const Receipt = z.object({ version: z.literal(1), evaluationId: z.string().uuid(), candidateId: z.string().uuid(), candidateVersion: z.string().uuid(),
  candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/), principalFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  suiteVersion: z.literal(1), accountReviewVersion: z.literal(1), issuedAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict();
export type ProviderEvaluationReceipt = z.infer<typeof Receipt>;
export type ProviderEvaluationBinding = Readonly<{ tenantId: string; userId: string }>;
const aad = (binding: ProviderEvaluationBinding) => JSON.stringify(['ai-hr.provider-protocol-evaluation.v1', binding.tenantId, binding.userId]);
export function sealProviderEvaluationReceipt(binding: ProviderEvaluationBinding, receipt: ProviderEvaluationReceipt): string {
  if (!isSecretStorable()) throw Error('Provider evaluation unavailable.');
  const value = Receipt.parse(receipt), token = encryptSecret(JSON.stringify(value), aad(binding));
  if (Buffer.byteLength(token, 'utf8') > 16_384) throw Error('Provider evaluation unavailable.');
  return token;
}
export function openProviderEvaluationReceipt(binding: ProviderEvaluationBinding, token: unknown): ProviderEvaluationReceipt | null {
  try {
    if (!isSecretStorable() || typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > 16_384 || !/^[A-Za-z0-9_-]+$/.test(token) ||
        Buffer.from(token, 'base64url').toString('base64url') !== token) return null;
    const value = Receipt.parse(JSON.parse(decryptSecret(token, aad(binding))));
    const now = Date.now(), issued = Date.parse(value.issuedAt), expires = Date.parse(value.expiresAt);
    if (issued > now || expires <= now || expires <= issued || expires - issued > 3_600_000) return null;
    return Object.freeze(value);
  } catch { return null; }
}
