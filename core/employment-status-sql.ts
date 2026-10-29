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
/**
 * THE effective confirmation date, in SQL — R81's four-step fallback: a recorded confirmation first
 * (`finalConfirmationDate` already folds in any probation extension), then `confirmationDate`, then the
 * probation END date, then the provisional end date written at hire. See the TS twin
 * (`deriveEmploymentStatus`) for why the last two are needed at all — nothing writes a confirmation date at
 * hire, so without them every new hire derives to "Active" on day one.
 *
 * 18103ba4 EXPORTED IT. The Leave Adjustments criteria builder offers a "Confirmation Status" axis, which is
 * the SAME question the status ladder's `probation` branch asks (`asOf < confirmation`). Writing that
 * coalesce a second time is how a screen ends up saying "on probation" while the employee's status badge two
 * pages away says "Active". One expression, two readers.
 *
 * ⚠️ NOT the same as `onProbationAsOf` in core/leave.ts, which coalesces only the first TWO columns. That
 * is the older, narrower leave-eligibility rule and it is deliberately left alone — changing it would change
 * who qualifies for a confirmed_only leave type, which is not this item's business.
 */
/** Alternate typed projection columns let scoped readers reuse this same SQL status owner. */
export type EmploymentStatusColumns = {
  finalConfirmationDate: SQL;
  confirmationDate: SQL;
  probationEndDate: SQL;
  provisionalEndOn: SQL;
  resignationDate: SQL;
  lastWorkingDate: SQL;
  terminatedOn: SQL;
  blacklistedAt: SQL;
};
const statusColumns: EmploymentStatusColumns = {
  finalConfirmationDate: sql`${employment.finalConfirmationDate}`,
  confirmationDate: sql`${employment.confirmationDate}`,
  probationEndDate: sql`${employment.probationEndDate}`,
  provisionalEndOn: sql`${employment.provisionalEndOn}`,
  resignationDate: sql`${employment.resignationDate}`,
  lastWorkingDate: sql`${employment.lastWorkingDate}`,
  terminatedOn: sql`${employment.terminatedOn}`,
  blacklistedAt: sql`${employment.blacklistedAt}`,
};
export function confirmationDateSql(columns: EmploymentStatusColumns = statusColumns): SQL<string | null> {
  return sql<string | null>`app.employment_confirmation_date((${columns.finalConfirmationDate})::date, (${columns.confirmationDate})::date, (${columns.probationEndDate})::date, (${columns.provisionalEndOn})::date)`;
}

/** True when the employment is still WITHIN its probation as at `asOf` — the status ladder's rule 5, alone. */
export function onProbationSql(asOf: string): SQL<boolean> {
  const confirmation = confirmationDateSql();
  return sql<boolean>`(${confirmation} is not null and ${asOf}::date < ${confirmation})`;
}

export function employmentStatusSql(
  today: string = todayInKualaLumpur(),
  columns: EmploymentStatusColumns = statusColumns,
): SQL<EmploymentStatus> {
  return sql<EmploymentStatus>`app.employment_status_on((${columns.blacklistedAt})::timestamptz,(${columns.resignationDate})::date,(${columns.lastWorkingDate})::date,(${columns.terminatedOn})::date,(${columns.finalConfirmationDate})::date,(${columns.confirmationDate})::date,(${columns.probationEndDate})::date,(${columns.provisionalEndOn})::date,${today}::date)`;
}
