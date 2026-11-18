import { date, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * ADR-0142 / VF-07 — what OneHR administration reads in place of `employment` and `assignment`.
 *
 * The performance partner holds no policy on either table (0611): a row carries termination reasons, cost
 * allocation, payroll policy and the like. These are the invoker views app.onehr_employment and
 * app.onehr_assignment (0611 §3): the caller's own RLS-filtered row wins, and the definer projections
 * app.onehr_employment_facts / app.onehr_assignment_facts add, column by column, only the rows of the
 * partner's companies the caller cannot read. For every actor who is not a performance partner the views
 * return exactly the rows `employment` / `assignment` return, so HR's results are unchanged.
 *
 * Column names match the kernel tables, so a OneHR administration reader swaps `employment` for
 * `onehrEmployment` without changing its shape. Only the columns below exist: a reader that needs any other
 * employment column is not an administration read, and must not be routed here.
 */
const app = pgSchema('app');

export const onehrEmployment = app
  .view('onehr_employment', {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    personId: uuid('person_id').notNull(),
    companyId: uuid('company_id').notNull(),
    employeeCode: text('employee_code'),
    gradeId: uuid('grade_id'),
    hiredOn: date('hired_on').notNull(),
    confirmationDate: date('confirmation_date'),
    terminatedOn: date('terminated_on'),
  })
  .existing();

export const onehrAssignment = app
  .view('onehr_assignment', {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    employmentId: uuid('employment_id').notNull(),
    departmentId: uuid('department_id').notNull(),
    positionId: uuid('position_id'),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  })
  .existing();
