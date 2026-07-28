/**
 * The SQL twin of core/employment-status.ts (feedback 9cbf5e0d), kept in its OWN module for one reason:
 * employment-status.ts is imported by CLIENT components (the analytics filter bar needs the bucket list),
 * and pulling drizzle + db/schema into the browser bundle through it is not acceptable. Everything here is
 * server-only.
 */
import { sql, type SQL } from 'drizzle-orm';
import { employment } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { EmploymentStatus } from './employment-status';

/**
 * The SQL twin of deriveEmploymentStatus, over the `employment` columns, as of `today` ('YYYY-MM-DD').
 *
 * Feedback 9cbf5e0d — two surfaces cannot use the TypeScript function: the analytics Employee Status FILTER
 * is a WHERE predicate, and the Payroll Register report projects the status as a column of a wide read. They
 * were both still showing the legacy stored `assignment.status`, whose retired values (On Leave / Offboarding
 * / Terminated) are exactly what the request asks to remove. Rather than let two screens keep their own
 * private rule, the rule is written once per LANGUAGE — the same discipline as isEmploymentEnded and
 * app.login_blocked() — and test/personnel-status-sync.test.ts pins the two implementations equal across a
 * matrix of employments, so a change to one that is not mirrored in the other fails.
 *
 * `least()` ignores NULLs in Postgres, which is precisely what earliest() does above. The branch order is
 * the same first-match-wins ladder.
 */
export function employmentStatusSql(today: string = todayInKualaLumpur()): SQL<EmploymentStatus> {
  const ended = sql`least(${employment.resignationDate}, ${employment.lastWorkingDate}, ${employment.terminatedOn})`;
  const confirmation = sql`coalesce(${employment.finalConfirmationDate}, ${employment.confirmationDate})`;
  return sql<EmploymentStatus>`case
    when ${employment.blacklistedAt} is not null then 'blacklisted'
    when ${ended} is not null and ${today}::date >= ${ended} then 'resigned'
    when ${ended} is not null then 'active_serving_notice'
    when ${confirmation} is not null and ${today}::date < ${confirmation} then 'probation'
    else 'active'
  end`;
}
