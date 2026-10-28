/**
 * 6fd08f37 — derived confidentiality. Anyone with an administrative reporting line, valid on the review's
 * snapshot date, to a person holding the unit's BG CEO seat is at least "BG confidential"; to the EC seat holder,
 * at least "EC confidential". Group Rewards may mark a person stricter, never lower (saveRewardEntry/importRewardFacts).
 * Reads go through the caller's RLS: a seat holder or line this caller cannot read derives nothing.
 */
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { appUser, employment, reportingLine, rewardEntry, rewardMember } from '../../db/schema';
import { applyConfidentialityFloor, confidentialityRank, withConfidentialityFloor, type RewardRole, type RewardSource } from './model';

export type ConfidentialityFloor = { level: 'bg' | 'ec'; managerEmploymentId: string };
export async function deriveConfidentialityTx(tx: Tx, unitId: string, employmentIds: readonly string[], asOf: string): Promise<Map<string, ConfidentialityFloor>> {
  const floors = new Map<string, ConfidentialityFloor>();
  if (!employmentIds.length) return floors;
  const seats = await tx.select({ role: rewardMember.role, personId: appUser.personId }).from(rewardMember).innerJoin(appUser, eq(appUser.id, rewardMember.userId)).where(and(eq(rewardMember.unitId, unitId), inArray(rewardMember.role, ['bg', 'ec'] as RewardRole[])));
  const personIds = [...new Set(seats.flatMap(s => s.personId ? [s.personId] : []))];
  if (!personIds.length) return floors;
  const managers = await tx.select({ id: employment.id, personId: employment.personId }).from(employment).where(and(inArray(employment.personId, personIds), lte(employment.hiredOn, asOf), or(isNull(employment.terminatedOn), gt(employment.terminatedOn, asOf))));
  if (!managers.length) return floors;
  const lines = await tx.select({ sub: reportingLine.subordinateEmploymentId, mgr: reportingLine.managerEmploymentId }).from(reportingLine)
    .where(and(eq(reportingLine.lineType, 'administrative'), isNull(reportingLine.supersededAt), lte(reportingLine.validFrom, asOf), or(isNull(reportingLine.validTo), gt(reportingLine.validTo, asOf)),
      inArray(reportingLine.managerEmploymentId, managers.map(m => m.id)), inArray(reportingLine.subordinateEmploymentId, [...employmentIds])))
    .orderBy(reportingLine.subordinateEmploymentId, reportingLine.managerEmploymentId);
  for (const line of lines) {
    const holder = managers.find(m => m.id === line.mgr)!;
    for (const seat of seats) {
      if (seat.personId !== holder.personId || seat.role !== 'bg' && seat.role !== 'ec') continue;
      const current = floors.get(line.sub);
      if (!current || confidentialityRank[seat.role] > confidentialityRank[current.level]) floors.set(line.sub, { level: seat.role, managerEmploymentId: line.mgr });
    }
  }
  return floors;
}
export const sourceWithFloor = (source: RewardSource, floor: ConfidentialityFloor | undefined) =>
  withConfidentialityFloor(source, floor ? { level: floor.level, reason: { seat: floor.level, managerEmploymentId: floor.managerEmploymentId } } : null);

/**
 * Re-derive after a BG/EC seat changes on a draft review (called once from commitAccessTx). Leavers keep their
 * record. A changed marking needs data verification again. The caller already bumps the revision.
 */
export async function rewardSeatConfidentialityTx(tx: Tx, unit: { id: string; snapshotDate: string }, change: { before: { role: string } | null; after: { role: string } | null }) {
  if (![change.before?.role, change.after?.role].some(r => r === 'bg' || r === 'ec')) return;
  const entries = await tx.select().from(rewardEntry).where(eq(rewardEntry.unitId, unit.id));
  const active = entries.filter(e => !e.source.leftOn);
  const floors = await deriveConfidentialityTx(tx, unit.id, active.map(e => e.employmentId), unit.snapshotDate);
  for (const e of active) {
    const source = sourceWithFloor(e.source, floors.get(e.employmentId));
    if (source.confidentialityFloor === e.source.confidentialityFloor && source.confidentialityReason?.managerEmploymentId === e.source.confidentialityReason?.managerEmploymentId) continue;
    const confidentiality = applyConfidentialityFloor(e.facts.confidentiality, e.source.confidentialityFloor, source.confidentialityFloor);
    await tx.update(rewardEntry).set({ source, facts: { ...e.facts, confidentiality, reviewed: confidentiality === e.facts.confidentiality && e.facts.reviewed }, updatedAt: new Date() }).where(eq(rewardEntry.id, e.id));
  }
}
