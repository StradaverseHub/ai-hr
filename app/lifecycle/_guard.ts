import { redirect } from 'next/navigation';
import { requireModule } from '@/lib/authz';
import { myLifecycleLevel, LEVEL } from '@/packs/lifecycle/service';
import type { SessionContext } from '@/db/client';

/**
 * Every lifecycle screen opens here. `requireModule` is the courtesy redirect (ADR-0077 D3: the service
 * layer is the control); the level is the module's own staff level (0 requester, 1 agent, 2 manager, 3 admin),
 * so a requester who types a staff address is sent to the hub instead of an error.
 */
export async function lifecycleSession(min: number = 0): Promise<{ s: SessionContext; level: number }> {
  const s = await requireModule('lifecycle');
  const level = await myLifecycleLevel(s);
  if (level < min) redirect('/lifecycle');
  return { s, level };
}

export { LEVEL };
