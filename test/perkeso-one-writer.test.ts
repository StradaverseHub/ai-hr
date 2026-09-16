/**
 * r296 (readiness 3.1) — ONE WRITER FOR THE ONE PERKESO ASSIST UPLOAD FILE, AND A DATE FOR THE SKBBK BOX.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────────────────
 * Two fixed-width writers for one artefact were reachable from two screens at the same time:
 *
 *   /payroll/borang-8a/file          → lib/perkeso-socso-file.ts        v1.0, space-padded, no SKBBK box
 *   /payroll/reports/socso-eis-file  → localization/my/socso-eis-file.ts v2.0, zero-padded, SKBBK at 239
 *
 * For the SAME two employees in the SAME month they emitted different bytes in six places per record
 * (positions 201-208, 215, 221-222, 227-228, 233-234, 239-244) and differed again at the end of the file
 * (one wrote a trailing CRLF, the other did not). Both were offered as "the PERKESO ASSIST upload file",
 * with different filenames, and nothing on either screen said which was which. Only ONE of them was ever
 * checked against a file PERKESO accepted — the one with NO SKBBK box (test/fixtures/perkeso-brg8a.txt,
 * pinned byte-for-byte in test/perkeso-socso-file.test.ts, which this round did not touch).
 *
 * ── WHAT IS PINNED HERE, AND WHAT IS DELIBERATELY NOT ──────────────────────────────────────────────
 * PINNED: both screens produce the SAME BYTES, from one writer, for one month of one real payroll; the
 * SKBBK box is on for a contribution month from 10/2026 and off before it; the layout the fixture pins is
 * the one this system writes for the fixture's own month.
 *
 * NOT PINNED, BECAUSE IT IS NOT KNOWN: which layout PERKESO ASSIST accepts TODAY. That needs a real
 * submission or the current specification, neither of which is in this repository. Nothing below claims
 * v1.0 is right and v2.0 is wrong, or the reverse — only that there is now one answer instead of two
 * silently different ones, and that the answer is a documented date rather than a code path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { reportPreview } from '../core/reporting';
import { borang8AFrom } from '../lib/borang-8a';
import { socsoEisFileForBatch } from '../localization/my/socso-eis-file';
import {
  PERKESO_FILE_FIELDS,
  PERKESO_FILE_FIELDS_V2,
  PERKESO_FILE_LINE_LENGTH,
  PERKESO_SKBBK_MANDATORY_FROM,
  buildPerkesoSocsoFile,
  perkesoField,
  perkesoFileEmployeesFrom,
  perkesoFileRecords,
  perkesoFileReport,
  perkesoLayoutForPeriod,
  perkesoSkbbkNotCarried,
  perkesoUploadFilename,
} from '../lib/perkeso-socso-file';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comment-stripped, for the "must NOT contain" assertions: this round's own header explains the offsets
 *  it removed, and a prose mention of 278 is not a writer. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/* ───────────────────────────────────────────────────────────────────────────────────────────────────
 * 1. THE DEFECT CLOSING, AGAINST A REAL DATABASE: two screens, one payroll month, one set of bytes.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────── */

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setCompanyStatutoryMY(adminCtx(b), {
    companyId: b.companyId,
    socsoEmployerCode: 'E1100007357Y',
    ssmRegistrationNo: '34111U',
  });
});

