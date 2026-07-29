/**
 * Personnel (Admin) — remove Extended/Final Confirmation Date from Employment Dates (feedback d27961e3).
 *
 * The Employment Dates card no longer shows (or submits) Extended Confirmation Date or the derived Final
 * Confirmation Date: probation extensions are managed EXCLUSIVELY through the Movement module (New Event →
 * Probation Extension), which records the effective date + remarks in the movement history and remains the
 * single mutator of employment.extended_confirmation_date. Nothing is deleted underneath — the columns, the
 * finalConfirmationDate derivation (= extended ?? normal) and every probation-status consumer stay intact.
 *
 * Covers, per the approved plan:
 *   1. Forge-proof — setEmploymentInfo IGNORES a posted extendedConfirmationDate without the
 *      probationExtension movement tag (it can neither set nor clear the stored value).
 *   2. Probation-status regression — a movement-driven extension still pushes the derived
 *      finalConfirmationDate out and keeps the employee in 'probation' until the extended date, and the
 *      extension appears in the movement history with its end date + remarks.
 *   3. Drift guard — the slimmed Employment Dates card renders neither removed field, keeps the standard
 *      dates, the action no longer reads the form field, the Movement picker still offers Probation
 *      Extension, and the orphaned i18n labels are gone from all six locales (kept keys untouched).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { createMovementEvent, movementHistory } from '../core/movement';
import { deriveEmploymentStatus } from '../core/employment-status';
import { employeeDetail } from '../core/read';
import {
  adminCtx,
  closeAll,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hire(name = 'Simplify Test', hiredOn = '2026-01-01') {
  const r = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  return { id: r.employmentId };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('setEmploymentInfo — extendedConfirmationDate is movement-only (d27961e3)', () => {
  it('IGNORES a posted extended date without the movement tag (forge-proof)', async () => {
    const e = await hire('Forge Set');
    // A forged Employment Dates save smuggling extendedConfirmationDate: the legitimate field applies,
    // the forged one is silently dropped — final derives from the confirmation date alone.
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      confirmationDate: '2026-04-01',
      extendedConfirmationDate: '2026-08-01',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.confirmationDate).toBe('2026-04-01');
    expect(d!.extendedConfirmationDate).toBeNull();
    expect(d!.finalConfirmationDate).toBe('2026-04-01');
  });

  it('a save carrying ONLY the forged field changes nothing at all', async () => {
    const e = await hire('Forge Only');
    await expect(
      setEmploymentInfo(adminCtx(b), { employmentId: e.id, extendedConfirmationDate: '2026-08-01' }),
    ).rejects.toThrow(/nothing to change/i);
  });

  it('a forged blank cannot CLEAR a movement-set extension', async () => {
    const e = await hire('Forge Clear');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, confirmationDate: '2026-04-01' });
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'probationExtension',
      effectiveDate: '2026-03-20',
      endDate: '2026-07-01',
    });
    // Untagged save posting a blank extension alongside a real change: the real change lands, the
    // extension survives.
    await setEmploymentInfo(adminCtx(b), {
      employmentId: e.id,
      probationValue: 3,
      probationUnit: 'month',
      extendedConfirmationDate: '',
    });
    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.probationValue).toBe(3);
    expect(d!.extendedConfirmationDate).toBe('2026-07-01');
    expect(d!.finalConfirmationDate).toBe('2026-07-01');
  });
});

describe('movement-driven probation extension — status + history regression', () => {
  it('extends the probation timeline and keeps the employee in probation until the extended date', async () => {
    const e = await hire('Status Reg');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, confirmationDate: '2026-04-01' });
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'probationExtension',
      effectiveDate: '2026-03-20',
      endDate: '2026-07-01',
      remarks: 'Extended by three months',
    });

    const d = await employeeDetail(adminCtx(b), e.id);
    expect(d!.extendedConfirmationDate).toBe('2026-07-01');
    expect(d!.finalConfirmationDate).toBe('2026-07-01');

    // Past the ORIGINAL confirmation date but before the extended one → still probation; after → active.
    expect(deriveEmploymentStatus(d!, '2026-05-01')).toBe('probation');
    expect(deriveEmploymentStatus(d!, '2026-07-01')).toBe('active');
  });

  it('records the extension in the movement history with its end date and remarks', async () => {
    const e = await hire('History Reg');
    await setEmploymentInfo(adminCtx(b), { employmentId: e.id, confirmationDate: '2026-04-01' });
    await createMovementEvent(adminCtx(b), {
      employmentId: e.id,
      kind: 'probationExtension',
      effectiveDate: '2026-03-20',
      endDate: '2026-07-01',
      remarks: 'Extended by three months',
    });
    const rows = await movementHistory(adminCtx(b), e.id);
    const ext = rows.find((r) => r.kind === 'probationExtension');
    expect(ext).toBeDefined();
    expect(ext!.endDate).toBe('2026-07-01');
    expect(ext!.remarks).toBe('Extended by three months');
  });
});

// ── Drift guards on the slimmed card + wiring ──
const REPO = path.resolve(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(REPO, 'app/admin/personnel/[employmentId]/page.tsx'), 'utf8');
const actionsSrc = fs.readFileSync(path.join(REPO, 'app/admin/personnel/[employmentId]/actions.ts'), 'utf8');
const pickerSrc = fs.readFileSync(
  path.join(REPO, 'app/admin/personnel/[employmentId]/movement-new-event.tsx'),
  'utf8',
);

/** The Employment Dates <form action={setEmploymentInfoAction}> … </form> block. */
function datesFormBlock(): string {
  const start = pageSrc.indexOf('<form action={setEmploymentInfoAction}');
  expect(start).toBeGreaterThan(-1);
  const end = pageSrc.indexOf('</form>', start);
  expect(end).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

describe('drift guard — slimmed Employment Dates card (d27961e3)', () => {
  it('no longer renders the Extended or Final Confirmation Date fields', () => {
    expect(pageSrc).not.toContain('name="extendedConfirmationDate"');
    expect(pageSrc).not.toContain("t('employmentInfo.extendedConfirmationDate')");
    expect(pageSrc).not.toContain("t('employmentInfo.finalConfirmationDate')");
    expect(pageSrc).not.toContain("t('employmentInfo.finalConfirmationNote')");
  });

  // 89ea527b — hiredOn (Group Join Date) and joinDate LEFT this list: both are movement-only now, rendered
  // read-only on the card and not submitted by it. The guard below pins that they are gone; the rest of the
  // Employment Dates group (probation / notice / resignation) stays editable here as before.
  it('no longer submits either join date', () => {
    const block = datesFormBlock();
    expect(block).not.toContain('name="hiredOn"');
    expect(block).not.toContain('name="joinDate"');
    // The labels stay — the fields are still displayed, just not editable.
    expect(block).toContain("t('employmentInfo.groupJoinDate')");
    expect(block).toContain("t('employmentInfo.joinDate')");
  });

  it('keeps the standard Employment Dates fields', () => {
    const block = datesFormBlock();
    for (const name of [
      'confirmationDate',
      'probationValue',
      'noticeBeforeConfirmationValue',
      'noticeAfterConfirmationValue',
      'tenderResignationDate',
      'resignationDate',
      'lastWorkingDate',
    ]) {
      expect(block, `${name} must remain on the Employment Dates card`).toContain(`name="${name}"`);
    }
  });

  it('setEmploymentInfoAction no longer reads the extended date from the form', () => {
    const start = actionsSrc.indexOf('export async function setEmploymentInfoAction');
    expect(start).toBeGreaterThan(-1);
    const body = actionsSrc.slice(start, actionsSrc.indexOf('\n}\n', start));
    expect(body).not.toContain("str('extendedConfirmationDate')");
  });

  it('the Movement New Event picker still offers Probation Extension', () => {
    expect(pickerSrc).toContain("'probationExtension'");
  });

  it('removes the orphaned labels from all six locales and keeps the kept keys', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const ei = JSON.parse(fs.readFileSync(path.join(REPO, 'messages', `${loc}.json`), 'utf8')).people
        .detail.employmentInfo as Record<string, unknown>;
      expect(ei.extendedConfirmationDate, `${loc}: extendedConfirmationDate label must be gone`).toBeUndefined();
      expect(ei.finalConfirmationDate, `${loc}: finalConfirmationDate label must be gone`).toBeUndefined();
      expect(ei.finalConfirmationNote, `${loc}: finalConfirmationNote must be gone`).toBeUndefined();
      for (const kept of ['groupJoinDate', 'joinDate', 'confirmationDate']) {
        expect(typeof ei[kept], `${loc}: ${kept} label must stay`).toBe('string');
      }
    }
  });
});
