/** Frozen 6f8b list projection: native oracle keeps the predecessor unbounded upload query.
 * Imported dependencies remain their unchanged production owners. */
import {and,asc,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {Tx} from '../../db/client';
import {appUser,businessUnit,company,domainEvent,person,rewardCalendar,rewardCycle,rewardDecision,rewardMember,rewardUnit} from '../../db/schema';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {rewardDaysUntil,rewardStageDue,rewardStageSeat,type RewardCalendarValues} from '../../packs/rewards/calendar';
import type {RewardRole} from '../../packs/rewards/model';

const businessUnitDisplayName = sql<string>`coalesce(nullif(trim(${businessUnit.label}),''),${businessUnit.code})`;
const latestDecisionActionSql = sql<string | null>`(select d.action from reward_decision d where d.unit_id=${rewardUnit.id} order by d.created_at desc, d.id desc limit 1)`;
const returnedSeatSql = sql<'bu' | 'bg' | null>`case when ${rewardUnit.status}='draft' and ${latestDecisionActionSql}='return' then case when ${rewardUnit.offcycle}->>'bgOrigin'='true' then 'bg' else 'bu' end end`;
const visibleSeatHolder = sql<boolean>`app.access_workforce_person(${person.id}, 'workforce.view')`;
const ANNUAL_ROUTE: RewardRole[] = ['bu', 'bg', 'gr', 'ctro', 'ec'];
type CalendarRow = typeof rewardCalendar.$inferSelect;
const calendarValues = (r: CalendarRow): RewardCalendarValues => ({
  due: { bu: r.buDue, returned: r.returnedDue, bg: r.bgDue, gr: r.grDue, ctro: r.ctroDue, ec: r.ecDue, payroll: r.payrollDue },
  caseDue: r.caseDue,
  offcycleDays: { bg: r.offcycleBgDays, gr: r.offcycleGrDays, ctro: r.offcycleCtroDays, ec: r.offcycleEcDays, returned: r.offcycleReturnedDays },
});
export async function legacyRewardConfigurationListTx(tx:Tx,companyIds:string[]){
    if (!companyIds.length) return [];
    const seated = sql`exists(select 1 from app.reward_roles(${rewardUnit.id}))`;
    const rows = await tx.select({ id: rewardUnit.id, cycleId: rewardCycle.id, cycle: rewardCycle.name, kind: rewardUnit.kind, year: rewardCycle.year, companyId: rewardUnit.companyId, company: company.legalName, businessUnitId: rewardUnit.businessUnitId, unit: businessUnitDisplayName, status: rewardUnit.status, returnedTo: returnedSeatSql, revision: rewardUnit.revision, canConfigure:sql<boolean>`${rewardUnit.status}='draft' and ${rewardUnit.kind}='annual' and 'gr' in (select app.reward_roles(${rewardUnit.id}))`, deletionReason:sql<import('../../packs/rewards/maintenance').RewardDeletionReason|null>`case when app.reward_admin(${rewardUnit.companyId}) then app.reward_deletion_reason(${rewardUnit.id}) else 'locked' end`,
      bgOrigin: sql<boolean>`coalesce(${rewardUnit.offcycle}->>'bgOrigin','false')='true'`,
      effectiveFrom: sql<string | null>`${rewardUnit.policy}->>'effectiveFrom'`,
      people: sql<number | null>`case when ${seated} then (select count(*)::int from reward_entry e where e.unit_id=${rewardUnit.id}) end`,
      verified: sql<number | null>`case when ${seated} then (select count(*)::int from reward_entry e where e.unit_id=${rewardUnit.id} and e.facts->>'reviewed'='true') end`,
      // 56595838: the shared configuration version the review started from, and whether its own settings changed since.
      policyOrigin: sql<{ versionId: string; revision: number; name: string; changed: boolean } | null>`app.reward_policy_unit_origin(${rewardUnit.id})`,
      // 62e743ed: cancelRewardReview's guard, projected for the row actions (the service still decides).
      canCancel: sql<boolean>`${rewardUnit.status} not in ('posted','withdrawn','rejected') and (app.reward_admin(${rewardUnit.companyId}) or 'gr' in (select app.reward_roles(${rewardUnit.id})))` })
      .from(rewardUnit).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).innerJoin(company, eq(company.id, rewardUnit.companyId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId))
      .where(and(inArray(rewardUnit.companyId, companyIds),isNull(rewardUnit.deletedAt))).orderBy(desc(rewardCycle.year), asc(rewardCycle.name), asc(businessUnitDisplayName), asc(rewardUnit.id));
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    // Off-cycle seats: only the first seat depends on the request's route; later stages are their own seat.
    const routeOf = (r: typeof rows[number]): RewardRole[] => r.kind === 'annual' ? ANNUAL_ROUTE : [r.bgOrigin ? 'bg' : 'bu', 'bg', 'gr', 'ctro', 'ec'];
    const holders = await tx.select({ unitId: rewardMember.unitId, role: rewardMember.role, name: person.fullName }).from(rewardMember)
      .innerJoin(appUser, and(eq(appUser.id, rewardMember.userId), isNull(appUser.archivedAt), sql`not app.login_blocked(${appUser.id})`))
      .leftJoin(person, and(eq(person.id, appUser.personId), visibleSeatHolder))
      .where(and(inArray(rewardMember.unitId, ids),sql`app.reward_member_eligible(${rewardMember.id})`)).orderBy(asc(person.fullName), asc(rewardMember.userId));
    const calendars = new Map((await tx.select().from(rewardCalendar).where(inArray(rewardCalendar.cycleId, [...new Set(rows.map(r => r.cycleId))])))
      .map(c => [`${c.cycleId}:${c.companyId}`, calendarValues(c)]));
    const offcycle = rows.filter(r => r.kind !== 'annual').map(r => r.id);
    const decisions = offcycle.length ? await tx.select({ unitId: rewardDecision.unitId, toStage: rewardDecision.toStage, createdAt: rewardDecision.createdAt }).from(rewardDecision).where(inArray(rewardDecision.unitId, offcycle)).orderBy(desc(rewardDecision.createdAt), desc(rewardDecision.id)) : [];
    // Who cancelled, when and why: the audit event (domain_event RLS: administrators), the actor's name only where readable.
    const withdrawn = rows.filter(r => r.status === 'withdrawn').map(r => r.id);
    const cancellations = withdrawn.length ? await tx.select({ unitId: domainEvent.aggregateId, at: domainEvent.occurredAt, reason: sql<string | null>`${domainEvent.payload}->>'reason'`, actorName: person.fullName }).from(domainEvent)
      .leftJoin(appUser, eq(appUser.id, domainEvent.actorId)).leftJoin(person, and(eq(person.id, appUser.personId), visibleSeatHolder))
      .where(and(eq(domainEvent.aggregateType, 'reward-unit'), eq(domainEvent.eventType, 'reward-unit.cancelled'), inArray(domainEvent.aggregateId, withdrawn))).orderBy(desc(domainEvent.occurredAt)) : [];
    const uploadStates=await tx.execute<{unitId:string;pending:boolean}>(sql`select unit_id as "unitId",(current_version=0 or checked_version is distinct from current_version) as pending from reward_uploaded_review where tenant_id=app.current_tenant_id()`);const uploadedIds=new Set(uploadStates.map(r=>r.unitId));
    const today = todayInKualaLumpur();
    return rows.map(r => {
      const seat = rewardStageSeat(r.status, routeOf(r));
      const latest = decisions.find(d => d.unitId === r.id);
      const due = rewardStageDue(calendars.get(`${r.cycleId}:${r.companyId}`) ?? null, { kind: r.kind, status: r.status, returned: !!r.returnedTo, enteredOn: latest && latest.toStage === r.status ? todayInKualaLumpur(new Date(latest.createdAt)) : null });
      const c = cancellations.find(x => x.unitId === r.id);
      return { ...r,...(uploadedIds.has(r.id)?{uploaded:true as const,uploadPending:uploadStates.find(u=>u.unitId===r.id)?.pending??false}:{}), seat, holders: seat ? holders.filter(h => h.unitId === r.id && h.role === seat).map(h => h.name ?? null) : [], due, daysUntilDue: due ? rewardDaysUntil(due, today) : null,
        cancellation: c ? { on: todayInKualaLumpur(new Date(c.at)), reason: c.reason ?? '', by: c.actorName ?? null } : null };
    });
}
