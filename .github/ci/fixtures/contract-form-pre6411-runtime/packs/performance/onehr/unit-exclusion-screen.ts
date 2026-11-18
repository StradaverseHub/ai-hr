/**
 * D-P1-22 X5 (ADR-0150, APR-024): the read projections behind the "Units not taking part" card on the cycle page.
 *
 * Read-only. Authority, the plan and every number stay with unit-exclusion-service.ts and its database
 * projection; this module only adds the labels the screen draws (names through app.onehr_person_labels, the
 * caller's own projection, as the facts function asks) and the company and department choices.
 *
 * - getUnitExclusionScreen: the rules (listUnitExclusionRules) with the names of who set and ended them, whether
 *   the viewer may change them now, and, for a writer in an open or calibration cycle only, the companies in the
 *   cycle's scope with the departments that hold people today and their counts (app.onehr_unit_exclusion_choices,
 *   0667: the facts headcount's placement rule, so an offered department is never refused as empty).
 * - previewUnitExclusionScreen: previewUnitExclusion's plan unchanged (digest, revision and counts as returned),
 *   reduced to what the screen shows, with names for the employment ids it lists. The per-seat-type counts and
 *   the submitted places are counts of the plan's own rows, never computed from anything else.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { appUser, company, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { onehrLabel } from './person-labels';
import { listUnitExclusionRules, previewUnitExclusion, type UnitExclusionScope } from './unit-exclusion-service';
import type { UnitExclusionPlan } from './unit-exclusion-model';

const uuid = z.uuid();
const WRITABLE_STATUSES = ['open', 'calibration'];

export type UnitExclusionRuleView = {
  id: string; companyId: string; companyName: string | null; departmentId: string | null; departmentName: string | null;
  createdByName: string | null; createdAt: string; endedByName: string | null; endedAt: string | null;
  endReason: 'brought_back' | 'subsumed' | null; active: boolean;
};
export type UnitExclusionChoice = { id: string; name: string; departments: { id: string; name: string; people: number }[] };
export type UnitExclusionScreen = {
  cycle: { id: string; name: string; status: string; revision: number };
  /** The backend's writer flag (a tenant-wide HR administrator). */
  canWrite: boolean;
  /** canWrite and the cycle is open or in calibration: the only state with write controls. */
  editable: boolean;
  rules: UnitExclusionRuleView[];
  /** Companies in the cycle's scope with their departments that hold people today; empty unless editable. */
  companies: UnitExclusionChoice[];
};
export type UnitExclusionPreviewView = {
  companyId: string; departmentId: string | null; digest: string; revision: number;
  /** An identical rule is already active: the save writes nothing. */
  alreadyActive: boolean;
  /** Department rules of the same company a whole-company save ends as subsumed. */
  subsumed: number;
  counts: UnitExclusionPlan['counts'];
  /** Archived places on others' panels whose rating was submitted (plan.archive rows, side 'place'). */
  submittedPlaces: number;
  oneLevelUp: { reviewId: string; person: string | null; from: string | null; to: string | null }[];
  nobodyAbove: { reviewId: string; person: string | null; reason: 'review' | 'kpi' }[];
  /** Leader seats held by people in the scope, per seat type (plan.seats.seatsOut rows). */
  seatsByType: { seatType: string; count: number }[];
  /** Department calibration sessions anchored on a head of department in the scope (plan.seats.hodSessionsOut rows). */
  hodSessionsOut: number;
};

async function employmentNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)].filter((id) => uuid.safeParse(id).success);
  if (!wanted.length) return new Map();
  const rows = await tx.execute<{ id: string; name: string | null }>(sql`select l.employment_id::text as id, l.full_name as name
    from app.onehr_person_labels(array[${sql.join(wanted.map((id) => sql`${id}::uuid`), sql`,`)}]::uuid[]) l`);
  return new Map(rows.flatMap((r) => (r.name ? [[r.id, r.name] as const] : [])));
}
async function userNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const rows = await tx.select({ id: appUser.id, name: onehrLabel.fullNameForPerson(appUser.personId) }).from(appUser).where(inArray(appUser.id, wanted));
  return new Map(rows.flatMap((r) => (r.name ? [[r.id, r.name] as const] : [])));
}
const iso = (value: Date | string | null | undefined) => (value == null ? null : (value instanceof Date ? value : new Date(value)).toISOString());

