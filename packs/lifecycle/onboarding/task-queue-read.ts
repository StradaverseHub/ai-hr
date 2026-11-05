/** Candidate selection for the existing task interpreter. These predicates never grant row access. */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../../db/client';
import type { Case, Note } from '../../../lib/onboarding-model';
import { lcOnboardingCase as cases, lcOnboardingNote as notes } from '../../../db/schema';

const jsonFalsy = (value: SQL) => sql`
  coalesce(${value}, 'null'::jsonb) in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
`;
const malformedArray = (value: SQL) => sql`
  (jsonb_typeof(${value}) is distinct from 'array' or ${value} @> '[null]'::jsonb)
`;

/** Older malformed mention values still reach the canonical interpreter; a valid unrelated note cannot. */
function possibleOnboardingMention(userId: string) {
  const mentions = sql`${notes.data}->'mentions'`;
  return sql`(jsonb_typeof(${mentions}) is distinct from 'array' or ${mentions} ? ${userId})`;
}

function possibleOnboardingTaskCase(module: boolean) {
  const data = cases.data;
  const tasks = sql`${data}->'tasks'`;
  const reqs = sql`${data}->'requisitions'`;
  return sql`case
    when jsonb_typeof(${data}) is distinct from 'object' or ${malformedArray(reqs)} then true
    when ${data}->>'state' = 'pending' then ${module}::boolean
    when ${data}->>'state' is distinct from 'submitted' then false
    when ${malformedArray(tasks)} then true
    when exists (select 1 from jsonb_array_elements(${tasks}) t(value)
      where t.value->'status' is distinct from '"done"'::jsonb) then true
    when exists (select 1 from jsonb_array_elements(${reqs}) r(value)
      where ${jsonFalsy(sql`r.value->'cancelledAt'`)} and ${jsonFalsy(sql`r.value->'handedAt'`)}) then true
    -- Any eligible requisition is a conservative candidate. The existing interpreter still owns
    -- first-active selection, role/step/group tests, locks, deadlines and exact emitted tasks.
    when ${data}->>'id' is distinct from ${cases.id}::text then true
    -- Build one current-actor mention set; do not rescan note RLS for every historical case.
    else ${cases.id} in (select case_id from actor_mentions) end`;
}


type QueueInputRow =
  | { kind: 'case'; target: string; revision: number; data: Case }
  | { kind: 'mention'; target: string; revision: null; data: Note };

/** Read once under the existing tenant, case and note RLS, after the caller's live actor check. */
export async function readOnboardingTaskQueueInputsTx(tx: Tx, tenantId: string, actor: { id: string; module: boolean }) {
  const rows = await tx.execute<QueueInputRow>(sql`
    with actor_mentions as materialized (
      select ${notes.caseId} as case_id, ${notes.data} as data, ${notes.createdAt} as created_at, ${notes.id} as id
      from ${notes} where ${notes.tenantId} = ${tenantId}::uuid and ${possibleOnboardingMention(actor.id)}
    ), candidate_cases as materialized (
      select ${cases.id} as id, ${cases.revision} as revision, ${cases.data} as data from ${cases}
      where ${cases.tenantId} = ${tenantId}::uuid and ${possibleOnboardingTaskCase(actor.module)}
    )
    select 'case'::text as kind, id::text as target, revision, data, null::timestamptz as sort_date, id as sort_id
      from candidate_cases
    union all
    select 'mention', case_id::text, null::integer, data, created_at, id from actor_mentions
      where exists (select 1 from candidate_cases where candidate_cases.data->>'id' = actor_mentions.case_id::text)
    order by kind, sort_date, sort_id
  `);
  const list: { revision: number; data: Case }[] = [];
  const notesByCase = new Map<string, Note[]>();
  for (const row of rows) {
    if (row.kind === 'case') list.push({ revision: row.revision, data: row.data });
    else {
      const matching = notesByCase.get(row.target);
      if (matching) matching.push(row.data);
      else notesByCase.set(row.target, [row.data]);
    }
  }
  return { list, notesByCase };
}
