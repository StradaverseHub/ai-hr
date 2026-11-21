/** ADR-0171: the idle limit as the sign-in service and the shell read it, before any tenant context exists. */
import { DEFAULT_IDLE_TIMEOUT_MINUTES, validateIdleTimeoutMinutes } from './session-policy';

const CACHE_MS = 60_000;
const cached = new Map<string, { minutes: number; at: number }>();
const loading = new Map<string, Promise<number>>();

/** An administrator's change reaches every server process within CACHE_MS; this process sees it at once. */
export function forgetIdleTimeout(tenantId: string) {
  cached.delete(tenantId);
  loading.delete(tenantId);
}

/** The native policy-read fallback stays with its existing owner. Unstarted work
 * and cancellation cannot manufacture a successful policy or enter the cache. */
export async function idleTimeoutMinutesFor(tenantId: string): Promise<number> {
  const hit = cached.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.minutes;
  const existing = loading.get(tenantId);
  if (existing) return existing;
  const read:Promise<number> = readIdleTimeout(tenantId).then(minutes => {
    // An invalidation can replace this load while the database is responding.
    if (loading.get(tenantId) === read) {
      cached.set(tenantId, { minutes, at: Date.now() });
      loading.delete(tenantId);
    }
    return minutes;
  },error=>{
    if(loading.get(tenantId)===read)loading.delete(tenantId);
    throw error;
  });
  loading.set(tenantId, read);
  return read;
}

async function readIdleTimeout(tenantId: string): Promise<number> {
  const { client,withPoolWork } = await import('../db/client');
  // Admission is outside the SQL fallback. It has not read a policy yet.
  return withPoolWork(tenantId,async()=>{
    try {
      const rows=await client.unsafe('select app.session_idle_timeout_minutes($1::uuid) as minutes',[tenantId]);
      return validateIdleTimeoutMinutes(rows[0]?.minutes);
    }catch{
      console.error('Idle sign-out policy unreadable; enforcing the default limit.');
      return DEFAULT_IDLE_TIMEOUT_MINUTES;
    }
  });
}
