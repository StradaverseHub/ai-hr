import type { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import { expect } from 'vitest';

type Compiled = ReturnType<PgDialect['sqlToQuery']>;

// A fixture-only comparison against the real compiled statement. Runtime owners
// would construct typed predicates directly instead of rewriting compiled SQL.
export function arrayScope(query: Compiled, ids: readonly string[]) {
  const members = String.raw`\$\d+(?:\s*::\s*uuid)?(?:\s*,\s*\$\d+(?:\s*::\s*uuid)?)*`;
  const list = new RegExp(String.raw`\bARRAY\s*\[\s*(${members})\s*\]\s*::\s*uuid\s*\[\s*\]|\bIN\s*\(\s*(${members})\s*\)`, 'gi');
  const marker = 'test_scope_uuid_array_placeholder';
  let rewritten = 0;
  const collapsed = query.sql.replace(list, (original: string, array: string | undefined, insideIn: string | undefined) => {
    const positions = [...(array ?? insideIn ?? '').matchAll(/\$(\d+)/g)].map(match => Number(match[1]) - 1);
    if (positions.length !== ids.length || positions.some((position, index) => query.params[position] !== ids[index])) return original;
    rewritten++;
    return insideIn ? `= ANY(${marker}::uuid[])` : `${marker}::uuid[]`;
  });
  expect(rewritten).toBeGreaterThan(0);
  const params: postgres.ParameterOrJSON<never>[] = ['{' + ids.join(',') + '}'];
  const remap = new Map<number, number>();
  const statement = collapsed.replace(/\$(\d+)/g, (_token, raw: string) => {
    const position = Number(raw) - 1;
    let target = remap.get(position);
    if (target === undefined) {
      params.push(query.params[position] as postgres.ParameterOrJSON<never>);
      target = params.length;
      remap.set(position, target);
    }
    return '$' + target;
  }).replaceAll(marker, '$1');
  return { statement, params, rewritten };
}
