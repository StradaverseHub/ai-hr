import 'server-only';
import type { SessionContext } from '../db/client';
import { packFor } from '../localization/registry';
import { latestAvailablePackVersion } from './statutory-pack-available';

/**
 * Whether a newer statutory pack file is present on disk but not yet ingested — the same staleness HINT
 * the /payroll/configuration page shows (ADR-0020 §8). This is a `server-only` filesystem read, so it
 * lives OUTSIDE core/payroll-readiness.ts (which stays pure/testable); pages compute it here and pass the
 * boolean into payrollReadiness. Best-effort: no pack (or no disk files) ⇒ not stale.
 */
export async function statutoryPackStale(ctx: SessionContext, country = 'MY'): Promise<boolean> {
  const pack = packFor(country);
  if (!pack) return false;
  const sync = await pack.statutoryConfig.syncStatus(ctx);
  const available = latestAvailablePackVersion();
  return !!(available && (!sync.latestIngested || available > sync.latestIngested));
}
