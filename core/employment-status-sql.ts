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
  // R81: the same four-step fallback deriveEmploymentStatus uses — a recorded confirmation first, then
  // the probation end date, then the provisional end date written at hire. See the TS twin for why the
  // last two are needed at all (nothing writes a confirmation date at hire).
  const confirmation = sql`coalesce(${employment.finalConfirmationDate}, ${employment.confirmationDate}, ${employment.probationEndDate}, ${employment.provisionalEndOn})`;
  return sql<EmploymentStatus>`case
    when ${employment.blacklistedAt} is not null then 'blacklisted'
    /* R81 'withhold' has NO branch here on purpose. The TypeScript twin reads emp.payrollHoldAt, an
       input that no column feeds (Payroll has no salary-hold setting yet), so the SQL twin has nothing
       to read and the branch would be a dead "when false then withhold". The two implementations
       therefore agree on every row the database can actually produce, which is what
       test/personnel-status-sync.test.ts pins. A BLOCK comment, not a line comment: this fragment is
       composed into larger statements and a stray -- would comment out whatever followed it on one line.
       When the payroll hold lands it adds the column, this branch, and the TS input together, in ONE
       change. */
    when ${ended} is not null and ${today}::date >= ${ended} then 'resigned'
    when ${ended} is not null then 'active_serving_notice'
    when ${confirmation} is not null and ${today}::date < ${confirmation} then 'probation'
    else 'active'
  end`;
}
