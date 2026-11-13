import type { getRewardUnit } from '@/packs/rewards/service';
import { isSeniorPlanMember, type RewardFlag } from '@/packs/rewards/model';
import { payWindowReasons, sum } from '@/packs/rewards/engine';

/**
 * 37f82412 — the Review tab's People table, worked out on the server.
 *
 * Every figure here is copied from the calculated review projection (getRewardUnit): this module only picks
 * fields, filters and adds up integer cents for the Total row. It runs in server components and server
 * actions, so the client grid never calculates pay; it shows what the server returned after each save.
 */
export type RewardView = Awaited<ReturnType<typeof getRewardUnit>>;
type ViewRow = RewardView['rows'][number];

/** Quick filters above the table. They live in the address so the server filters the whole review. */
export type DeskFilters = { q?: string; f?: 'flags' | 'promotion'; talent?: string; perf?: string; jg?: string; plan?: 'standard' | 'h' };
export const DESK_FILTER_KEYS = ['q', 'f', 'talent', 'perf', 'jg', 'plan'] as const;
const short = (value: unknown, max = 80) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined;
export function parseDeskFilters(raw: Partial<Record<string, unknown>>): DeskFilters {
  const f = raw.f === 'flags' || raw.f === 'promotion' ? raw.f : undefined;
  const plan = raw.plan === 'standard' || raw.plan === 'h' ? raw.plan : undefined;
  return { ...(short(raw.q, 200) ? { q: short(raw.q, 200) } : {}), ...(f ? { f } : {}), ...(short(raw.talent, 10) ? { talent: short(raw.talent, 10) } : {}),
    ...(short(raw.perf, 10) ? { perf: short(raw.perf, 10) } : {}), ...(short(raw.jg, 30) ? { jg: short(raw.jg, 30) } : {}), ...(plan ? { plan } : {}) };
}
export function filterDeskRows<T extends Pick<ViewRow, 'id' | 'plan' | 'source' | 'facts' | 'recommendation'>>(rows: readonly T[], flags: readonly Pick<RewardFlag, 'entryId'>[], filters: DeskFilters): T[] {
  const flagged = new Set(flags.map(flag => flag.entryId).filter(Boolean));
  const q = filters.q?.toLowerCase();
  return rows.filter(row => (!q || `${row.source.name} ${row.source.employeeCode}`.toLowerCase().includes(q))
    && (filters.f !== 'flags' || flagged.has(row.id))
    && (filters.f !== 'promotion' || !!row.recommendation.promotionGrade)
    && (!filters.talent || row.facts.talent === filters.talent)
    && (!filters.perf || row.facts.performance === filters.perf)
    && (!filters.jg || row.source.grade === filters.jg)
    && (!filters.plan || row.plan === filters.plan));
}

export type DeskFlagMark = 'block' | 'warn' | null;
/** One People-table row: values for display plus which cells the viewer may change. */
export type DeskRow = {
  id: string; name: string; employeeCode: string; grade: string; promotionGrade: string | null;
  talent: string | null; performance: string | null; plan: 'standard' | 'h' | 'ec';
  basicCents: number; crBeforeBp: number | null;
  meritBp: number | null; promotionBp: number | null; specialBp: number | null; totalIncreaseBp: number | null;
  newBasicCents: number | null; crAfterBp: number | null;
  bonusMonthsBp: number | null; multiplierBp: number | null; bonusCents: number | null; lumpCents: number;
  /** Which values are this person's own overrides (highlighted, with Reset). */
  overrides: { meritBp: boolean; promotionBp: boolean; specialBp: boolean; multiplierBp: boolean; lumpCents: boolean; promotionGrade: boolean };
  /** The stored overrides themselves, for the edit inputs. */
  inputs: { meritBp: number | null; promotionBp: number | null; specialBp: number | null; multiplierBp: number | null; lumpCents: number | null; promotionGrade: string | null };
  editable: { increase: boolean; bonus: boolean; lump: boolean };
  promotionGrades: string[];
  flag: DeskFlagMark; flagCount: number; unverified: boolean; leftOn: string | null;
};

/** Whether this viewer may change recommendations in the table at the review's current step. The review
 *  owner (saveRewardEntry) still decides every save; this only decides which cells offer an input. */
export function deskCellsEditable(v: Pick<RewardView, 'uploaded' | 'canEdit' | 'roles' | 'approvalStageEdit'> & { unit: Pick<RewardView['unit'], 'kind' | 'status'> }) {
  if (v.uploaded || v.unit.kind !== 'annual' || !v.canEdit) return false;
  return v.unit.status === 'draft' || (v.unit.status === 'bg' && v.roles.includes('bg')) || !!v.approvalStageEdit;
}

