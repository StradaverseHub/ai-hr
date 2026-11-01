/** ADR-0171: the idle limit as the sign-in service and the shell read it, before any tenant context exists. */
import { DEFAULT_IDLE_TIMEOUT_MINUTES, validateIdleTimeoutMinutes } from './session-policy';

const CACHE_MS = 60_000;
const cached = new Map<string, { minutes: number; at: number }>();

/** An administrator's change reaches every server process within CACHE_MS; this process sees it at once. */
export function forgetIdleTimeout(tenantId: string) { cached.delete(tenantId); }

/** Never fails open: an unreadable policy enforces the default rather than no limit. */
export async function idleTimeoutMinutesFor(tenantId: string): Promise<number> {
  const hit = cached.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.minutes;
  let minutes = DEFAULT_IDLE_TIMEOUT_MINUTES;
  try {
    const { client } = await import('../db/client');
    const rows = await client.unsafe('select app.session_idle_timeout_minutes($1::uuid) as minutes', [tenantId]);
    minutes = validateIdleTimeoutMinutes(rows[0]?.minutes);
  } catch {
    console.error('Idle sign-out policy unreadable; enforcing the default limit.');
  }
  cached.set(tenantId, { minutes, at: Date.now() });
  return minutes;
}
