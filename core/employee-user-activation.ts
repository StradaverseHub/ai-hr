import { and, eq, notExists } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, employment, person } from '../db/schema';
import { isLoginBlocked } from './employment-status';

/** A pending directory entry is a projection of a person with employment, never a fake login.
 * No provider account, credential or grant exists until an administrator activates access. */
export async function listEmployeeActivationCandidates(ctx: SessionContext) {
  const grants = ctx.grants ?? (ctx.roles ?? []).map(role => ({ role, companyId: null }));
  if (!grants.some(g => g.role === 'super_admin' || (g.role === 'hr_admin' && g.companyId == null))) {
    throw new Error('Only a group administrator can prepare employee logins.');
  }
  return withTenant(ctx, async tx => {
    const rows = await tx.select({
      id: person.id, name: person.fullName, email: person.primaryEmail,
      code: employment.employeeCode,
      resignationDate: employment.resignationDate, lastWorkingDate: employment.lastWorkingDate,
      terminatedOn: employment.terminatedOn, blacklistedAt: employment.blacklistedAt,
    }).from(person).innerJoin(employment, and(eq(employment.personId, person.id), eq(employment.tenantId, person.tenantId)))
      .where(and(eq(person.tenantId, ctx.tenantId), notExists(tx.select({ id: appUser.id }).from(appUser)
        .where(and(eq(appUser.tenantId, person.tenantId), eq(appUser.personId, person.id))))))
      .orderBy(person.fullName, person.id, employment.employeeCode, employment.id);
    const people = new Map<string, typeof rows>();
    for (const row of rows) {
      const employments = people.get(row.id) ?? [];
      employments.push(row);
      people.set(row.id, employments);
    }
    return [...people.values()].filter(employments => !isLoginBlocked({ employments }))
      .map(([p]) => ({ id: p.id, name: p.name, email: p.email, code: p.code }));
  });
}
