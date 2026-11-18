import { z } from 'zod';

export const MAX_REMEMBERED_MFA_DAYS = 90;
export const DEFAULT_REMEMBERED_MFA_POLICY = { rememberDays: 30 };
const policySchema = z.object({ rememberDays: z.number().int().min(0).max(MAX_REMEMBERED_MFA_DAYS) }).strict();
export type RememberedMfaPolicy = z.infer<typeof policySchema>;
export type RememberedMfaPolicyState = { policy: RememberedMfaPolicy; revision: number };
export const rememberedMfaPolicyKey = (tenantId: string) => `remembered-mfa-policy:${tenantId}`;
export function validateRememberedMfaPolicy(value: unknown): RememberedMfaPolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid');
  return parsed.data;
}
export function validateRememberedMfaState(value: RememberedMfaPolicyState): RememberedMfaPolicyState {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('invalid');
  return { policy: validateRememberedMfaPolicy(value.policy), revision: value.revision };
}
