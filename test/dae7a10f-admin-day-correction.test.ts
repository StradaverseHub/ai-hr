/**
 * dae7a10f — an administrator fixes a day in one action, and still leaves the same trail.
 *
 * THE TICKET ASKED FOR IT "WITHOUT GOING THROUGH THE APPROVAL WORKFLOW", and the plan agreed with a
 * stated difference before this was built. What an administrator should not have to do is WAIT for
 * somebody else. What nobody skips is the record — a corrected clock time changes overtime, and overtime
 * is paid.
 *
 * ⚠️ THE PERMISSION BARRIER THE TICKET ASSUMES DOES NOT EXIST. `assertCanDecide` computes `isSelf` as
 * `subject.personId === ctx.personId`: the rule is "the decider is not the SUBJECT EMPLOYEE", not "the
 * decider is not the requester". An HR admin deciding somebody else's correction was ALWAYS allowed, so
 * the two-step was a UI shape and not a permission, and this needs no new authority and no exemption.
 *
 * WHAT THIS FILE REFUSES TO LET DRIFT
 *   1. the one-action path is request-then-decide, never a direct write to the attendance row;
 *   2. an administrator may not approve a correction to their OWN attendance — and the request SURVIVES
 *      that refusal as pending, so the work is not lost, it simply needs another approver;
 *   3. the employment is re-guarded against the caller's own scope, not trusted from the form.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { requestAttendanceCorrection, decideAttendanceCorrection } from '../core/attendance';
import { adminCtx, closeAll, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = join(__dirname, '..');
const src = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const ACTION = src('app/attendance/individual/[date]/actions.ts');
const DAY_PAGE = src('app/attendance/individual/[date]/page.tsx');
const LIST_PAGE = src('app/attendance/individual/page.tsx');

let b: Base;
const DATE = '2026-07-27';
const uniqEmail = () => `dae_${Math.random().toString(36).slice(2, 10)}@t.local`;

async function hire(name = 'Day Worker') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return { employmentId: e.employmentId, personId: e.personId };
}

/** An HR ADMIN who is also a PERSON — which is what makes `isSelf` reachable at all. `adminCtx` carries
 *  no personId, so it can never be the subject and could never exercise the refusal. */
const adminAsPerson = (personId: string): SessionContext => ({
  ...adminCtx(b),
  personId,
  entitlements: harnessSnapshot(b.tenantId),
});

const correctionRow = async (id: string) => {
  const [r] = await owner.db
    .select({ status: schema.attendanceCorrection.status, reason: schema.attendanceCorrection.reason })
    .from(schema.attendanceCorrection)
    .where(eq(schema.attendanceCorrection.id, id));
  return r;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('dae7a10f · one action, and the same trail', () => {
  it('an admin correcting SOMEBODY ELSE’s day gets it applied immediately', async () => {
    const { employmentId } = await hire();
    const a = adminCtx(b);

    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Gate log shows 18:00; device missed the punch',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    const row = await correctionRow(correctionId);
    expect(row.status, 'approved in the same breath it was raised').toBe('approved');
    expect(row.reason, 'and the reason is on the record, not in a log elsewhere').toContain('Gate log');
  });

  /**
   * ⚠️ THE SECURITY CASE. An administrator is very often also an employee. If the one-action path
   * swallowed this refusal, an admin could approve their own overtime — which is the single thing this
   * whole design must not allow.
   */
  it('an admin may NOT approve a correction to their own attendance', async () => {
    const { employmentId, personId } = await hire('Admin Who Is Also Staff');
    const self = adminAsPerson(personId);

    const { correctionId } = await requestAttendanceCorrection(self, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '19:30',
      reason: 'my own overtime',
    });

    await expect(
      decideAttendanceCorrection(self, { correctionId, decision: 'approved' }),
      'self-approval must be refused',
    ).rejects.toThrow(/cannot decide your own/i);
  });

  /** …AND THE WORK IS NOT LOST. The refusal leaves the request PENDING, so it simply needs another
   *  approver — which is exactly what the two-step screen would have produced. */
  it('and the refused self-correction stays pending rather than vanishing', async () => {
    const { employmentId, personId } = await hire('Admin Who Is Also Staff');
    const self = adminAsPerson(personId);

    const { correctionId } = await requestAttendanceCorrection(self, {
      employmentId, date: DATE, checkIn: '09:00', checkOut: '19:30', reason: 'my own overtime',
    });
    await expect(decideAttendanceCorrection(self, { correctionId, decision: 'approved' })).rejects.toThrow();

    expect((await correctionRow(correctionId)).status, 'still there, awaiting somebody else').toBe('pending');
  });

  it('a second decision on an already-approved correction is refused', async () => {
    const { employmentId } = await hire();
    const a = adminCtx(b);
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId, date: DATE, checkIn: '09:00', checkOut: '18:00', reason: 'fix',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await expect(
      decideAttendanceCorrection(a, { correctionId, decision: 'approved' }),
      'approving twice would re-derive the day a second time',
    ).rejects.toThrow(/already approved/i);
  });
});

