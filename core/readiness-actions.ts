/** ADR-0111. One source-derived action catalogue for readiness cases, ESS and follow-ups. */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as schema from '../db/schema';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import { isAdmin, isGroupAdmin } from '../lib/authz-model';
import { readinessSnapshot, type ReadinessGapId } from './record-readiness';
import { profileChangeAllowedKeys, profileChangeApprover } from './tenant-settings';
import { isAgentContext } from './agent-principal';

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
    const { employees, requests } = isAgentContext(ctx) ? await agentCorrectionSource(tx, ids) : await correctionSource(tx, ids);
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

/** Registry field ids whose legacy key a readiness correction can carry. One list for both readers. */
const CORRECTION_ALIASES = PERSONNEL_FIELDS.filter(field => field.ess.binding?.legacyKey &&
  Object.values(READINESS_CORRECTIONS).some(rule => (rule.fields as readonly string[]).includes(field.ess.binding!.legacyKey!)))
  .map(field => ({ fieldId: field.id, key: field.ess.binding!.legacyKey! }));

type CorrectionSource = {
  employees: { id: string; personId: string; hasStatutoryProfile: boolean }[];
  requests: { id: string; employmentId: string; fields: string[] }[];
};

/**
 * ADR-0151 §4.5 — the agent principal reads presence and pending field NAMES through 0672's functions; it
 * holds no grant that would let it read statutory rows or correction values. Same result shape and order
 * as `correctionSource`.
 */
async function agentCorrectionSource(tx: Tx, ids: readonly string[]): Promise<CorrectionSource> {
  const idArray = sql`array[${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
  const presence = await tx.execute<{ employment_id: string; person_id: string; has_statutory_profile: boolean }>(
    sql`select employment_id, person_id, has_statutory_profile from app.agent_readiness_presence(${idArray})`);
  const pending = await tx.execute<{ request_id: string; employment_id: string; legacy_keys: string[]; field_ids: string[] }>(
    sql`select request_id, employment_id, legacy_keys, field_ids from app.agent_pending_profile_corrections(${idArray})`);
  const aliases = new Map(CORRECTION_ALIASES.map(a => [a.fieldId, a.key]));
  return {
    employees: Array.from(presence).map(r => ({ id: r.employment_id, personId: r.person_id, hasStatutoryProfile: r.has_statutory_profile })),
    requests: Array.from(pending).map(r => ({ id: r.request_id, employmentId: r.employment_id,
      fields: [...new Set([...r.legacy_keys, ...r.field_ids.flatMap(id => aliases.has(id) ? [aliases.get(id)!] : [])])].sort() })),
  };
}

async function correctionSource(tx: Tx, ids: readonly string[]): Promise<CorrectionSource> {
    const employees = await tx.select({
      id: schema.employment.id,
      personId: schema.employment.personId,
      hasStatutoryProfile: sql<boolean>`exists (select 1 from ${schema.employeeStatutoryMy} s where s.person_id=${schema.employment.personId})`,
    }).from(schema.employment).where(and(inArray(schema.employment.id, [...ids]), isNull(schema.employment.terminatedOn)));
    const requests = await tx.select({
      id: schema.profileChangeRequest.id, employmentId: schema.profileChangeRequest.employmentId,
      fields: sql<string[]>`array(select distinct correction.key from (
        select item.key from jsonb_each(case
          when jsonb_typeof(${schema.profileChangeRequest.proposed})='object'
            and ${schema.profileChangeRequest.proposed}->>'v' is distinct from '2'
          then ${schema.profileChangeRequest.proposed} else '{}'::jsonb end) item
          where jsonb_typeof(item.value)='string' and nullif(btrim(item.value #>> '{}'),'') is not null
        union all
        select aliases.key from jsonb_array_elements(case
          when ${schema.profileChangeRequest.proposed}->>'v'='2'
            and jsonb_typeof(${schema.profileChangeRequest.proposed}->'fields')='array'
          then ${schema.profileChangeRequest.proposed}->'fields' else '[]'::jsonb end) item
          join (values ${sql.join(CORRECTION_ALIASES.map(alias=>sql`(${alias.fieldId}::text,${alias.key}::text)`),sql`, `)}) aliases(field_id,key)
            on aliases.field_id=item->>'fieldId'
          where jsonb_typeof(item->'value')='string' and nullif(btrim(item->>'value'),'') is not null
      ) correction order by correction.key)`,
    }).from(schema.profileChangeRequest)
      .innerJoin(schema.employment, eq(schema.employment.id, schema.profileChangeRequest.employmentId))
      .where(and(inArray(schema.profileChangeRequest.employmentId, [...ids]), eq(schema.profileChangeRequest.status, 'pending'),
        eq(schema.profileChangeRequest.personId, schema.employment.personId)))
      .orderBy(desc(schema.profileChangeRequest.createdAt), asc(schema.profileChangeRequest.id));
    return { employees, requests };
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
