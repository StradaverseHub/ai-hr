import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SessionContext } from '../../db/client';
import { appUser, domainEvent, employment, person, rewardEntry, rewardUnit } from '../../db/schema';
import { withRewardsTenant } from '../../core/module-gate';

const subjectPerson = alias(person, 'reward_activity_subject');

const activityTypes = [
  'reward-unit.access-changed', 'reward-unit.cancelled', 'reward-unit.facts-imported',
  'reward-unit.final-pool-changed', 'reward-unit.lump-updated', 'reward-unit.onehr-results-imported',
  'reward-unit.posted', 'reward-unit.recommendation-updated', 'reward-unit.routed',
  'reward-unit.senior-membership-updated', 'reward-unit.upload-source-refreshed',
] as const;

/** Read the existing immutable audit stream, without exposing its underlying payroll payload. */
export async function rewardReviewActivity(ctx: SessionContext, unitIds: readonly string[], actorId?: string, subjectId?: string) {
  if (!unitIds.length) return [];
  return withRewardsTenant(ctx, tx => tx.select({
    id: domainEvent.id, unitId: domainEvent.aggregateId, eventType: domainEvent.eventType,
    time: domainEvent.occurredAt, actorId: domainEvent.actorId, actorName: person.fullName,
    subjectId: sql<string | null>`case when ${subjectPerson.id} is not null then ${employment.id} end`,
    subjectName: subjectPerson.fullName,
    reason: sql<string | null>`left(${domainEvent.payload}->>'reason', 1000)`,
  }).from(domainEvent).innerJoin(rewardUnit, and(
    eq(rewardUnit.id, domainEvent.aggregateId), eq(rewardUnit.tenantId, domainEvent.tenantId),
  )).leftJoin(appUser, and(
    eq(appUser.id, domainEvent.actorId), eq(appUser.tenantId, domainEvent.tenantId),
  )).leftJoin(person, and(eq(person.id, appUser.personId), sql`app.access_workforce_person(${person.id}, 'workforce.view')`))
    .leftJoin(rewardEntry, and(eq(rewardEntry.unitId, rewardUnit.id), eq(rewardEntry.tenantId, domainEvent.tenantId),
      sql`${rewardEntry.id}::text = ${domainEvent.payload}->>'entryId'`))
    .leftJoin(employment, and(eq(employment.id, rewardEntry.employmentId), eq(employment.tenantId, domainEvent.tenantId)))
    .leftJoin(subjectPerson, and(eq(subjectPerson.id, employment.personId), sql`app.access_workforce_person(${subjectPerson.id}, 'workforce.view')`))
    .where(and(
      eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.aggregateType, 'reward-unit'),
      inArray(domainEvent.eventType, activityTypes), inArray(rewardUnit.id, [...unitIds]),
      sql`app.reward_access_scope(${rewardUnit.id}) and 'gr' in (select app.reward_roles(${rewardUnit.id}))`,
      actorId ? eq(domainEvent.actorId, actorId) : undefined,
      subjectId ? and(eq(employment.id, subjectId), sql`${subjectPerson.id} is not null`) : undefined,
    )).orderBy(desc(domainEvent.occurredAt), desc(domainEvent.sequence)).limit(200));
}
