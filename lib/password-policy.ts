import { z } from 'zod';
import { todayInKualaLumpur } from './hr-date';

const policySchema = z.object({
  enabled: z.boolean(),
  interval: z.number().int().min(1).max(3650),
  unit: z.enum(['days', 'months']),
}).strict().refine(value => value.unit !== 'months' || value.interval <= 120);
export type PasswordPolicy = z.infer<typeof policySchema>;
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { enabled: false, interval: 90, unit: 'days' };
export function validatePasswordPolicy(value: unknown): PasswordPolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid');
  return parsed.data;
}
export const passwordPolicyKey = (tenantId: string) => `password-policy:${tenantId}`;
export type PasswordPolicyState = { policy: PasswordPolicy; revision: number };
export function passwordExpired(changedAt: number | undefined, policy: PasswordPolicy, now = Date.now()) {
  if (!policy.enabled) return false;
  // Legacy credentials have no trustworthy change date: require a change when enabled.
  if (!Number.isSafeInteger(changedAt) || changedAt! <= 0 || changedAt! > now) return true;
  let due: number;
  if (policy.unit === 'days') due = changedAt! + policy.interval * 86_400_000;
  else {
    // Preserve the MYT wall-clock time and clamp month ends (31 January -> 28/29 February).
    const [year, month, day] = todayInKualaLumpur(new Date(changedAt!)).split('-').map(Number);
    const target = new Date(Date.UTC(year, month - 1 + policy.interval, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const start = Date.UTC(year, month - 1, day) - 8 * 3600_000;
    due = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)) - 8 * 3600_000 + (changedAt! - start);
  }
  return now >= due;
}