describe('dae7a10f · the action composes the services, and writes nothing itself', () => {
  it('calls request THEN decide, and never touches the attendance row', () => {
    expect(ACTION).toContain('requestAttendanceCorrection');
    expect(ACTION).toContain('decideAttendanceCorrection');
    expect(ACTION.indexOf('requestAttendanceCorrection(')).toBeLessThan(
      ACTION.indexOf('decideAttendanceCorrection('),
    );
    // A DIRECT WRITE is the shape this must never take: approval re-derives the day through the time
    // engine so corrected OT reaches payroll, and a second write path is how overtime moves with no trail.
    for (const f of ['.update(attendance', 'db.insert', 'sql`update', 'recordAttendance']) {
      expect(ACTION, `${f} would bypass the engine`).not.toContain(f);
    }
  });

  it('goes through the pack facade, as a new file must', () => {
    expect(ACTION, 'ADR-0080 D11 — a NEW file may not import core/attendance directly').not.toContain(
      "from '@/core/attendance'",
    );
    expect(ACTION).toContain("from '@/packs/attendance/service'");
  });

  it('re-guards the employment against the caller’s own scope', () => {
    expect(ACTION).toContain('scopedAdmin');
    expect(ACTION).toContain('listEmployees(s, scopeIds)');
    expect(ACTION).toContain("fail('correctionForbidden')");
  });

  it('refuses an unexplained change to a paid figure', () => {
    expect(ACTION).toContain("fail('correctionReasonRequired')");
    expect(ACTION).toContain("fail('correctionNothingToChange')");
  });

  /** The redirect carries a KEY, and the page renders it only from an allowlist — `error` is an untrusted
   *  url value, and `t(anything)` either prints the raw string back or throws MISSING_MESSAGE. */
  it('reports the outcome through an allowlisted message key', () => {
    expect(ACTION).toContain('correctionPendingAnotherApprover');
    expect(DAY_PAGE).toContain('CORRECTION_MESSAGES.includes(sp.error)');
    for (const k of ['correctionForbidden', 'correctionPendingAnotherApprover', 'correctionRejected']) {
      expect(DAY_PAGE, `${k} must be renderable`).toContain(k);
    }
  });

  it('a non-admin still gets the correction workflow link, not the form', () => {
    expect(DAY_PAGE).toContain('isAdmin(s)');
    expect(DAY_PAGE).toContain("t('dayEditCorrection')");
    expect(DAY_PAGE).toContain('adminCorrectAttendanceDayAction');
  });
});

describe('dae7a10f · the employee panel is MOUNTED, not designed again', () => {
  it('uses the shared component with this screen’s own parameter and cookie', () => {
    expect(LIST_PAGE).toContain('CollapsibleEmployeePanel');
    expect(LIST_PAGE).toContain("cookieKey={PANEL_COOKIE}");
    expect(LIST_PAGE).toContain("const PANEL_COOKIE = 'attendance-individual-panel';");
    // The existing ?emp= parameter is kept, so every link and bookmark still opens the same person.
    expect(LIST_PAGE).toContain('selectParam="emp"');
    expect(LIST_PAGE).toContain('preserve={{ from, to }}');
  });

  it('the old dropdown is gone — two pickers for one value is how they disagree', () => {
    expect(LIST_PAGE).not.toContain('<select name="emp"');
    expect(LIST_PAGE, 'but the selection still rides the filter form').toContain(
      '{selectedEmp && <input type="hidden" name="emp" value={selectedEmp} />}',
    );
  });

  it('the panel is fed from the SAME scoped list, never a wider one', () => {
    expect(LIST_PAGE).toContain('const employees = await listEmployees(s, scopeIds);');
    expect(LIST_PAGE).toContain('employees={panelEmployees}');
  });

  /** Every caption crossing into that client component is pre-translated: a translator closure returns a
   *  500 on every request while tsc, the suite and next build all stay green. */
  it('passes strings, never the translator', () => {
    const mount = LIST_PAGE.slice(LIST_PAGE.indexOf('<CollapsibleEmployeePanel'), LIST_PAGE.indexOf('</CollapsibleEmployeePanel>'));
    expect(mount, 'the panel must not receive `t`').not.toMatch(/\bt=\{t\}/);
    for (const k of ["t('panel.hide')", "t('panel.show')", "t('panel.heading')"]) {
      expect(mount, `${k} is resolved on the server`).toContain(k);
    }
  });
});
