import { sql } from 'drizzle-orm';

/** Bind an entire UUID scope as one PostgreSQL parameter. Quote each element
 * so malformed input still reaches PostgreSQL as one invalid UUID. */
export function uuidArrayParam(ids: readonly string[]) {
  const encoded = ids.map(id => '"' + id.replace(/["\\]/g, '\\$&') + '"').join(',');
  return sql`${'{' + encoded + '}'}::uuid[]`;
}
