/** Narrow case and note reads for the existing task interpreter; table RLS is unchanged. */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/client';
import { lcOnboardingCase as cases, lcOnboardingNote as notes } from '../../../db/schema';
import type { Note } from '../../../lib/onboarding-model';

const canonicalUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** The caller already checked the live actor. The native query excludes only states the interpreter
 * cannot emit, then reads potential mentions for the admitted case IDs under the original note RLS. */
function onboardingTaskCaseWhere(tenantId: string, module: boolean) {
  const data = cases.data;
  const reqs = sql`${data}->'requisitions'`;
  return and(eq(cases.tenantId, tenantId), sql`case
    -- Preserve historical parse failures that can occur before the interpreter looks at the state.
    when jsonb_typeof(${data}) is distinct from 'object'
      or jsonb_typeof(${reqs}) is distinct from 'array' or ${reqs} @> '[null]'::jsonb then true
    when ${data}->>'state' = 'pending' then ${module}::boolean
    else ${data}->>'state' = 'submitted' end`);
}
/** readOnboardingTaskQueueInputsTx's reads in one statement (core/account-task-bundle.ts), plus the owner's later
 * update-time read: the queue under the wider of its two predicates (module access), each row marked with the narrower
 * one, in the queue's order; the candidate notes of every plain-UUID case JSON id under the original note RLS, in the
 * notes' order; each case's recorded update time by its JSON id, as onboardingAssignedTaskMetadata reads it; and whether
 * any requisition item carries a claim (the interpreter then reads the claimant directory). */
export function onboardingTaskQueueBundleSql(tenantId: string, actorId: string | null) {
  const data = cases.data, mentions = sql`${notes.data}->'mentions'`;
  const caseIds = sql`array(select ${data}->>'id' from ${cases} where ${onboardingTaskCaseWhere(tenantId, true)}
    and jsonb_typeof(${data}->'id')='string' and ${data}->>'id' ~ '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')`;
  return {
    cases: sql`(select coalesce(jsonb_agg(jsonb_build_object('revision',${cases.revision},'data',${data},'narrow',${onboardingTaskCaseWhere(tenantId, false)},
      'updatedAt',(select updated_case.updated_at::text from ${cases} updated_case where updated_case.tenant_id=${tenantId}::uuid
        and updated_case.id=case when ${data}->>'id' ~ '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' then (${data}->>'id')::uuid end)) order by ${cases.id}),'[]'::jsonb)
     from ${cases} where ${onboardingTaskCaseWhere(tenantId, true)})`,
    notes: actorId === null ? sql`'[]'::jsonb` : sql`(select coalesce(jsonb_agg(jsonb_build_object('caseId',${notes.caseId},'data',${notes.data}) order by ${notes.createdAt},${notes.id}),'[]'::jsonb)
     from ${notes} where ${and(eq(notes.tenantId, tenantId), sql`${notes.caseId}::text = any(${caseIds})`,
      sql`(jsonb_typeof(${mentions}) is distinct from 'array' or ${mentions} ? ${actorId})`)})`,
    claimed: sql`exists(select 1 from ${cases} where ${onboardingTaskCaseWhere(tenantId, true)}
      and jsonb_path_exists(${data}, 'lax $.requisitions[*].items[*] ? (exists(@.claim) && !(@.claim == null))'))`,
  };
}

export async function readOnboardingTaskQueueInputsTx(tx: Tx, tenantId: string, actor: { id: string; module: boolean }) {
  const data = cases.data;
  const list = await tx.select({ revision: cases.revision, data }).from(cases).where(onboardingTaskCaseWhere(tenantId, actor.module)).orderBy(asc(cases.id));
  const notesByCase = new Map<string, Note[]>();
  // The interpreter compares exact case JSON IDs to PostgreSQL UUID strings. A differently shaped
  // historical ID never matched a note; do not cast it or drop the case itself.
  const ids = [...new Set(list.flatMap(row => typeof row.data?.id === 'string' && canonicalUuid.test(row.data.id) ? [row.data.id] : []))];
  if (!ids.length) return { list, notesByCase };
  const mentions = sql`${notes.data}->'mentions'`;
  const candidateNotes = await tx.select({ caseId: notes.caseId, data: notes.data }).from(notes).where(and(
    eq(notes.tenantId, tenantId), sql`${notes.caseId} = any(${'{' + ids.join(',') + '}'}::uuid[])`,
    // An unusual retained shape still reaches the canonical checks; valid unrelated notes cannot.
    sql`(jsonb_typeof(${mentions}) is distinct from 'array' or ${mentions} ? ${actor.id})`,
  )).orderBy(asc(notes.createdAt), asc(notes.id));
  for (const row of candidateNotes) {
    const matching = notesByCase.get(row.caseId);
    if (matching) matching.push(row.data);
    else notesByCase.set(row.caseId, [row.data]);
  }
  return { list, notesByCase };
}
