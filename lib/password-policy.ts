import { z } from 'zod';
import { todayInKualaLumpur } from './hr-date';

export const passwordRequirementsSchema = z.object({
  minLength: z.number().int().min(1).max(128), maxLength: z.number().int().min(1).max(128),
  uppercase: z.boolean(), lowercase: z.boolean(), numbers: z.boolean(), special: z.boolean(),
  historyEnabled: z.boolean(), historyCount: z.number().int().min(1).max(100),
  lockoutEnabled: z.boolean(), failedAttempts: z.number().int().min(1).max(100),
  autoUnlock: z.boolean(), unlockMinutes: z.number().int().min(1).max(10080),
  forceFirstChange: z.boolean(), firstResetVerification: z.boolean(),
}).strict().refine(value => value.minLength <= value.maxLength && (!value.autoUnlock || value.lockoutEnabled));
export type PasswordRequirements = z.infer<typeof passwordRequirementsSchema>;
export const NEW_PASSWORD_REQUIREMENTS: PasswordRequirements = {
  minLength: 8, maxLength: 32, uppercase: false, lowercase: false, numbers: false, special: false,
  historyEnabled: false, historyCount: 5, lockoutEnabled: false, failedAttempts: 5,
  autoUnlock: false, unlockMinutes: 15, forceFirstChange: true, firstResetVerification: false,
};
/** No requirements means the installed legacy contract remains authoritative until explicit save. */
export const LEGACY_PASSWORD_REQUIREMENTS: PasswordRequirements = {...NEW_PASSWORD_REQUIREMENTS, minLength:14, maxLength:128, historyEnabled:true, historyCount:100};
export function passwordMeetsRequirements(password:string, requirements:PasswordRequirements, username='',email='') {
 const length=Array.from(password).length,lower=password.toLowerCase();
 return length>=requirements.minLength && length<=requirements.maxLength && password.length<=128 &&
  new TextEncoder().encode(password).length<=512 && !password.includes('\u0000') &&
  !(username&&lower.includes(username.toLowerCase())) && !(email&&lower.includes(email.toLowerCase())) &&
  (!requirements.uppercase||/[A-Z]/.test(password)) && (!requirements.lowercase||/[a-z]/.test(password)) &&
  (!requirements.numbers||/[0-9]/.test(password)) && (!requirements.special||/[^A-Za-z0-9\s]/.test(password));
}
const policySchema = z.object({
  enabled: z.boolean(),
  interval: z.number().int().min(1).max(3650),
  unit: z.enum(['days', 'months']),
  requirements: passwordRequirementsSchema.optional(),
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
