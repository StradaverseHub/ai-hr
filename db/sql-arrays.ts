/** One statement shape for "any of these ids" (ADR 0181 decision 5, Phase 4).
 *
 * drizzle's `inArray(column, ids)` sends one bind parameter per id, so "All companies" over 10 companies and over 74
 * companies are two different statements to the planner and to `pg_stat_statements`, and a 70-company group pays for
 * a 70-parameter parse on every list read. `= any($1::uuid[])` is one parameter whatever the length: one statement
 * shape, one plan cache entry and one `pg_stat_statements` row.
 *
 * The array travels as a Postgres array literal in a single text parameter (the form core/roster.ts and
 * core/system-labels.ts already use), so it does not depend on the driver's array serialisation. Every element is
 * checked to be a canonical UUID first: a malformed value would otherwise fail the cast inside the statement with a
 * database error rather than a plain application error. Duplicates are kept (`= any` does not care). */
import { sql, type SQL } from 'drizzle-orm';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids as one `uuid[]` bind parameter. Refuses anything that is not a UUID. */
export function uuidArrayParam(ids: readonly string[]): SQL<string[]> {
  for (const id of ids) if (typeof id !== 'string' || !UUID.test(id)) throw new RangeError('Invalid identifier list');
  return sql<string[]>`${'{' + ids.join(',') + '}'}::uuid[]`;
}

/** `column = any($1::uuid[])`. An empty list matches nothing, exactly like `inArray(column, [])`. */
export function anyUuid(column: SQL | SQL.Aliased | { getSQL(): SQL } | unknown, ids: readonly string[]): SQL {
  return sql`${column} = any(${uuidArrayParam(ids)})`;
}
