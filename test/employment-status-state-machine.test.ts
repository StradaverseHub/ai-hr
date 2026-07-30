/**
 * Employee Status STATE MACHINE (feedback 9cbf5e0d, r81b) — the reporter's full rule set, pinned.
 *
 * This is the contract test for the item that supersedes r75. r75 aligned the SCREENS onto an existing
 * derivation; this pins the DERIVATION ITSELF: six statuses each produced by a real fixture, the three
 * retired statuses proven unreachable, and — the sharp edge — that no writer anywhere can set a status by
 * hand any more.
 *
 * WHAT EACH SECTION CATCHES
 *   §1  Every one of the six buckets is produced by a fixture, and the transitions between them happen
 *       from the DATES alone, with no save. Catches a rule being dropped or a priority being reordered.
 *   §2  The impossible transitions. A regression that lets, say, a resignation be outranked by a
 *       confirmation date would pass §1 (every bucket still reachable) and fail here.
 *   §3  No manual editing: the stored column and its enum are gone from the schema, the service parameter
 *       is gone, and a caller that supplies a status changes nothing. Catches the exact failure mode the
 *       brief warns about — an exported writer that is live whether or not any UI references it.
 *   §4  The retired vocabulary is gone from the app's own source and from every locale file, so it cannot
 *       reappear in a picker. Read from SOURCE, never rendered markup.
 *   §5  Probation actually works for a real hire — the defect r75 left behind, where a new hire serving a
 *       probation period displayed "Active" because nothing writes a confirmation date at hire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setEmploymentAssignment, setEmploymentBlacklist, setEmploymentInfo } from '../core/org';
import {
  deriveEmploymentStatus,
  EMPLOYMENT_STATUSES,
  type EmploymentStatus,
  type EmploymentStatusInput,
} from '../core/employment-status';
import { employmentStatusSql } from '../core/employment-status-sql';
import { withTenant } from '../db/client';
import { employeeDetail } from '../core/read';

const TODAY = '2026-07-15';
const RETIRED = ['on_leave', 'offboarding', 'terminated'] as const;

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const hire = (name: string, provisionalEndOn: string | null = null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `sm_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2026-01-05',
    provisionalEndOn,
  });

// ───────────────────────────── §1 · every bucket, from the dates alone ─────────────────────────────

describe('§1 the six statuses — each produced by a fixture, each a pure function of the dates', () => {
  // One row per bucket: the inputs that produce it, asserted as a VALUE (not "the save worked").
  const vectors: Array<{ bucket: EmploymentStatus; input: EmploymentStatusInput; why: string }> = [
    { bucket: 'probation', input: { confirmationDate: '2026-12-01' }, why: 'confirmation still ahead' },
    { bucket: 'active', input: { confirmationDate: '2026-03-01' }, why: 'confirmed in the past' },
    {
      bucket: 'active_serving_notice',
      input: { confirmationDate: '2026-03-01', resignationDate: '2026-12-31' },
      why: 'resignation recorded, last working day still ahead',
    },
    {
      bucket: 'resigned',
      input: { confirmationDate: '2026-03-01', resignationDate: '2026-06-01' },
      why: 'last working day reached',
    },
    { bucket: 'blacklisted', input: { blacklistedAt: '2026-04-01' }, why: 'blacklist event' },
    { bucket: 'withhold', input: { payrollHoldAt: '2026-04-01' }, why: 'payroll hold' },
  ];

  it('every declared bucket has a vector and no bucket is unreachable', () => {
    expect(vectors.map((v) => v.bucket).sort()).toEqual([...EMPLOYMENT_STATUSES].sort());
  });

  it.each(vectors)('$bucket ⟸ $why', ({ bucket, input }) => {
    expect(deriveEmploymentStatus(input, TODAY)).toBe(bucket);
  });

  // The whole point of deriving: the label moves on its own when the calendar reaches a date, with nobody
  // saving anything. One employee, one unchanged set of dates, four different answers on four days.
  it('one record walks Probation → Active → Serving Notice → Resigned as time passes, with no save', () => {
    // Phase A — hired, confirmation ahead, no resignation on the books yet.
    const before: EmploymentStatusInput = { confirmationDate: '2026-04-01' };
    expect(deriveEmploymentStatus(before, '2026-03-31')).toBe('probation');
    expect(deriveEmploymentStatus(before, '2026-04-01')).toBe('active'); // confirmation day itself
    expect(deriveEmploymentStatus(before, '2026-08-01')).toBe('active');

    // Phase B — a resignation is RECORDED. That is the one save in this story; every step after it is the
    // calendar moving. Note the resignation outranks probation from the instant it is on the books, which
    // §2 pins as deliberate: a leaver is never shown as still serving probation.
    const after: EmploymentStatusInput = { confirmationDate: '2026-04-01', resignationDate: '2026-09-30' };
    expect(deriveEmploymentStatus(after, '2026-08-01')).toBe('active_serving_notice');
    expect(deriveEmploymentStatus(after, '2026-09-29')).toBe('active_serving_notice');
    // Boundary: the LAST WORKING DAY itself already reads Resigned (>=, not >).
    expect(deriveEmploymentStatus(after, '2026-09-30')).toBe('resigned');
    expect(deriveEmploymentStatus(after, '2026-10-01')).toBe('resigned');
  });

  it('a resignation on the books outranks probation — an unconfirmed leaver is Serving Notice, not Probation', () => {
    expect(deriveEmploymentStatus({ confirmationDate: '2026-12-01', resignationDate: '2026-12-31' }, TODAY)).toBe(
      'active_serving_notice',
    );
  });
});

// ───────────────────────────── §2 · the transitions that are impossible ─────────────────────────────

describe('§2 impossible transitions — the priority ladder, pinned by counter-example', () => {
  it('blacklist outranks EVERY other input, including a payroll hold and a completed lifecycle', () => {
    const all: EmploymentStatusInput = {
      blacklistedAt: '2026-04-01',
      payrollHoldAt: '2026-04-01',
      resignationDate: '2026-01-01',
      confirmationDate: '2026-12-01',
      provisionalEndOn: '2026-12-01',
    };
    expect(deriveEmploymentStatus(all, TODAY)).toBe('blacklisted');
  });

  it('a payroll hold outranks the date ladder but never blacklist', () => {
    expect(deriveEmploymentStatus({ payrollHoldAt: '2026-04-01', confirmationDate: '2026-12-01' }, TODAY)).toBe('withhold');
    expect(deriveEmploymentStatus({ payrollHoldAt: '2026-04-01', resignationDate: '2026-01-01' }, TODAY)).toBe('withhold');
    expect(deriveEmploymentStatus({ payrollHoldAt: '2026-04-01', blacklistedAt: '2026-05-01' }, TODAY)).toBe('blacklisted');
  });

  it('a resigned employee can never read Probation or Active, whatever the confirmation date says', () => {
    for (const confirmation of ['2026-01-01', '2026-12-01', undefined]) {
      const st = deriveEmploymentStatus({ confirmationDate: confirmation, resignationDate: '2026-06-01' }, TODAY);
      expect(st, `confirmation=${confirmation}`).toBe('resigned');
    }
  });

  it('the EARLIEST end date wins — a later resignation cannot un-resign someone already gone', () => {
    expect(deriveEmploymentStatus({ lastWorkingDate: '2026-01-01', resignationDate: '2026-12-01' }, TODAY)).toBe('resigned');
    expect(deriveEmploymentStatus({ terminatedOn: '2026-01-01', resignationDate: '2026-12-01' }, TODAY)).toBe('resigned');
  });

  it('an employee with no dates at all is Active — never null, never a retired value', () => {
    const st = deriveEmploymentStatus({}, TODAY);
    expect(st).toBe('active');
    expect(EMPLOYMENT_STATUSES).toContain(st);
  });
});

// ───────────────────────────── §3 · no manual editing ─────────────────────────────

describe('§3 no manual editing — there is no writer, no column, and no parameter', () => {
  it('the schema has no assignment_status enum and no assignment.status column', () => {
    expect(Object.keys(schema.assignment)).not.toContain('status');
    expect(schema).not.toHaveProperty('assignmentStatusEnum');
  });

  it('the database itself has neither the column nor the type (migration 0326 really ran)', async () => {
    const col = await owner.db.execute(sql`select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'assignment' and column_name = 'status'`);
    expect(Array.from(col as unknown as unknown[])).toHaveLength(0);
    const typ = await owner.db.execute(sql`select 1 from pg_type where typname = 'assignment_status'`);
    expect(Array.from(typ as unknown as unknown[])).toHaveLength(0);
  });

  // The brief's warning, made a test: an exported `use server`/service function is callable whether or not
  // any UI references it. setEmploymentAssignment is THE assignment writer and used to take a status; a
  // caller that still passes one must change nothing — no dated version, no event, no value.
  it('setEmploymentAssignment ignores a supplied status: no new version, no event', async () => {
    const h = await hire('NoManual One');
    const before = await owner.db
      .select()
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, h.employmentId));
    expect(before).toHaveLength(1);

    const res = await setEmploymentAssignment(adminCtx(b), {
      employmentId: h.employmentId,
      effectiveDate: '2026-06-01',
      ...({ status: 'on_leave' } as Record<string, unknown>),
    });
    expect(res.changed).toBe(false);

    const after = await owner.db
      .select()
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, h.employmentId));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(await eventTypesFor(b.tenantId, before[0].id)).not.toContain('employment.assignment.changed');
  });

  // The ONE remaining way to move an employee to an exception status is an EVENT with its own service and
  // its own audit record — which is the model the reporter asked for: record what happened, not the label.
  it('blacklist moves the status, and only through its own audited event', async () => {
    const h = await hire('Blacklist One');
    const detailBefore = await employeeDetail(adminCtx(b), h.employmentId);
    expect(deriveEmploymentStatus(detailBefore!, TODAY)).toBe('active');

    await setEmploymentBlacklist(adminCtx(b), { employmentId: h.employmentId, blacklisted: true, reason: 'sm test' });
    const detailAfter = await employeeDetail(adminCtx(b), h.employmentId);
    expect(deriveEmploymentStatus(detailAfter!, TODAY)).toBe('blacklisted');
    expect(await eventTypesFor(b.tenantId, h.employmentId)).toContain('employment.blacklisted');

    // ...and clearing it puts them back where the DATES say they belong, not where anyone typed.
    await setEmploymentBlacklist(adminCtx(b), { employmentId: h.employmentId, blacklisted: false });
    const detailCleared = await employeeDetail(adminCtx(b), h.employmentId);
    expect(deriveEmploymentStatus(detailCleared!, TODAY)).toBe('active');
  });

  it('recording a resignation — an event, not a label — is what produces Serving Notice then Resigned', async () => {
    const h = await hire('Resign One');
    await setEmploymentInfo(adminCtx(b), { employmentId: h.employmentId, resignationDate: '2026-12-31' });
    const d = await employeeDetail(adminCtx(b), h.employmentId);
    expect(deriveEmploymentStatus(d!, TODAY)).toBe('active_serving_notice');
    expect(deriveEmploymentStatus(d!, '2027-01-01')).toBe('resigned');
  });
});

// ───────────────────────────── §4 · the retired vocabulary is gone ─────────────────────────────

describe('§4 the three retired statuses are gone from every surface that could offer them', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  // Source, not rendered markup: Next embeds the whole i18n catalog, so a rendered-HTML assertion here
  // would find the retired words in the payload of a page that never shows them.
  it.each([
    'app/performance/new-cycle-form.tsx',
    'app/performance/actions.ts',
    'app/payroll/process/steps/step-selection.tsx',
  ])('%s offers no retired status value', (rel) => {
    const src = read(rel);
    for (const v of RETIRED) {
      expect(src, `${rel} still names ${v}`).not.toMatch(new RegExp(`['"]${v}['"]`));
    }
  });

  // The analytics filter bar gets a NARROWER check on purpose. It carries a separate LIFECYCLE control
  // whose values are 'active' / 'terminated' — that is employment.terminated_on (has this person left?),
  // not an Employee Status, and the same word appearing there is not the retired status value. Asserting
  // the blunt "no 'terminated' anywhere" would fail on a control this item does not touch. The two RETIRED
  // values that ARE unambiguous still get checked, plus the positive assertion that matters most: the
  // status options come from the resolver.
  it('the analytics filter bar sources status options from the resolver and offers no retired status', () => {
    const src = read('app/analytics/FilterBar.tsx');
    expect(src).toContain('EMPLOYMENT_STATUSES');
    expect(src).not.toMatch(/['"]on_leave['"]/);
    expect(src).not.toMatch(/['"]offboarding['"]/);
  });

  it('the performance eligibility picker is sourced from the resolver, not a private list', () => {
    expect(read('app/performance/new-cycle-form.tsx')).toContain('EMPLOYMENT_STATUSES');
    expect(read('app/performance/actions.ts')).toContain('EMPLOYMENT_STATUSES');
  });

  // The i18n guard (scripts/i18n-check.mjs) skips files using more than one namespace and only matches a
  // literal t('key'), so these labels are checked here by hand instead of being assumed covered.
  it.each(['en', 'ms', 'ta', 'th', 'vi', 'zh'])(
    '%s carries all six employeeStatus labels and no retired ones, in both label blocks',
    (locale) => {
      const m = JSON.parse(read(path.join('messages', `${locale}.json`))) as {
        people: { employeeStatus: Record<string, string> };
        performance: { eligibility: Record<string, string> };
      };
      for (const bucket of EMPLOYMENT_STATUSES) {
        expect(m.people.employeeStatus[bucket], `${locale}:people.employeeStatus.${bucket}`).toBeTruthy();
        expect(
          m.performance.eligibility[`status_${bucket}`],
          `${locale}:performance.eligibility.status_${bucket}`,
        ).toBeTruthy();
      }
      for (const v of RETIRED) {
        expect(m.people.employeeStatus[v], `${locale}:people.employeeStatus.${v}`).toBeUndefined();
        expect(m.performance.eligibility[`status_${v}`], `${locale}:eligibility.status_${v}`).toBeUndefined();
      }
      // Every bucket label must be a DISTINCT string, or two statuses read identically to a user.
      const labels = EMPLOYMENT_STATUSES.map((s) => m.people.employeeStatus[s]);
      expect(new Set(labels).size, `${locale} has duplicate status labels`).toBe(labels.length);
    },
  );
});

// ───────────────────────────── §5 · probation, for a real hire ─────────────────────────────

describe('§5 Probation until confirmed — the rule that was not working', () => {
  // r75 pointed the screens at the deriver, but the deriver read only the confirmation dates and NOTHING
  // writes one at hire — hireEmployee records provisional_end_on. So a new hire serving probation displayed
  // "Active" from day one unless somebody typed a Confirmation Date. This is that defect, end to end.
  it('a hire with a probation period reads Probation through the real read path, then Active', async () => {
    const h = await hire('Probation Real', '2026-04-01');
    const d = await employeeDetail(adminCtx(b), h.employmentId);
    expect(d, 'employeeDetail must project the probation inputs').not.toBeNull();
    expect(deriveEmploymentStatus(d!, '2026-02-01')).toBe('probation');
    expect(deriveEmploymentStatus(d!, '2026-03-31')).toBe('probation');
    expect(deriveEmploymentStatus(d!, '2026-04-01')).toBe('active');
  });

  it('the SQL twin agrees with TypeScript on that same hire — including the probation fallback', async () => {
    const h = await hire('Probation Sql', '2026-04-01');
    const rows = await withTenant(adminCtx(b), (tx) =>
      tx
        .select({ id: schema.employment.id, derived: employmentStatusSql('2026-02-01') })
        .from(schema.employment)
        .where(eq(schema.employment.id, h.employmentId)),
    );
    expect(rows[0].derived).toBe('probation');
    const later = await withTenant(adminCtx(b), (tx) =>
      tx
        .select({ derived: employmentStatusSql('2026-04-01') })
        .from(schema.employment)
        .where(eq(schema.employment.id, h.employmentId)),
    );
    expect(later[0].derived).toBe('active');
  });

  it('an explicitly recorded confirmation date always beats the probation end date', async () => {
    const h = await hire('Probation Override', '2026-04-01');
    // Confirmed EARLY: the recorded confirmation is the event, so probation ends when it says.
    await setEmploymentInfo(adminCtx(b), { employmentId: h.employmentId, confirmationDate: '2026-02-15' });
    const d = await employeeDetail(adminCtx(b), h.employmentId);
    expect(deriveEmploymentStatus(d!, '2026-02-14')).toBe('probation');
    expect(deriveEmploymentStatus(d!, '2026-02-15')).toBe('active');
    // ...and still Active on a day the raw provisional end date would have called Probation.
    expect(deriveEmploymentStatus(d!, '2026-03-20')).toBe('active');
  });

  it('a hire with NO probation period is Active from day one', async () => {
    const h = await hire('No Probation', null);
    const d = await employeeDetail(adminCtx(b), h.employmentId);
    expect(deriveEmploymentStatus(d!, '2026-01-05')).toBe('active');
  });
});
