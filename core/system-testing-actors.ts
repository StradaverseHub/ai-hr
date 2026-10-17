/** Resolve only names already visible to this reader; a Testing assignment grants no Person access. */
import { and, eq, inArray } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { appUser, person } from '../db/schema';
import { TestingRefusal } from '../lib/system-testing/model';

export async function testingActorNamesTx(tx: Tx, ctx: SessionContext, userIds: readonly (string | null)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length > 1000) throw new TestingRefusal('limit');
  if (!ids.length) return new Map<string, string | null>();
  const rows = await tx.select({ userId: appUser.id, name: person.fullName }).from(appUser)
    .leftJoin(person, and(eq(person.id, appUser.personId), eq(person.tenantId, ctx.tenantId)))
    .where(and(eq(appUser.tenantId, ctx.tenantId), inArray(appUser.id, ids))).orderBy(appUser.id);
  return new Map(rows.map(row => [row.userId, row.name]));
}
