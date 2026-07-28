/**
 * Employee Status sync (5afcda91) — the Personnel (Admin) module and every other employee-status surface
 * show ONE system-derived Employee Status (deriveEmploymentStatus over the lifecycle dates), and the
 * obsolete legacy assignment statuses (On Leave / Offboarding / Terminated) no longer render anywhere.
 *
 * Three layers:
 *  1. DB → payload: for each derived bucket vector, the read payloads the fixed screens consume
 *     (listEmployeesPage for the directory/search results, employeeDetail for the profile card,
 *     recentHires for the dashboard Onboarding card) carry the lifecycle inputs the deriver needs and
 *     derive to the expected bucket — proving the same employee reads the same status on every screen.
 *  2. Source drift guard (precedent: test/layout-scroll-containment.test.ts): the two formerly-stale
 *     pages derive via deriveEmploymentStatus and no longer pass raw/legacy statuses to StatusBadge, and
 *     the StatusBadge vocabulary itself has no on_leave / offboarding / terminated entries.
 *  3. i18n: the badge labels for all five buckets exist (non-empty) in all six locales.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setEmploymentBlacklist, setEmploymentInfo } from '../core/org';
import { employeeDetail, listEmployeesPage, recentHires } from '../core/read';
import { deriveEmploymentStatus, EMPLOYMENT_STATUSES, type EmploymentStatus } from '../core/employment-status';
import { employmentStatusSql } from '../core/employment-status-sql';
import { workforceDemographics } from '../core/analytics';
import { withTenant } from '../db/client';
import { employment } from '../db/schema';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

/** Fixed "today" so every vector is deterministic — the deriver is pure in (inputs, today). */
const TODAY = '2026-07-15';
const HIRED_ON = '2026-02-01';

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `ess_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: HIRED_ON,
  });

describe('Employee Status sync — one derived status across every payload (5afcda91)', () => {
  // employmentId → the bucket each vector must derive to, on every surface.
  const expected = new Map<string, EmploymentStatus>();

  beforeAll(async () => {
    // probation — confirmation date still in the future.
    const probation = await hire('Vector Probation');
    await setEmploymentInfo(adminCtx(b), { employmentId: probation.employmentId, confirmationDate: '2026-12-01' });
    expected.set(probation.employmentId, 'probation');

    // active — confirmed in the past, no resignation.
    const active = await hire('Vector Active');
    await setEmploymentInfo(adminCtx(b), { employmentId: active.employmentId, confirmationDate: '2026-03-01' });
    expected.set(active.employmentId, 'active');

    // active_serving_notice — resignation recorded, effective date still ahead.
    const notice = await hire('Vector ServingNotice');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: notice.employmentId,
      confirmationDate: '2026-03-01',
      resignationDate: '2026-12-31',
    });
    expected.set(notice.employmentId, 'active_serving_notice');

    // resigned — resignation date already reached.
    const resigned = await hire('Vector Resigned');
    await setEmploymentInfo(adminCtx(b), {
      employmentId: resigned.employmentId,
      confirmationDate: '2026-03-01',
      resignationDate: '2026-06-01',
    });
    expected.set(resigned.employmentId, 'resigned');

    // blacklisted — the one stored, event-driven override; wins over every date bucket.
    const blacklisted = await hire('Vector Blacklisted');
    await setEmploymentBlacklist(adminCtx(b), {
      employmentId: blacklisted.employmentId,
      blacklisted: true,
      reason: 'Status sync vector',
    });
    expected.set(blacklisted.employmentId, 'blacklisted');
  });

  it('covers every derived bucket with a vector', () => {
    expect(new Set(expected.values())).toEqual(new Set(EMPLOYMENT_STATUSES));
  });

  it('directory / search payload (listEmployeesPage) derives each bucket', async () => {
    const { rows } = await listEmployeesPage(adminCtx(b), { limit: 200, offset: 0 });
    for (const [employmentId, bucket] of expected) {
      const row = rows.find((r) => r.employmentId === employmentId);
      expect(row, `row for ${bucket}`).toBeDefined();
      expect(deriveEmploymentStatus(row!, TODAY), bucket).toBe(bucket);
    }
  });

  it('profile / information-card payload (employeeDetail) derives each bucket identically', async () => {
    for (const [employmentId, bucket] of expected) {
      const emp = await employeeDetail(adminCtx(b), employmentId);
      expect(emp, `detail for ${bucket}`).not.toBeNull();
      expect(deriveEmploymentStatus(emp!, TODAY), bucket).toBe(bucket);
    }
  });

  // 9cbf5e0d — the two surfaces that could not call the TS function (a WHERE predicate and a wide report
  // projection) use employmentStatusSql instead. The rule is now written once per LANGUAGE, so this pins the
  // two implementations equal across every vector — a change to one that is not mirrored fails here.
  it('the SQL twin (employmentStatusSql) agrees with the TypeScript deriver on every vector', async () => {
    const rows = await withTenant(adminCtx(b), (tx) =>
      tx
        .select({ employmentId: employment.id, derived: employmentStatusSql(TODAY) })
        .from(employment),
    );
    const seen = new Map(rows.map((r) => [r.employmentId, r.derived]));
    for (const [employmentId, bucket] of expected) {
      expect(seen.get(employmentId), `sql for ${bucket}`).toBe(bucket);
    }
  });

  it('the analytics Employee Status chart tallies the same buckets (no retired stored values)', async () => {
    const d = await workforceDemographics(adminCtx(b), undefined, { asOf: TODAY });
    const counts = new Map(d.byEmploymentStatus.map((r) => [r.name, r.count]));
    for (const bucket of EMPLOYMENT_STATUSES) {
      expect(counts.get(bucket), `chart bucket ${bucket}`).toBe(1);
    }
    // Nothing outside the five derived buckets may reach the chart.
    expect(d.byEmploymentStatus.every((r) => (EMPLOYMENT_STATUSES as readonly string[]).includes(r.name))).toBe(true);
  });

  it('dashboard Onboarding payload (recentHires) carries the deriver inputs and agrees', async () => {
    const hires = await recentHires(adminCtx(b), [b.companyId], { since: HIRED_ON, limit: 50 });
    for (const [employmentId, bucket] of expected) {
      const row = hires.find((r) => r.employmentId === employmentId);
      // recentHires only excludes employments with terminatedOn set; none of the vectors are terminated.
      expect(row, `hire row for ${bucket}`).toBeDefined();
      expect(deriveEmploymentStatus(row!, TODAY), bucket).toBe(bucket);
    }
  });
});

describe('drift guard — no surface renders the obsolete statuses', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  const DIRECTORY = read('app/personnel/page.tsx');
  const PROFILE = read('app/personnel/[employmentId]/page.tsx');
  const DASHBOARD = read('app/page.tsx');
  const UI = read('components/ui.tsx');

  it('the staff directory derives status and never badges a raw/legacy value', () => {
    expect(DIRECTORY).toContain('deriveEmploymentStatus');
    expect(DIRECTORY).not.toMatch(/on_leave|offboarding/);
    // The stale pattern was `status={e.terminatedOn ? 'terminated' : e.status}` — no literal status may
    // reach StatusBadge any more (the ?status= filter's 'terminated' QUERY value is not a display).
    expect(DIRECTORY).not.toMatch(/StatusBadge\s+status=\{[^}]*'terminated'/);
  });

  it('the employee-facing profile derives status and never badges a raw/legacy value', () => {
    expect(PROFILE).toContain('deriveEmploymentStatus');
    expect(PROFILE).not.toMatch(/on_leave|offboarding/);
    expect(PROFILE).not.toMatch(/StatusBadge\s+status=\{[^}]*'terminated'/);
  });

  it('the dashboard Onboarding card derives status instead of showing raw assignment.status', () => {
    expect(DASHBOARD).toContain('deriveEmploymentStatus');
    expect(DASHBOARD).not.toMatch(/StatusBadge\s+status=\{h\.status\}/);
  });

  // 9cbf5e0d — the two surfaces that were still reading the legacy stored enum. Source-level, because the
  // failure mode is a future edit quietly reintroducing `assignment.status` into either projection.
  it('the analytics dashboard and the Payroll Register read the derived status, not assignment.status', () => {
    const ANALYTICS = read('core/analytics.ts');
    const PAYROLL_VIEW = read('core/payroll-view.ts');
    expect(ANALYTICS).toContain('employmentStatusSql');
    expect(ANALYTICS).not.toMatch(/assignmentStatus:\s*assignment\.status/);
    expect(PAYROLL_VIEW).toContain('employmentStatusSql');
    expect(PAYROLL_VIEW).not.toMatch(/employmentStatus:\s*assignment\.status/);
    // The dashboard filter must offer the derived buckets, never the retired stored ones.
    const FILTER_BAR = read('app/analytics/FilterBar.tsx');
    expect(FILTER_BAR).toContain('EMPLOYMENT_STATUSES');
    expect(FILTER_BAR).not.toMatch(/on_leave|offboarding/);
  });

  it('the StatusBadge vocabulary contains exactly the five derived buckets — no legacy keys', () => {
    const block = UI.match(/const STATUS_STYLES[\s\S]*?\n\};/)?.[0];
    expect(block).toBeDefined();
    for (const bucket of EMPLOYMENT_STATUSES) expect(block!).toMatch(new RegExp(`^\\s*${bucket}:`, 'm'));
    expect(block!).not.toMatch(/^\s*(on_leave|offboarding|terminated):/m);
  });
});

describe('i18n — badge labels for all five buckets in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  it.each(LOCALES)('%s has people.employeeStatus.* for every bucket', (locale) => {
    const messages = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'messages', `${locale}.json`), 'utf8'),
    ) as { people?: { employeeStatus?: Record<string, string> } };
    const labels = messages.people?.employeeStatus ?? {};
    for (const bucket of EMPLOYMENT_STATUSES) {
      expect(labels[bucket], `${locale}:${bucket}`).toBeTruthy();
    }
  });
});
