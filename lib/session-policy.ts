/** ADR-0171 idle sign-out policy: the bounds and the default, shared by the owner, the editor and the shell. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;
export const MIN_IDLE_TIMEOUT_MINUTES = 5;
/** The absolute web session lifetime (lib/internal-auth/service.ts SESSION_LIFE); idle cannot outlast it. */
export const MAX_IDLE_TIMEOUT_MINUTES = 480;
/** How long before sign-out the shell warns, and how often activity is reported at most. */
export const IDLE_WARNING_SECONDS = 60;
export const ACTIVITY_REPORT_INTERVAL_SECONDS = 60;

export function validateIdleTimeoutMinutes(value: unknown): number {
  const minutes = typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_IDLE_TIMEOUT_MINUTES || minutes > MAX_IDLE_TIMEOUT_MINUTES)
    throw new Error('invalid');
  return minutes;
}
