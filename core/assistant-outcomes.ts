/**
 * ADR-0151 §4.6c — outcome measurement per Assistant action kind, and the ADR-0131 before/after per process.
 * Deterministic: every figure is a count from the prepared-action store or the Phase 1 assessment queries.
 * No model participates and nothing here changes data.
 *
 * SCOPE IS THE CALLER'S. The store is closed to the app role, so counts come from one read-only definer
 * (`app.assistant_action_outcome_summary`, migration 0674) that counts a row only when the caller administers
 * its company, and a row without a company only for a group administrator. Process measures reuse the
 * assessment's RLS-scoped queries. Only counts and the first-use date leave the store.
 *
 * WHAT IS NOT MEASURED. Offers (a handoff or card shown), edits before confirmation and failed confirmations
 * are not recorded by any source: digests are cleared when a review leaves its pending state and a failed
 * confirmation rolls back. They are reported as unmeasured, never as zero. "Reversed" is reported only for
 * kinds whose canonical row or event can prove it (the definer returns null otherwise), and it is an
 * observation about the native record, not a claim that the Assistant caused it.
 */
import { sql } from 'drizzle-orm';
import { lifecycleChaseOutcomeTx } from './automatic-followups';
import { withTenant, type SessionContext } from '../db/client';
import { isAdmin } from '../lib/authz-model';
import { NATIVE_REVIEW_ACTIONS, NATIVE_OUTCOME_ACTIONS, type NativeOutcomeAction } from '../lib/ai/module-native-outcomes';
import { agentActionsByTier } from '../lib/ai/agent-action-registry';
import { isModuleEnabled } from './entitlements';
import { PROCESS_PROFILES, measure, windowStart, type AssessmentWindow, type ProcessId } from './process-assessment';

export const OUTCOME_VERSION = 'outcomes-v1';
/** Below this many days after first use a 30-day rate extrapolates from too little time. */
export const MIN_AFTER_DAYS = 14;
const DAY = 86_400_000;

/**
 * Which ADR-0131 process each Assistant action does handling work in. Reviewed table: a kind that is not listed
 * still gets its outcome row, it just takes no part in a process before/after.
 */
export const ACTION_PROCESS: Partial<Record<NativeOutcomeAction, ProcessId>> = {
  'leave.apply': 'leave', 'leave.cancel': 'leave', 'leave.edit': 'leave', 'approvals.leave.decide': 'leave',
  'claims.submit': 'claims', 'claims.draft.save': 'claims', 'claims.cancel': 'claims', 'approvals.claim.decide': 'claims',
  'attendance.correction.request': 'attendance_correction', 'approvals.attendance.decide': 'attendance_correction',
  'ess.profile.request': 'profile_change',
};

export type ActionOutcome = {
  action: string; module: string | null;
  prepared: number; awaiting: number; completed: number; discarded: number; expired: number; refused: number;
  /** Null when the canonical records cannot prove a reversal for this kind. */
  reversed: number | null;
  firstPreparedAt: Date | null;
};

/**
 * WP13 — an Automatic-tier reminder kind (registry tier `automatic`). Counts from the chase receipts the agent
 * principal wrote (`app.automatic_chase_outcome_summary`, 0697), scoped to the caller's administered companies.
 * `acted` = chased items no longer waiting at the chased stage now; an observation, not proof the reminder caused it.
 */
export type AutomaticOutcome = { action: string; module: string; chased: number; items: number; acted: number; waiting: number; firstChasedAt: Date | null };
type AutomaticRow = { action_id: string; chased: number; items: number; acted: number | null; waiting: number | null; first_chased_at: string | Date | null; lifecycle_stages: unknown };

export type Period = { from: Date; to: Date; days: number; started: number; staffActions: number; per30: number };

export type ProcessComparison = {
  id: ProcessId; actions: string[]; enabled: boolean; linked: boolean;
  /** First Assistant preparation of any mapped kind in the caller's scope; null = no Assistant use yet. */
  firstUse: Date | null;
  before: Period | null; after: Period | null;
  /** The after period is shorter than MIN_AFTER_DAYS. */
  early: boolean;
  /** Assistant confirmations of the mapped kinds that were prepared in the after period. */
  assistantCompleted: number;
};

type Row = { action_kind: string; prepared: number; awaiting: number; completed: number; discarded: number;
  expired: number; refused: number; reversed: number | null; first_prepared_at: string | Date | null };

export function per30(count: number, days: number) {
  return days > 0 ? Math.round(count * 30 / days * 10) / 10 : 0;
}

/**
 * Before = the same length of time immediately before the first Assistant use; after = from first use (or the
 * window start, if first use is older) to now. Equal lengths keep the two rates comparable.
 */
export function comparisonPeriods(firstUse: Date, windowFrom: Date, now: Date) {
  const afterFrom = firstUse > windowFrom ? firstUse : windowFrom;
  const length = now.getTime() - afterFrom.getTime();
  return { before: { from: new Date(firstUse.getTime() - length), to: firstUse }, after: { from: afterFrom, to: now }, days: length / DAY };
}

