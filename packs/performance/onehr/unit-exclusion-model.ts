/**
 * D-P1-22 (ADR-0150): the cycle exclusion rule's plan, pure. The database projection
 * app.assessment_unit_exclusion_facts (0667) supplies every fact, computed with the proposed scope added to the
 * active rules and before any write; this module turns those facts into the plan that the preview shows and the
 * save performs, and the digest that binds the two. One plan function for both: the save recomputes it and
 * refuses a different digest.
 *
 * Written once at save (D3): live 360 rows where someone in the new scope is the rated person ("own") or the
 * rater ("place") are archived, frozen reviews skipped and counted (D7); untouched KPI lines naming someone in the
 * new scope move one level up. A line qualifies when it is not HR-filled, not locked and no approval step has acted
 * (setting approvals do not count) and its subject still takes part. Each approver who is out is replaced by the
 * walk above THAT approver; the new chain is de-duplicated in order; if any approver has nobody above, the line does
 * not move and its subject is listed under "nobody above". Everything else is derived and needs no write.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.uuid();
const factsSchema = z.object({
  cycle: z.object({ id, status: z.string(), companyId: id.nullable(), revision: z.number().int() }),
  scope: z.object({ companyId: id, departmentId: id.nullable(), companyExists: z.boolean(), companyInCycle: z.boolean(), departmentInCompany: z.boolean(), headcount: z.coerce.number().int() }),
  activeRules: z.array(z.object({ id, companyId: id, departmentId: id.nullable() })),
  people: z.array(z.object({ reviewId: id, employmentId: id, frozen: z.boolean(), excludedBefore: z.boolean() })),
  panels: z.array(z.object({ requestId: id, reviewId: id, subjectEmploymentId: id, raterEmploymentId: id, submitted: z.boolean(), frozen: z.boolean(), subjectInScope: z.boolean(), raterInScope: z.boolean() })),
  panelSubjects: z.array(z.object({ reviewId: id, grade: z.string(), live: z.coerce.number().int() })),
  kpiLines: z.array(z.object({
    reviewId: id, kpiId: z.string(), subjectEmploymentId: id, subjectExcluded: z.boolean(), hrOwned: z.boolean(), locked: z.boolean(), acted: z.boolean(),
    approvers: z.array(z.object({ employmentId: id, inScope: z.boolean(), excluded: z.boolean(), stepUp: id.nullable() })),
  })),
  oneLevelUp: z.array(z.object({ reviewId: id, employmentId: id, storedReviewerId: id, storedInScope: z.boolean(), frozen: z.boolean(), subjectExcluded: z.boolean(), before: id.nullable(), after: id.nullable() })),
  hodOut: z.array(z.object({ subjectEmploymentId: id, hodEmploymentId: id })),
  hodSessionsOut: z.array(z.object({ sessionId: id, anchorEmploymentId: id })),
  seatsOut: z.array(z.object({ seatId: id, seatType: z.string(), holderEmploymentId: id })),
  sessionReviewersOut: z.array(z.object({ sessionId: id, userId: id })),
});
export type UnitExclusionFacts = z.infer<typeof factsSchema>;
export function parseUnitExclusionFacts(raw: unknown): UnitExclusionFacts { return factsSchema.parse(raw); }

export type UnitExclusionArchive = { requestId: string; reviewId: string; subjectEmploymentId: string; raterEmploymentId: string; submitted: boolean; side: 'own' | 'place' };
export type UnitExclusionMove = { reviewId: string; kpiId: string; subjectEmploymentId: string; from: string[]; to: string[] };
export type UnitExclusionPlan = {
  cycleId: string; companyId: string; departmentId: string | null;
  /** An identical active rule: the save is a no-op and nothing is written again. */
  alreadyActiveRuleId: string | null;
  /** Department rules of the same company that a whole-company save ends as subsumed. */
  subsumedRuleIds: string[];
  /** People who newly take no part (their review is not frozen). */
  people: { reviewId: string; employmentId: string }[];
  /** People in the scope whose result is frozen: exempt from the rule (D7). */
  frozenPeople: { reviewId: string; employmentId: string }[];
  archive: UnitExclusionArchive[];
  frozenSkipped: { requestId: string; reviewId: string }[];
  /** People still taking part who drop below their full panel when their places are archived. */
  belowFullPanel: { reviewId: string; before: number; after: number; target: number }[];
  moves: UnitExclusionMove[];
  /** Competency and Career Plan review moving one level up: the reviewer before and after. */
  oneLevelUp: { reviewId: string; employmentId: string; from: string | null; to: string }[];
  /** Nobody above: the review has no reviewer after the save, or a KPI line cannot move. Fixed by hand (D16). */
  nobodyAbove: { reviewId: string; employmentId: string; reason: 'review' | 'kpi' }[];
  seats: { hodOut: UnitExclusionFacts['hodOut']; hodSessionsOut: UnitExclusionFacts['hodSessionsOut']; seatsOut: UnitExclusionFacts['seatsOut']; sessionReviewersOut: UnitExclusionFacts['sessionReviewersOut'] };
  counts: { people: number; frozenPeople: number; own: number; places: number; submitted: number; frozenSkipped: number; belowFullPanel: number; moves: number; oneLevelUp: number; nobodyAbove: number; hodOut: number; seatsOut: number; sessionReviewersOut: number };
  digest: string;
};

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** First occurrence wins, order kept. */
export function dedupeChain(ids: readonly string[]): string[] { return ids.filter((v, i) => ids.indexOf(v) === i); }
/** Numeric job grades carry the configured panel; a letter grade has one assessor (the source rule). */
export function fullPanelTarget(grade: string, panelTarget: number): number { return /^\d+$/.test(grade.replace(/^JG\s*/i, '').trim()) ? panelTarget : 1; }

