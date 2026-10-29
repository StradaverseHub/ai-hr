/** cd72f915 — the one owner of the unit roles a review needs before it can be submitted or approved.
 *  Submission (decideRewardUnit), access maintenance (prepareAccess) and every coverage projection read it here. */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { appUser, person, rewardMember, rewardUnit } from '../../db/schema';
import { rewardRoles, type RewardEntry, type RewardRole } from './model';
import { offcycleRoute, type OffcycleDetails, type RewardKind } from './offcycle';
export const annualRewardRoute: readonly RewardRole[] = ['bu', 'bg', 'gr', 'ctro', 'ec'];
/** Server-message labels; the screens use the localized rewards.roles.* keys. */
export const rewardRoleLabels: Record<RewardRole, string> = { bu: 'BU CEO', bg: 'BG CEO / authorised proxy', gr: 'Group Rewards', ctro: 'CTRO', ec: 'Executive Chairman', pbp: 'PBP', payroll: 'Payroll handoff' };
export type RewardCoverageUnit = { kind: RewardKind; offcycle?: OffcycleDetails | null };
/** Approval route plus the payroll handoff. Off-cycle EC depends on the entries (grade 22+, EC confidentiality);
 *  a caller that cannot read the roster passes none and gets the route its stored request details imply. */
export function rewardRequiredRoles(unit: RewardCoverageUnit, entries: RewardEntry[] = []): RewardRole[] {
    const route = unit.kind === 'annual' ? annualRewardRoute : offcycleRoute(unit.kind, unit.offcycle ?? { exceptionReason: '', bgOrigin: false }, entries);
    return [...route, 'payroll'];
}
/** A seat counts only while its login is neither archived nor blocked (suspended, past last working day). */
export const activeRewardLogin = () => and(isNull(appUser.archivedAt), sql `not app.login_blocked(${appUser.id})`);
export const missingRewardRoles = (required: readonly RewardRole[], active: readonly { role: string }[]) => required.filter(role => !active.some(m => m.role === role));
export type RewardRoleCoverage = { role: RewardRole; required: boolean; activeHolders: { userId: string; name: string | null; email: string | null }[] };
export type RewardUnitCoverage = { unitId: string; roles: RewardRoleCoverage[]; missing: RewardRole[] };
/** Per-unit coverage for units the caller can already read (RLS decides). No roster or pay fact is loaded. */
export async function rewardUnitCoverage(tx: Tx, unitIds: string[]): Promise<RewardUnitCoverage[]> {
    if (!unitIds.length) return [];
    const units = await tx.select({ id: rewardUnit.id, kind: rewardUnit.kind, offcycle: rewardUnit.offcycle }).from(rewardUnit).where(inArray(rewardUnit.id, unitIds));
    const holders = await tx.select({ unitId: rewardMember.unitId, role: rewardMember.role, userId: rewardMember.userId, name: person.fullName, email: person.primaryEmail }).from(rewardMember).innerJoin(appUser, and(eq(appUser.id, rewardMember.userId), eq(appUser.tenantId, rewardMember.tenantId))).leftJoin(person, and(eq(person.id, appUser.personId), sql `app.access_workforce_person(${person.id}, 'workforce.view')`)).where(and(inArray(rewardMember.unitId, unitIds), sql`app.reward_member_eligible(${rewardMember.id})`)).orderBy(asc(person.fullName), asc(appUser.id));
    const byId = new Map(units.map(u => [u.id, u]));
    return unitIds.filter(id => byId.has(id)).map(unitId => {
        const required = rewardRequiredRoles(byId.get(unitId)!), mine = holders.filter(h => h.unitId === unitId);
        const roles = rewardRoles.map(role => ({ role, required: required.includes(role), activeHolders: mine.filter(h => h.role === role).map(({ userId, name, email }) => ({ userId, name, email })) }));
        return { unitId, roles, missing: missingRewardRoles(required, mine) };
    });
}
