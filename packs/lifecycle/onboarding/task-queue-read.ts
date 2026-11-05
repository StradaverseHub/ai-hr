/** Narrow case and note reads for the existing task interpreter; table RLS is unchanged. */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../../db/client';
import { lcOnboardingCase as cases, lcOnboardingNote as notes } from '../../../db/schema';
import type { Note } from '../../../lib/onboarding-model';

const canonicalUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** The caller already checked the live actor. The native query excludes only states the interpreter
 * cannot emit, then reads potential mentions for the admitted case IDs under the original note RLS. */
export async function readOnboardingTaskQueueInputsTx(tx: Tx, tenantId: string, actor: { id: string; module: boolean }) {
  const data = cases.data;
  const reqs = sql`${data}->'requisitions'`;
  const list = await tx.select({ revision: cases.revision, data }).from(cases).where(and(eq(cases.tenantId, tenantId), sql`case
    -- Preserve historical parse failures that can occur before the interpreter looks at the state.
    when jsonb_typeof(${data}) is distinct from 'object'
      or jsonb_typeof(${reqs}) is distinct from 'array' or ${reqs} @> '[null]'::jsonb then true
    when ${data}->>'state' = 'pending' then ${actor.module}::boolean
    else ${data}->>'state' = 'submitted' end`)).orderBy(asc(cases.id));
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
