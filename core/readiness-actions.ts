/** ADR-0111. One source-derived action catalogue for readiness cases, ESS and follow-ups. */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { isAdmin, isGroupAdmin } from '../lib/authz';
import { readinessSnapshot, type ReadinessGapId } from './record-readiness';
import { profileChangeAllowedKeys, profileChangeApprover } from './tenant-settings';

import { READINESS_CORRECTIONS, readinessActionFor, type ReadinessAction } from '../lib/readiness-correction-actions';
export { READINESS_CORRECTIONS, readinessActionFor, type ReadinessAction } from '../lib/readiness-correction-actions';

/** Read only request IDs and nonblank field NAMES; proposed values never enter the planner or model. */
export async function loadReadinessActions(tx: Tx, ctx: SessionContext, employmentIds: readonly string[]) {
  const result = new Map<string, ReadinessAction>();
  if (employmentIds.length === 0) return result;
  const allowedFields = profileChangeAllowedKeys(ctx);
  const approver = profileChangeApprover(ctx);
  // Bound parameter counts without truncating the workforce.
  for (let offset = 0; offset < employmentIds.length; offset += 500) {
    const ids = employmentIds.slice(offset, offset + 500);
    const employees = await tx.select({
      id: schema.employment.id,
      personId: schema.employment.personId,
      hasStatutoryProfile: sql<boolean>`exists (select 1 from ${schema.employeeStatutoryMy} s where s.person_id=${schema.employment.personId})`,
    }).from(schema.employment).where(and(inArray(schema.employment.id, ids), isNull(schema.employment.terminatedOn)));
    const requests = await tx.select({
      id: schema.profileChangeRequest.id, employmentId: schema.profileChangeRequest.employmentId,
      fields: sql<string[]>`array(select item.key from jsonb_each(
        case when jsonb_typeof(${schema.profileChangeRequest.proposed})='object'
          then ${schema.profileChangeRequest.proposed} else '{}'::jsonb end
      ) item where jsonb_typeof(item.value)='string' and nullif(btrim(item.value #>> '{}'),'') is not null order by item.key)`,
    }).from(schema.profileChangeRequest)
      .innerJoin(schema.employment, eq(schema.employment.id, schema.profileChangeRequest.employmentId))
      .where(and(inArray(schema.profileChangeRequest.employmentId, ids), eq(schema.profileChangeRequest.status, 'pending'),
        eq(schema.profileChangeRequest.personId, schema.employment.personId)))
      .orderBy(desc(schema.profileChangeRequest.createdAt), asc(schema.profileChangeRequest.id));
    const byEmployment = new Map<string, typeof requests>();
    for (const request of requests) {
      const list = byEmployment.get(request.employmentId) ?? [];
      list.push(request); byEmployment.set(request.employmentId, list);
    }
    for (const employee of employees) for (const gap of Object.keys(READINESS_CORRECTIONS) as ReadinessGapId[]) {
      const action = readinessActionFor(gap, {
        hasStatutoryProfile: employee.hasStatutoryProfile, allowedFields,
        pending: byEmployment.get(employee.id) ?? [], approver,
      });
      result.set(`${employee.id}:${gap}`, { ...action,
        mayReview: isAdmin(ctx) && ctx.personId !== employee.personId && (approver === 'admin' || isGroupAdmin(ctx)) });
    }
  }
  return result;
}

/** Self-service sees only the calling person's own active employment, never their reports or cases. */
export async function myReadinessActions(ctx: SessionContext, employmentId: string) {
  const personId = ctx.personId;
  if (!personId) return [];
  return withTenant(ctx, async tx => {
    const snapshot = await readinessSnapshot(tx, Number.POSITIVE_INFINITY, false, {
      employmentIds: [employmentId], personId,
    });
    const actions = await loadReadinessActions(tx, ctx, snapshot.activeEmploymentIds);
    return snapshot.view.gaps.flatMap(gap => gap.people.flatMap(person => {
      const action = actions.get(`${person.employmentId}:${gap.id}`);
      // A locked or HR-only field has no employee correction control.
      return action && action.type !== 'review_record' ? [{ gap: gap.id, ...action }] : [];
    }));
  });
}