let seq = 0;
async function hire(p: { name: string; salary: number; ic: string; skbbk?: boolean }) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: p.name, primaryEmail: `pk_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2024-03-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: p.salary, effectiveFrom: '2024-03-01' });
  // ⚠️ `subjectToSkbbk` DEFAULTS TO FALSE FOR A NEW EMPLOYEE (db/schema.ts, reporter-approved; migration
  // 0198 backfilled pre-existing rows to true). Passed explicitly so the cases below exercise real SKBBK
  // money instead of a zero that would make them pass without proving anything.
  await setStatutoryProfileMY(a, { personId: E.personId, icNumber: p.ic, taxCategory: 1, numChildren: 0, subjectToSkbbk: p.skbbk ?? true });
  return E;
}

/** The period every case below files. In the past, so the writer's future-month refusal is not in play. */
const PERIOD = '2026-07';

/**
 * SCREEN A — /payroll/borang-8a/file. The composition of `app/payroll/borang-8a/shared.ts`, which cannot
 * be called directly from a node test because it resolves the session through `scopedAdmin()`. Everything
 * below `reportPreview` is the real path, and the case at the bottom of this file pins that shared.ts
 * still composes it exactly this way.
 */
async function screenA(periodKey = PERIOD) {
  const a = adminCtx(b);
  const result = await reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-8a', periodKey });
  const form = borang8AFrom({ header: result.meta.formHeader, rows: result.rows });
  const period = form.contributionPeriodKey;
  const periodMonth = Number(period.slice(5, 7));
  const periodYear = Number(period.slice(0, 4));
  const layout = perkesoLayoutForPeriod(periodYear, periodMonth);
  const rows = form.pages.flatMap((pg) => pg.rows);
  const text = buildPerkesoSocsoFile({
    employer: { employerCode: form.employerCode, myCoId: form.mycoid, periodMonth, periodYear },
    employees: perkesoFileEmployeesFrom(rows),
    layout,
  });
  return {
    text,
    layout,
    filename: perkesoUploadFilename(form.employerCode, period),
    skbbkNotCarried: perkesoSkbbkNotCarried(layout, rows),
  };
}

/** SCREEN B — /payroll/reports/socso-eis-file. The route's own function, unmodified. */
const screenB = (periodKey = PERIOD) => socsoEisFileForBatch(adminCtx(b), { companyId: b.companyId, periodKey });

describe('r296 — the two screens hand over the same file', () => {
  /**
   * THE HEADLINE. Before this round the two sides of this assertion differed in six character ranges per
   * record and in the last two bytes of the file; an operator downloading from Reports and an operator
   * downloading from the Borang 8A review screen filed different documents for the same month.
   */
  it('produces IDENTICAL BYTES for the same month, from both screens', async () => {
    await hire({ name: 'AHMAD AZMER IZAT BIN MAT YAZID', salary: 5900, ic: '941128035179' });
    await hire({ name: 'NOOR AZID SHAH BIN DAUD', salary: 2700, ic: '901010146619' });
    await generatePayslips(adminCtx(b), { batchId: (await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: PERIOD })).batchId });

    const a = await screenA();
    const file = await screenB();

    // The fixture is 278-character records; a file that is empty or one record long would pass a byte
    // comparison trivially, so the shape is asserted before the equality that matters.
    expect(perkesoFileRecords(a.text)).toHaveLength(2);
    for (const r of perkesoFileRecords(a.text)) expect(r).toHaveLength(PERKESO_FILE_LINE_LENGTH);

    expect(file.content).toBe(a.text);
    expect(file.layout).toBe(a.layout);
    expect(file.filename).toBe(a.filename);
  });

  /**
   * THE SAME EQUALITY, ONE FIELD AT A TIME — so a failure says WHICH box moved rather than only that the
   * files differ. Field 6 is the one that used to be taken from two different facts: this read wrote
   * `payslip.gross_pay` and the Borang 8A path wrote `statutory.bases.socsoEis`.
   */
  it('agrees box by box, including the salary box the two reads used to fill from different facts', async () => {
    await hire({ name: 'AHMAD AZMER IZAT BIN MAT YAZID', salary: 5900, ic: '941128035179' });
    await generatePayslips(adminCtx(b), { batchId: (await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: PERIOD })).batchId });

    const [recA] = perkesoFileRecords((await screenA()).text);
    const [recB] = perkesoFileRecords((await screenB()).content);
    for (const [key, spec] of Object.entries(PERKESO_FILE_FIELDS)) {
      expect(perkesoField(recB, spec), key).toBe(perkesoField(recA, spec));
    }
    // …and the salary box is a real figure, not two matching blanks.
    expect(perkesoField(recA, PERKESO_FILE_FIELDS.wage).trim()).toMatch(/^\d+$/);
    expect(Number(perkesoField(recA, PERKESO_FILE_FIELDS.wage).trim())).toBeGreaterThan(0);
  });

  /**
   * 07/2026 IS INSIDE THE TRANSITION: SKBBK has been deducted since 1 June 2026 and the layout PERKESO is
   * known to accept has no box for it until 1 October 2026. Both screens must report the same amount of
   * money as NOT CARRIED, and the validation report must say so in words rather than print a 0.00.
   */
  it('names the SKBBK the accepted layout cannot carry, identically on both screens', async () => {
    await hire({ name: 'AHMAD AZMER IZAT BIN MAT YAZID', salary: 5900, ic: '941128035179' });
    await generatePayslips(adminCtx(b), { batchId: (await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: PERIOD })).batchId });

    const a = await screenA();
    const file = await screenB();
    expect(a.layout).toBe('v1.0');
    // The fixture engine must actually be deducting SKBBK, or this case pins nothing.
    expect(a.skbbkNotCarried).toBeGreaterThan(0);
    expect(file.totals.skbbkNotCarriedCents).toBe(Math.round(a.skbbkNotCarried * 100));
    // ABSENT, not zero: a v1.0 file has no SKBBK box, and a recorded 0 would assert none was owed.
    expect(file.totals).not.toHaveProperty('skbbkCents');

    const report = perkesoFileReport(a.text, { layout: a.layout, skbbkNotCarried: a.skbbkNotCarried });
    expect(report).toContain('SKBBK / LINDUNG 24 JAM IS NOT IN THIS FILE');
    expect(report).toContain('10/2026');
    // The same report with nothing to say stays silent — the rule test/perkeso-socso-file.test.ts pins.
    expect(perkesoFileReport(a.text, { layout: a.layout })).not.toMatch(/SKBBK/i);
  });
});

/* ───────────────────────────────────────────────────────────────────────────────────────────────────
 * 2. THE SWITCH, BOTH WAYS. Pure — no database, and no clock.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────── */

describe('r296 — the SKBBK box is a date, not a code path', () => {
  const EMPLOYEE = {
    ic: '941128035179',
    name: 'AHMAD AZMER IZAT BIN MAT YAZID',
    wage: 5900,
    socsoEmployer: 102.35,
    socsoEmployee: 29.25,
    eisEmployer: 11.7,
    eisEmployee: 11.7,
    skbbk: 44.25,
  };
  const at = (year: number, month: number, layout?: 'v1.0' | 'v2.0') =>
    buildPerkesoSocsoFile({
      employer: { employerCode: 'E1100007357Y', myCoId: '34111U', periodMonth: month, periodYear: year },
      employees: perkesoFileEmployeesFrom([EMPLOYEE]),
      layout: layout ?? perkesoLayoutForPeriod(year, month),
      // Injected so the case does not depend on when it runs — a contribution month is legal from its own
      // month onward, and 10/2026 must stay buildable after this round ships.
      today: new Date(Date.UTC(year, month, 15)),
    });

  it('ON: from the mandatory month the box carries the employee SKBBK at the documented offset', () => {
    const rec = at(2026, 10);
    expect(rec).toHaveLength(PERKESO_FILE_LINE_LENGTH);
    // 239-244 in the specification's 1-based numbering.
    expect(PERKESO_FILE_FIELDS_V2.skbbk.offset).toBe(238);
    expect(PERKESO_FILE_FIELDS_V2.skbbk.width).toBe(6);
    expect(perkesoField(rec, PERKESO_FILE_FIELDS_V2.skbbk)).toBe('004425');
    // …and Filler 1 has SHRUNK to fourteen and is still blank, rather than the record having grown.
    expect(perkesoField(rec, PERKESO_FILE_FIELDS_V2.filler1)).toBe(' '.repeat(14));
    expect(perkesoField(rec, PERKESO_FILE_FIELDS_V2.filler2)).toBe(' '.repeat(20));
  });

  it('OFF: before the mandatory month those same positions are the blank Filler 1', () => {
    const rec = at(2026, 9);
    expect(rec).toHaveLength(PERKESO_FILE_LINE_LENGTH);
    expect(PERKESO_FILE_FIELDS.filler1.offset).toBe(238);
    expect(PERKESO_FILE_FIELDS.filler1.width).toBe(20);
    expect(perkesoField(rec, PERKESO_FILE_FIELDS.filler1)).toBe(' '.repeat(20));
    // The money is not written anywhere else either — the whole tail is blank.
    expect(rec.slice(238)).toBe(' '.repeat(40));
    expect(perkesoSkbbkNotCarried('v1.0', [EMPLOYEE])).toBe(44.25);
    expect(perkesoSkbbkNotCarried('v2.0', [EMPLOYEE])).toBe(0);
  });

  /** The date itself, read off the constant rather than typed into the assertion twice. */
  it('flips on exactly the 1 October 2026 boundary and nowhere else', () => {
    expect(PERKESO_SKBBK_MANDATORY_FROM).toEqual({ year: 2026, month: 10 });
    const { year, month } = PERKESO_SKBBK_MANDATORY_FROM;
    expect(perkesoLayoutForPeriod(year, month)).toBe('v2.0');
    expect(perkesoLayoutForPeriod(year, month - 1)).toBe('v1.0');
    expect(perkesoLayoutForPeriod(year - 1, 12)).toBe('v1.0');
    expect(perkesoLayoutForPeriod(year + 1, 1)).toBe('v2.0');
  });

  /**
   * ⚠️ THE ONE THAT MUST NOT BE LOOSENED. The layout the golden fixture pins is read OFF THE FIXTURE —
   * its own tail, and its own contribution month — so this cannot drift into agreeing with whatever the
   * code currently does. The customer's accepted file has forty blank characters after position 238; if
   * this system ever writes a SKBBK box for that month, the file PERKESO accepted is no longer the file
   * this system produces.
   */
  it('writes, for the accepted fixture own month, the layout the fixture itself shows', () => {
    const FIXTURE = fs.readFileSync(path.join(ROOT, 'test/fixtures/perkeso-brg8a.txt'), 'latin1');
    const [rec] = perkesoFileRecords(FIXTURE);
    const mmYYYY = perkesoField(rec, PERKESO_FILE_FIELDS.contributionMonth);
    const month = Number(mmYYYY.slice(0, 2));
    const year = Number(mmYYYY.slice(2));
    expect(rec.slice(238)).toBe(' '.repeat(40)); // the accepted file has NO SKBBK box
    expect(perkesoLayoutForPeriod(year, month)).toBe('v1.0');
    // And the amounts in the accepted file are SPACE-padded, which is the pad character v1.0 writes.
    expect(perkesoField(rec, PERKESO_FILE_FIELDS.wage)).toMatch(/^ +\d+$/);
  });
});

/* ───────────────────────────────────────────────────────────────────────────────────────────────────
 * 3. NO SECOND WRITER MAY COME BACK.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────── */

describe('r296 — one writer, and the source says so', () => {
  /**
   * The read keeps its query and loses its writer. Asserted on the SOURCE because the whole failure mode
   * was a second implementation that behaved plausibly: a unit test of either writer passed throughout.
   */
  it('localization/my/socso-eis-file.ts delegates and writes no fixed-width record of its own', () => {
    const src = read('localization/my/socso-eis-file.ts');
    expect(src).toContain("from '../../lib/perkeso-socso-file'");
    expect(src).toContain('buildPerkesoSocsoFile(');
    // The tools a fixed-width writer needs. None of them belongs in a read.
    const body = code('localization/my/socso-eis-file.ts');
    expect(body).not.toMatch(/padStart|padEnd|repeat\(/);
    expect(body).not.toContain('278');
    // It still reads the SSM number off the company row — the fact test/company-panel-bank-statutory-
    // layout.test.ts pins this module for.
    expect(src).toContain('companyStatutoryMy.ssmRegistrationNo');
  });

  /** Both routes' bytes come from the one module, and neither names the other's. */
  it('both download routes reach lib/perkeso-socso-file, and only it', () => {
    const reports = read('app/payroll/reports/socso-eis-file/route.ts');
    const borang = read('app/payroll/borang-8a/file/route.ts');
    expect(reports).toContain("from '@/localization/my/socso-eis-file'");
    expect(borang).toContain("from '@/lib/perkeso-socso-file'");
    // One filename helper, so the same artefact cannot arrive under two names again.
    expect(borang).toContain('perkesoUploadFilename(');
    expect(reports).not.toMatch(/PERKESO_\$\{/);
  });

  /**
   * THE CONTRACT BETWEEN THIS TEST AND `shared.ts`. `screenA` above reproduces six lines of
   * app/payroll/borang-8a/shared.ts because the real function resolves a session. If shared.ts ever stops
   * composing it this way, the end-to-end cases above would be measuring something the screen no longer
   * does — so the composition is pinned on the file itself.
   */
  it('app/payroll/borang-8a/shared.ts composes the file the way screenA reproduces it', () => {
    const shared = read('app/payroll/borang-8a/shared.ts');
    expect(shared).toContain('perkesoLayoutForPeriod(periodYear, periodMonth)');
    expect(shared).toContain('employees: perkesoFileEmployeesFrom(rows)');
    expect(shared).toContain('layout,');
    expect(shared).toContain('perkesoSkbbkNotCarried(layout, rows)');
    // The revision is never chosen on the screen.
    expect(shared).not.toMatch(/layout:\s*'v[12]\.0'/);
  });
});
