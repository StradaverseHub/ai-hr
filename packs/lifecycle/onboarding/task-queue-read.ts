/** Candidate selection for the existing task interpreter. These predicates never grant row access. */
import { sql, type SQL } from 'drizzle-orm';
import { lcOnboardingCase as cases, lcOnboardingNote as notes } from '../../../db/schema';

const jsonFalsy = (value: SQL) => sql`
  coalesce(${value}, 'null'::jsonb) in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
`;
const malformedArray = (value: SQL) => sql`
  (jsonb_typeof(${value}) is distinct from 'array' or ${value} @> '[null]'::jsonb)
`;

/** Older malformed mention values still reach the canonical interpreter; a valid unrelated note cannot. */
export function possibleOnboardingMention(userId: string) {
  const mentions = sql`${notes.data}->'mentions'`;
  return sql`(jsonb_typeof(${mentions}) is distinct from 'array' or ${mentions} ? ${userId})`;
}

export function possibleOnboardingTaskCase(userId: string, module: boolean) {
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
    else exists (select 1 from ${notes}
      where ${notes.tenantId} = ${cases.tenantId} and ${notes.caseId} = ${cases.id}
        and ${possibleOnboardingMention(userId)}) end`;
}