/** A KPI line's move, or why it stays: 'skip' (does not qualify or names nobody in scope), 'nobody', or the new chain. */
export function planKpiLine(line: UnitExclusionFacts['kpiLines'][number]): { kind: 'skip' } | { kind: 'nobody' } | { kind: 'move'; from: string[]; to: string[] } {
  if (line.hrOwned || line.locked || line.acted || line.subjectExcluded) return { kind: 'skip' };
  if (!line.approvers.some((a) => a.inScope)) return { kind: 'skip' };
  if (line.approvers.some((a) => a.excluded && !a.stepUp)) return { kind: 'nobody' };
  const from = line.approvers.map((a) => a.employmentId);
  const to = dedupeChain(line.approvers.map((a) => (a.excluded ? a.stepUp! : a.employmentId)));
  return JSON.stringify(from) === JSON.stringify(to) ? { kind: 'skip' } : { kind: 'move', from, to };
}

export function planUnitExclusion(facts: UnitExclusionFacts, policy: { panelTarget: number }): UnitExclusionPlan {
  const { companyId, departmentId } = facts.scope;
  const alreadyActive = facts.activeRules.find((r) => r.companyId === companyId && r.departmentId === departmentId) ?? null;
  const subsumedRuleIds = alreadyActive || departmentId ? [] : facts.activeRules.filter((r) => r.companyId === companyId && r.departmentId !== null).map((r) => r.id).sort(byText);
  const quiet = !!alreadyActive;
  const people = quiet ? [] : facts.people.filter((p) => !p.frozen).map(({ reviewId, employmentId }) => ({ reviewId, employmentId }));
  const frozenPeople = quiet ? [] : facts.people.filter((p) => p.frozen).map(({ reviewId, employmentId }) => ({ reviewId, employmentId }));
  const live = quiet ? [] : facts.panels;
  const archive: UnitExclusionArchive[] = live.filter((p) => !p.frozen).map((p) => ({ requestId: p.requestId, reviewId: p.reviewId, subjectEmploymentId: p.subjectEmploymentId, raterEmploymentId: p.raterEmploymentId, submitted: p.submitted, side: p.subjectInScope ? 'own' : 'place' }));
  const frozenSkipped = live.filter((p) => p.frozen).map(({ requestId, reviewId }) => ({ requestId, reviewId }));
  const belowFullPanel = (quiet ? [] : facts.panelSubjects).flatMap((s) => {
    const lost = archive.filter((a) => a.reviewId === s.reviewId).length, target = fullPanelTarget(s.grade, policy.panelTarget), after = s.live - lost;
    return lost > 0 && after < target ? [{ reviewId: s.reviewId, before: s.live, after, target }] : [];
  });
  const moves: UnitExclusionMove[] = [];
  const nobody = new Map<string, UnitExclusionPlan['nobodyAbove'][number]>();
  for (const line of quiet ? [] : facts.kpiLines) {
    const planned = planKpiLine(line);
    if (planned.kind === 'move') moves.push({ reviewId: line.reviewId, kpiId: line.kpiId, subjectEmploymentId: line.subjectEmploymentId, from: planned.from, to: planned.to });
    else if (planned.kind === 'nobody') nobody.set(`${line.reviewId}:kpi`, { reviewId: line.reviewId, employmentId: line.subjectEmploymentId, reason: 'kpi' });
  }
  const oneLevelUp: UnitExclusionPlan['oneLevelUp'] = [];
  for (const r of quiet ? [] : facts.oneLevelUp) {
    if (r.subjectExcluded || r.frozen) continue;
    if (r.after && r.after !== r.before) oneLevelUp.push({ reviewId: r.reviewId, employmentId: r.employmentId, from: r.before, to: r.after });
    if (!r.after && (r.before || r.storedInScope)) nobody.set(`${r.reviewId}:review`, { reviewId: r.reviewId, employmentId: r.employmentId, reason: 'review' });
  }
  const nobodyAbove = [...nobody.values()].sort((a, b) => byText(a.employmentId, b.employmentId) || byText(a.reviewId, b.reviewId) || byText(a.reason, b.reason));
  const seats = quiet ? { hodOut: [], hodSessionsOut: [], seatsOut: [], sessionReviewersOut: [] } : { hodOut: facts.hodOut, hodSessionsOut: facts.hodSessionsOut, seatsOut: facts.seatsOut, sessionReviewersOut: facts.sessionReviewersOut };
  const body = {
    cycleId: facts.cycle.id, companyId, departmentId, alreadyActiveRuleId: alreadyActive?.id ?? null, subsumedRuleIds,
    people: [...people].sort((a, b) => byText(a.employmentId, b.employmentId) || byText(a.reviewId, b.reviewId)),
    frozenPeople: [...frozenPeople].sort((a, b) => byText(a.employmentId, b.employmentId) || byText(a.reviewId, b.reviewId)),
    archive: [...archive].sort((a, b) => byText(a.reviewId, b.reviewId) || byText(a.requestId, b.requestId)),
    frozenSkipped: [...frozenSkipped].sort((a, b) => byText(a.reviewId, b.reviewId) || byText(a.requestId, b.requestId)),
    belowFullPanel: [...belowFullPanel].sort((a, b) => byText(a.reviewId, b.reviewId)),
    moves: [...moves].sort((a, b) => byText(a.reviewId, b.reviewId) || byText(a.kpiId, b.kpiId)),
    oneLevelUp: [...oneLevelUp].sort((a, b) => byText(a.reviewId, b.reviewId)),
    nobodyAbove, seats,
  };
  const counts = {
    people: body.people.length, frozenPeople: body.frozenPeople.length, own: body.archive.filter((a) => a.side === 'own').length, places: body.archive.filter((a) => a.side === 'place').length,
    submitted: body.archive.filter((a) => a.submitted).length, frozenSkipped: body.frozenSkipped.length, belowFullPanel: body.belowFullPanel.length, moves: body.moves.length,
    oneLevelUp: body.oneLevelUp.length, nobodyAbove: body.nobodyAbove.length, hodOut: seats.hodOut.length, seatsOut: seats.seatsOut.length, sessionReviewersOut: seats.sessionReviewersOut.length,
  };
  return { ...body, counts, digest: unitExclusionDigest(body) };
}

/** The preview digest: every fact the save acts on, canonical (sorted), never the cycle revision (a separate token). */
export function unitExclusionDigest(body: Omit<UnitExclusionPlan, 'counts' | 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