export async function assistantOutcomes(ctx: SessionContext, window: AssessmentWindow) {
  if (!isAdmin(ctx)) throw new Error('Only HR administrators may view Assistant outcomes.');
  return withTenant(ctx, async tx => {
    const from = await windowStart(tx, window);
    const rows = await tx.execute<Row>(sql`select * from app.assistant_action_outcome_summary(${from.toISOString()}::timestamptz)`);
    const byKind = new Map(rows.map(r => [r.action_kind, r]));
    // Every reviewable kind in the catalogue, plus any kind the store already holds that the catalogue has not
    // listed yet, so a newly added kind is never silently dropped.
    const kinds = [...new Set([...NATIVE_REVIEW_ACTIONS, ...byKind.keys()])];
    const actions: ActionOutcome[] = kinds.map(action => {
      const r = byKind.get(action);
      const module = Object.hasOwn(NATIVE_OUTCOME_ACTIONS, action) ? NATIVE_OUTCOME_ACTIONS[action as NativeOutcomeAction].module : null;
      return { action, module, prepared: r?.prepared ?? 0, awaiting: r?.awaiting ?? 0, completed: r?.completed ?? 0,
        discarded: r?.discarded ?? 0, expired: r?.expired ?? 0, refused: r?.refused ?? 0,
        reversed: r ? r.reversed : null, firstPreparedAt: r?.first_prepared_at ? new Date(r.first_prepared_at) : null };
    });
    // Most used first; unused kinds keep catalogue order at the end.
    actions.sort((a, b) => b.prepared - a.prepared);

    const now = new Date();
    const processes: ProcessComparison[] = [];
    for (const id of [...new Set(Object.values(ACTION_PROCESS))]) {
      const mapped = actions.filter(a => ACTION_PROCESS[a.action as NativeOutcomeAction] === id);
      const profile = PROCESS_PROFILES[id];
      const enabled = profile.module == null || isModuleEnabled(ctx, profile.module);
      const uses = mapped.map(a => a.firstPreparedAt).filter((d): d is Date => d != null);
      const firstUse = uses.length ? new Date(Math.min(...uses.map(d => d.getTime()))) : null;
      let before: Period | null = null, after: Period | null = null, early = false;
      if (firstUse && enabled && profile.actionsLinked) {
        const p = comparisonPeriods(firstUse, from, now);
        const [b, a] = [await measure(tx, id, p.before.from, p.before.to), await measure(tx, id, p.after.from)];
        before = { ...p.before, days: p.days, started: b.started, staffActions: b.staffActions, per30: per30(b.staffActions, p.days) };
        after = { ...p.after, days: p.days, started: a.started, staffActions: a.staffActions, per30: per30(a.staffActions, p.days) };
        early = p.days < MIN_AFTER_DAYS;
      }
      // Window counts cover the selected window; when first use is older than the window they coincide with
      // the after period, otherwise every preparation in the window is already after first use.
      processes.push({ id, actions: mapped.map(a => a.action), enabled, linked: profile.actionsLinked, firstUse, before, after, early,
        assistantCompleted: mapped.reduce((n, a) => n + a.completed, 0) });
    }
    const automaticRows = await tx.execute<AutomaticRow>(sql`select a.*,CASE WHEN a.action_id='lifecycle.step.chase' THEN (select coalesce(jsonb_agg(jsonb_build_object('itemId',r.item_id,'stage',r.stage)),'[]'::jsonb) from app.automatic_lifecycle_chased_stages(${from.toISOString()}::timestamptz) r) END AS lifecycle_stages from app.automatic_chase_outcome_summary(${from.toISOString()}::timestamptz) a`);
    const lifecycleRow=automaticRows.find(r=>r.action_id==='lifecycle.step.chase');
    const lifecycle=lifecycleRow?await lifecycleChaseOutcomeTx(tx,lifecycleRow.lifecycle_stages):{acted:0,waiting:0};
    const automaticById = new Map(Array.from(automaticRows).map(r => [r.action_id, r]));
    // Every registered Automatic entry, in registry order, so an unused reminder shows as unused rather than absent.
    const automatic: AutomaticOutcome[] = agentActionsByTier('automatic').map(entry => {
      const r = automaticById.get(entry.id);
      return { action: entry.id, module: entry.module, chased: r?.chased ?? 0, items: r?.items ?? 0, acted: entry.id==='lifecycle.step.chase'?lifecycle.acted:r?.acted ?? 0,
        waiting: entry.id==='lifecycle.step.chase'?lifecycle.waiting:r?.waiting ?? 0, firstChasedAt: r?.first_chased_at ? new Date(r.first_chased_at) : null };
    });
    return { version: OUTCOME_VERSION, window, from, actions, processes, automatic };
  });
}
