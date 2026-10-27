/**
 * WP-B1 (APR-020) — pure model of the Calibration destination (no database imports, so screens and DOM tests
 * can import it). The reading service is calibration-list.ts.
 */
import { todayInKualaLumpur } from '../../../lib/hr-date';
import type { Policy, Tier, WindowCell } from './model';
import { assessmentWorkWindowOpen, leaderPendingEntries, leaderWorkspaceParts, type CalibrationWorkEntry } from './workspace-model';

/** Display order of the tier groups on the Calibration page: Group, BG, BU, Department (HOD), Final. */
export const calibrationListTierOrder = ['group', 'bg', 'bu', 'hod', 'final'] as const satisfies readonly Tier[];

export type CalibrationWindowState = 'open' | 'upcoming' | 'closed';
export type CalibrationLockState = 'open' | 'partial' | 'locked';
export type CalibrationListSession = {
  id: string;
  name: string;
  tier: Tier;
  cycleId: string;
  cycleName: string;
  cycleClosed: boolean;
  /** Company label of a company-scoped session; null for a cross-company (group-wide) session. */
  companyName: string | null;
  /** 'open' while this tier's decision window is open now (or the tier has no window and the cycle is live). */
  window: CalibrationWindowState;
  /** Kuala Lumpur calendar dates of the governing window, when the cycle policy sets them. */
  opensOn: string | null;
  closesOn: string | null;
  people: number;
  toDo: number;
  lock: CalibrationLockState;
  href: string;
};

/** The policy window cells that govern a tier's decisions — the same cells the calibration writer asserts. */
export function calibrationWindowCells(policy: Pick<Policy, 'modules' | 'kind'>, tier: Tier): WindowCell[] {
  const pm = policy.modules.pm && policy.kind !== 'quarterly', pot = !!policy.modules.tm;
  if (tier === 'hod') return [...(pm ? ['pm_hod' as const] : []), ...(pot ? ['pot_hod' as const] : [])];
  if (tier === 'bu') return [...(pm ? ['pm_buceo' as const] : []), ...(pot ? ['pot_buceo' as const] : [])];
  if (tier === 'bg') return ['tb_bgceo'];
  return [];
}

/** Window state for one session. A tier without a window cell (Group, Final) is open while the cycle is live. */
export function calibrationWindowState(policy: Pick<Policy, 'modules' | 'kind' | 'windows'>, tier: Tier, cycleClosed: boolean, now = new Date()) {
  const cells = calibrationWindowCells(policy, tier);
  const windows = cells.map((cell) => policy.windows[cell]).filter((w): w is NonNullable<typeof w> => !!w);
  const day = (at: string | null) => (at ? todayInKualaLumpur(new Date(at)) : null);
  const opensAt = windows.map((w) => w.opensAt).filter((v): v is string => !!v).sort((x, y) => Date.parse(x) - Date.parse(y));
  const closesAt = windows.map((w) => w.closesAt).filter((v): v is string => !!v).sort((x, y) => Date.parse(x) - Date.parse(y));
  let window: CalibrationWindowState;
  if (cycleClosed) window = 'closed';
  else if (!cells.length || cells.some((cell) => assessmentWorkWindowOpen(policy, cell, now))) window = 'open';
  else window = cells.some((cell) => { const at = policy.windows[cell]?.opensAt; return !!at && now.getTime() < Date.parse(at); }) ? 'upcoming' : 'closed';
  return { window, opensOn: day(opensAt[0] ?? null), closesOn: day(closesAt[closesAt.length - 1] ?? null) };
}

/** People still awaiting this tier's decision, using the workspace's own part/pending derivation. */
export function calibrationToDo(policy: Pick<Policy, 'modules' | 'kind'>, tier: Tier, locks: { lockedAt: unknown; performanceLockedAt: unknown; potentialLockedAt: unknown }, entries: CalibrationWorkEntry[]): number {
  const pending = new Set<string>();
  for (const part of leaderWorkspaceParts(policy, tier, locks)) {
    if (part.state !== 'open') continue;
    for (const entry of leaderPendingEntries(policy, tier, part.axis, entries)) pending.add(entry.reviewId);
  }
  return pending.size;
}

const windowRank: Record<CalibrationWindowState, number> = { open: 0, upcoming: 1, closed: 2 };
/** Open windows first, then upcoming, then closed; stable within a state. */
export function sortCalibrationSessions(rows: CalibrationListSession[]): CalibrationListSession[] {
  return [...rows].sort((a, b) => windowRank[a.window] - windowRank[b.window]);
}