export function deskRow(v: RewardView, r: ViewRow, flags: readonly RewardFlag[]): DeskRow {
  const senior = isSeniorPlanMember(v.unit.policy, r.facts, r.source.grade);
  const hidden = senior && !v.seniorAmountsVisible;
  const cells = deskCellsEditable(v) && !senior && r.plan !== 'ec' && !r.source.leftOn;
  const own = flags.filter(flag => flag.entryId === r.id);
  const rec = r.recommendation;
  const grades = Object.keys(v.unit.policy.ranges ?? {}).filter(g => { const jump = Number(g) - Number(r.source.grade); return Number.isInteger(jump) && jump >= 1 && jump <= 3; }).sort((a, b) => Number(a) - Number(b));
  return {
    id: r.id, name: r.source.name, employeeCode: r.source.employeeCode, grade: r.source.grade, promotionGrade: rec.promotionGrade,
    talent: r.facts.talent, performance: r.facts.performance, plan: r.plan,
    basicCents: r.source.basicCents, crBeforeBp: r.crBeforeBp ?? null,
    meritBp: hidden ? null : r.meritBp, promotionBp: hidden ? null : r.promotionBp, specialBp: hidden ? null : r.specialBp,
    totalIncreaseBp: hidden ? null : r.totalIncreaseBp ?? null,
    newBasicCents: hidden ? null : r.newBasicCents, crAfterBp: r.crAfterBp ?? null,
    bonusMonthsBp: hidden ? null : r.bonusMonthsBp ?? null, multiplierBp: hidden ? null : r.bonusMultiplierBp, bonusCents: hidden ? null : r.bonusCents, lumpCents: r.lumpCents,
    overrides: { meritBp: rec.meritBp != null, promotionBp: rec.promotionBp != null, specialBp: rec.specialBp != null, multiplierBp: rec.multiplierBp != null, lumpCents: rec.lumpCents != null, promotionGrade: !!rec.promotionGrade },
    inputs: { meritBp: rec.meritBp, promotionBp: rec.promotionBp, specialBp: rec.specialBp, multiplierBp: rec.multiplierBp, lumpCents: rec.lumpCents, promotionGrade: rec.promotionGrade },
    editable: {
      increase: cells && !(r.payChange && payWindowReasons.includes(r.incrementReason)),
      bonus: cells && r.bonusEligible,
      lump: cells && r.lumpEligible,
    },
    promotionGrades: grades,
    flag: own.some(flag => flag.severity === 'block') ? 'block' : own.length ? 'warn' : null, flagCount: own.length,
    unverified: !r.facts.reviewed, leftOn: r.source.leftOn ?? null,
  };
}

export type DeskTotals = { people: number; basicCents: number; newBasicCents: number; bonusCents: number; lumpCents: number };
export function deskTotals(rows: readonly DeskRow[]): DeskTotals {
  return { people: rows.length, basicCents: sum(rows.map(r => r.basicCents)), newBasicCents: sum(rows.map(r => r.newBasicCents ?? r.basicCents)),
    bonusCents: sum(rows.map(r => r.bonusCents ?? 0)), lumpCents: sum(rows.map(r => r.lumpCents)) };
}

export type DeskPlanBudget = { salaryUsedCents: number; salaryPoolCents: number; bonusUsedCents: number; bonusPoolCents: number };
/** The three summary tiles. Pools and use come straight from the calculated budgets. */
export type DeskSummary = {
  plans: Record<'standard' | 'h', DeskPlanBudget>;
  /** The unit multiplier applied (value only), or null under branch factors. */
  multiplierBp: number | null;
  lump: { perPersonCents: number; people: number; totalCents: number; mode: 'auto' | 'set' | 'withhold' };
  blocks: number; warnings: number; flags: number;
};
export function deskSummary(v: RewardView): DeskSummary {
  const plan = (p: 'standard' | 'h'): DeskPlanBudget => ({ salaryUsedCents: sum(v.budgets[p].used), salaryPoolCents: sum(v.budgets[p].pools), bonusUsedCents: v.budgets[p].bonusUsedCents, bonusPoolCents: v.budgets[p].bonusPoolCents });
  const policy = v.unit.policy;
  return {
    plans: { standard: plan('standard'), h: plan('h') },
    multiplierBp: policy.bonusStructure === 'branch' ? null : policy.multiplierBp ?? v.suggestedMultiplierBp,
    lump: { perPersonCents: v.lumpUnitCents ?? v.suggestedLumpCents, people: v.budgets.standard.lumpCount + v.budgets.h.lumpCount,
      totalCents: v.budgets.standard.lumpCents + v.budgets.h.lumpCents, mode: policy.lumpUnitCents == null ? 'auto' : policy.lumpUnitCents === 0 ? 'withhold' : 'set' },
    blocks: v.flags.filter(f => f.severity === 'block').length,
    warnings: v.flags.filter(f => f.severity === 'exception' || f.severity === 'warning').length,
    flags: v.flags.length,
  };
}