export async function getUnitExclusionScreen(ctx: SessionContext, cycleId: string): Promise<UnitExclusionScreen> {
  uuid.parse(cycleId);
  const listed = await listUnitExclusionRules(ctx, cycleId);
  const editable = listed.canWrite && WRITABLE_STATUSES.includes(listed.cycle.status);
  return withPerformanceTenant(ctx, async (tx) => {
    const users = await userNames(tx, listed.rules.flatMap((r) => [r.createdBy, ...(r.endedBy ? [r.endedBy] : [])]));
    const companies: UnitExclusionChoice[] = [];
    if (editable) {
      const [cycle] = await tx.select({ companyId: reviewCycle.companyId }).from(reviewCycle).where(eq(reviewCycle.id, cycleId));
      const units = await tx.select({ id: company.id, name: company.legalName }).from(company)
        .where(and(sql`app.onehr_admin(${company.id})`, cycle?.companyId ? eq(company.id, cycle.companyId) : undefined))
        .orderBy(asc(company.legalName), asc(company.id));
      for (const u of units) {
        const departments = await tx.execute<{ id: string; name: string; people: number }>(sql`select c.department_id::text as id, c.department_name as name, c.people
          from app.onehr_unit_exclusion_choices(${cycleId}::uuid, ${u.id}::uuid) c order by c.department_name, c.department_id`);
        companies.push({ id: u.id, name: u.name, departments: departments.map((d) => ({ id: d.id, name: d.name, people: Number(d.people) })) });
      }
    }
    return {
      cycle: { id: listed.cycle.id, name: listed.cycle.name, status: listed.cycle.status, revision: listed.cycle.revision },
      canWrite: listed.canWrite, editable, companies,
      rules: listed.rules.map((r) => ({
        id: r.id, companyId: r.companyId, companyName: r.companyName ?? null, departmentId: r.departmentId, departmentName: r.departmentName ?? null,
        createdByName: users.get(r.createdBy) ?? null, createdAt: iso(r.createdAt) ?? '', endedByName: r.endedBy ? users.get(r.endedBy) ?? null : null,
        endedAt: iso(r.endedAt), endReason: r.endReason === 'brought_back' || r.endReason === 'subsumed' ? r.endReason : null, active: r.active,
      })),
    };
  });
}

export async function previewUnitExclusionScreen(ctx: SessionContext, cycleId: string, scope: UnitExclusionScope): Promise<UnitExclusionPreviewView> {
  const plan = await previewUnitExclusion(ctx, cycleId, scope);
  const names = await withPerformanceTenant(ctx, (tx) => employmentNames(tx, [
    ...plan.oneLevelUp.flatMap((r) => [r.employmentId, r.to, ...(r.from ? [r.from] : [])]),
    ...plan.nobodyAbove.map((r) => r.employmentId),
  ]));
  const seatTypes = new Map<string, number>();
  for (const seat of plan.seats.seatsOut) seatTypes.set(seat.seatType, (seatTypes.get(seat.seatType) ?? 0) + 1);
  return {
    companyId: plan.companyId, departmentId: plan.departmentId, digest: plan.digest, revision: plan.revision,
    alreadyActive: !!plan.alreadyActiveRuleId, subsumed: plan.subsumedRuleIds.length, counts: plan.counts,
    submittedPlaces: plan.archive.filter((a) => a.side === 'place' && a.submitted).length,
    oneLevelUp: plan.oneLevelUp.map((r) => ({ reviewId: r.reviewId, person: names.get(r.employmentId) ?? null, from: r.from ? names.get(r.from) ?? null : null, to: names.get(r.to) ?? null })),
    nobodyAbove: plan.nobodyAbove.map((r) => ({ reviewId: r.reviewId, person: names.get(r.employmentId) ?? null, reason: r.reason })),
    hodSessionsOut: plan.seats.hodSessionsOut.length,
    seatsByType: [...seatTypes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([seatType, count]) => ({ seatType, count })),
  };
}
