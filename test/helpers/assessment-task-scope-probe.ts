import { SQL, StringChunk, sql } from 'drizzle-orm';
import { expect } from 'vitest';

/** Replace only the assessment's self-exclusion with the already materialized own-employment set. */
export function assessmentWithOwnSet(query: SQL, own: SQL): SQL {
  let replacements = 0;
  const rewrite = (current: SQL): SQL => {
    const chunks = current.queryChunks;
    const [prefix, employment, suffix] = chunks;
    if (chunks.length === 3 && prefix instanceof StringChunk && suffix instanceof StringChunk
      && prefix.value.join('') === 'not exists(select 1 from employment e where e.id='
      && suffix.value.join('') === ' and app.is_self_person(e.person_id))') {
      replacements++;
      return sql`not coalesce(${employment}=any(${own}),false)`;
    }
    return new SQL(chunks.map(chunk => chunk instanceof SQL ? rewrite(chunk) : chunk));
  };
  const candidate = rewrite(query);
  expect(replacements).toBe(1);
  return candidate;
}
