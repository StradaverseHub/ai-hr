/**
 * db46d9a2 — `cp22MonthCohort`, the read behind the month view and the batch download.
 *
 * THE MONTH IS THE WHOLE POINT, so its EDGES are the first assertions here. The screen's Payroll-month
 * select is inclusive of both ends of the month it names, and an off-by-one at either edge is invisible on
 * screen — the list just quietly holds the wrong people, and a CP22 either goes unfiled or is filed against
 * the wrong month. So: a hire on the 1st and a hire on the LAST day are both in; 31 July is not in August
 * and 1 August is not in July; and February's last day is the 28th or the 29th depending on the year, which
 * a naive `-31` or `-30` gets wrong four times in five.
 *
 * THE TWO REFUSALS ARE THE SAME TWO `cp22Particulars` MAKES, and for the same reasons: RLS decides which
 * employments are visible, and a company whose jurisdiction no pack owns has no CP22 at all. The second one
 * returns NULL rather than an empty month — "nobody started in July" is a different and false statement
 * from "this company has no CP22", the route turns null into the same 404 an unknown company gets, and the
 * screen draws no card at all.
 *
 * THE READINESS FLAGS ARE A PROMISE ABOUT THE DOCUMENT, not decoration: they are what lets the screen name
 * the people whose page will come out with a gap BEFORE the operator downloads it, rather than after. The
 * form takes an IC number OR a passport, so either one satisfies the identity flag; the employer number is
 * company-level (one row per company) and its absence gaps box 3 on every page at once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setPassportProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { cp22MonthCohort, complianceWorklist } from '../core/reporting';

const ROOT = path.resolve(__dirname, '..');
/** Source with its PROSE removed, for the assertions that say "this file must not contain X". */
const code = (p: string) =>
  fs
    .readFileSync(path.join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

describe('cp22MonthCohort — who started in one month', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  let seq = 0;
  const hire = async (fullName: string, hiredOn: string, companyId?: string, departmentId?: string) => {
    seq += 1;
    return hireEmployee(adminCtx(base), {
      person: { fullName, primaryEmail: `joiner${seq}@acme.test` },
      companyId: companyId ?? base.companyId,
      departmentId: departmentId ?? base.deptA,
      positionId: companyId ? undefined : base.positionId,
      employmentType: 'full_time',
      hiredOn,
    });
  };

  const names = async (periodKey: string, companyId?: string) => {
    const c = await cp22MonthCohort(adminCtx(base), { companyId: companyId ?? base.companyId, periodKey });
    return (c?.rows ?? []).map((r) => r.name);
  };

  it('includes the first day and the last day, and excludes the day either side', async () => {
    await hire('Edge Before', '2026-06-30');
    await hire('Edge First', '2026-07-01');
    await hire('Middle', '2026-07-15');
    await hire('Edge Last', '2026-07-31');
    await hire('Edge After', '2026-08-01');

    expect(await names('2026-07')).toEqual(['Edge First', 'Middle', 'Edge Last']);
  });

  // A month is not 30 days and it is not 31. February 2026 ends on the 28th, February 2028 on the 29th —
  // and a hire on 29 February is a real date that a fixed month length silently drops.
  it('ends February on the 28th in a common year and the 29th in a leap year', async () => {
    await hire('Feb Common', '2026-02-28');
    await hire('Mar First', '2026-03-01');
    await hire('Feb Leap', '2028-02-29');

    expect(await names('2026-02')).toEqual(['Feb Common']);
    expect(await names('2026-03')).toEqual(['Mar First']);
    expect(await names('2028-02')).toEqual(['Feb Leap']);
  });

  it('orders by hire date, then by name — the order the batch document pages', async () => {
    await hire('Zara Last', '2026-07-02');
    await hire('Amir Same Day', '2026-07-02');
    await hire('Bala Earlier', '2026-07-01');

    expect(await names('2026-07')).toEqual(['Bala Earlier', 'Amir Same Day', 'Zara Last']);
  });

  it('reaches ANY month, including one far outside the 60-day worklist window', async () => {
    await hire('Old Joiner', '2023-03-14');
    const today = '2026-08-09';

    // The deadline alarm cannot see them — that is its job, and it is untouched.
    const worklist = await complianceWorklist(adminCtx(base), { companyId: base.companyId, today });
    expect(worklist.map((w) => w.name)).not.toContain('Old Joiner');
    // The month view can.
    expect(await names('2023-03')).toEqual(['Old Joiner']);
  });

  // Hired in July, gone in August: the CP22 for the HIRE was still owed, and a late filing is exactly the
  // case this month view is reached for.
  it('still lists someone who was terminated after the month they joined', async () => {
    const e = await hire('Short Stay', '2026-07-10');
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-08-31' })
      .where(eq(schema.employment.id, e.employmentId));

    expect(await names('2026-07')).toEqual(['Short Stay']);
  });

  it('lists only the company asked for', async () => {
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Acme Two Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [otherDept] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: other.id, name: 'Ops Two' })
      .returning({ id: schema.department.id });

    await hire('Ours', '2026-07-05');
    await hire('Theirs', '2026-07-06', other.id, otherDept.id);

    expect(await names('2026-07')).toEqual(['Ours']);
    expect(await names('2026-07', other.id)).toEqual(['Theirs']);
  });

  // CP22 is an LHDN form. Telling a Singaporean company it has a Malaysian filing obligation is the exact
  // harm ADR-0080 slice 6 fixed in the worklist beside this read.
  it('returns null for a company no country pack owns — and that is not the same as an empty month', async () => {
    const [sg] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Overseas Plant', country: 'SG', currency: 'SGD' })
      .returning({ id: schema.company.id });
    const [sgDept] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: sg.id, name: 'Plant' })
      .returning({ id: schema.department.id });
    await hire('Overseas Joiner', '2026-07-05', sg.id, sgDept.id);

    expect(await cp22MonthCohort(adminCtx(base), { companyId: sg.id, periodKey: '2026-07' })).toBeNull();
    // …while the Malaysian company's own empty month is an EMPTY LIST, which the screen words differently.
    const empty = await cp22MonthCohort(adminCtx(base), { companyId: base.companyId, periodKey: '2026-07' });
    expect(empty).not.toBeNull();
    expect(empty!.rows).toEqual([]);
  });

  it('returns null for an unknown company and for a malformed month', async () => {
    await hire('Someone', '2026-07-05');
    const a = adminCtx(base);
    expect(await cp22MonthCohort(a, { companyId: '00000000-0000-0000-0000-000000000000', periodKey: '2026-07' }))
      .toBeNull();
    for (const bad of ['2026-13', '2026-00', '2026-7', '202607', '', '2026-07-05']) {
      expect(await cp22MonthCohort(a, { companyId: base.companyId, periodKey: bad }), bad).toBeNull();
    }
  });

  it('echoes the month it read, with the inclusive bounds it used', async () => {
    const c = await cp22MonthCohort(adminCtx(base), { companyId: base.companyId, periodKey: '2026-02' });
    expect(c).toMatchObject({ periodKey: '2026-02', from: '2026-02-01', to: '2026-02-28' });
  });

  describe('readiness — whose page will come out with a gap', () => {
    it('flags a missing tax number, a missing identity, and neither when both are on file', async () => {
      const full = await hire('Full Records', '2026-07-01');
      const noTax = await hire('No Tax No', '2026-07-02');
      const nothing = await hire('No Statutory Row', '2026-07-03');
      const passportOnly = await hire('Passport Only', '2026-07-04');

      await setStatutoryProfileMY(adminCtx(base), {
        personId: full.personId,
        icNumber: '900101101234',
        taxNumber: 'SG12345678901',
        taxCategory: 1,
        numChildren: 0,
      });
      await setStatutoryProfileMY(adminCtx(base), {
        personId: noTax.personId,
        icNumber: '900202101234',
        taxCategory: 1,
        numChildren: 0,
      });
      // The form takes an IC number OR a passport — a foreign hire with a passport is NOT missing an
      // identity, and flagging them would send the operator looking for a MyKad they will never have.
      await setStatutoryProfileMY(adminCtx(base), {
        personId: passportOnly.personId,
        icNumber: '',
        taxNumber: 'OG98765432109',
        taxCategory: 1,
        numChildren: 0,
      });
      await setPassportProfileMY(adminCtx(base), {
        personId: passportOnly.personId,
        passportNumber: 'A12345678',
        passportIssueDate: '2020-01-01',
        passportExpiryDate: '2030-01-01',
      });

      const c = await cp22MonthCohort(adminCtx(base), { companyId: base.companyId, periodKey: '2026-07' });
      const by = new Map(c!.rows.map((r) => [r.name, r]));
      expect(by.get('Full Records')).toMatchObject({ hasIdentityNo: true, hasTaxNo: true });
      expect(by.get('No Tax No')).toMatchObject({ hasIdentityNo: true, hasTaxNo: false });
      // No employee_statutory_my row at all — the LEFT join is what keeps this person in the list rather
      // than hiding exactly the person who most needs naming.
      expect(by.get('No Statutory Row')).toMatchObject({ hasIdentityNo: false, hasTaxNo: false });
      expect(by.get('Passport Only')).toMatchObject({ hasIdentityNo: true, hasTaxNo: true });
      expect(nothing.employmentId).toBeTruthy();
    });

    it('reports the company employer number separately, because it gaps every page at once', async () => {
      await hire('Anyone', '2026-07-01');
      const a = adminCtx(base);

      const before = await cp22MonthCohort(a, { companyId: base.companyId, periodKey: '2026-07' });
      expect(before!.employerNoOnFile).toBe(false);

      await owner.db
        .insert(schema.companyStatutoryMy)
        .values({ tenantId: base.tenantId, companyId: base.companyId, lhdnEmployerNo: 'E 1234567890' });
      const after = await cp22MonthCohort(a, { companyId: base.companyId, periodKey: '2026-07' });
      expect(after!.employerNoOnFile).toBe(true);

      // A row that exists but holds only whitespace is not a number on file.
      await owner.db
        .update(schema.companyStatutoryMy)
        .set({ lhdnEmployerNo: '   ' })
        .where(eq(schema.companyStatutoryMy.companyId, base.companyId));
      const blank = await cp22MonthCohort(a, { companyId: base.companyId, periodKey: '2026-07' });
      expect(blank!.employerNoOnFile).toBe(false);
    });
  });
});

/**
 * The batch route's refusals, read off its source the way test/statutory-forms-page.test.ts reads the
 * export route's. This response is the most concentrated payload of personal data the app produces — many
 * named people's IC, passport, tax number, home address and salary in one file — so the guard is asserted
 * rather than assumed.
 */
describe('the CP22 batch route', () => {
  const ROUTE = code('app/payroll/cp22/batch/route.ts');

  // `isAdmin` is true for an hr_admin grant on ANY company, so it would let a guessed companyId pull
  // another company's whole month of joiners.
  it('fails closed twice: admin AND scoped to the company', () => {
    expect(ROUTE).toContain('scopedAdmin()');
    expect(ROUTE).toContain('scopeIds.includes(companyId)');
    expect(ROUTE).not.toContain('isAdmin(');
  });

  // A malformed id, a foreign/out-of-scope/non-Malaysian company and a month with nobody in it all answer
  // the same bare 404, so the URL cannot be used to enumerate any of them.
  it('answers 404 — never 403 — and never a zero-page PDF for an empty month', () => {
    expect(ROUTE).toContain('cohort.rows.length === 0) return notFound()');
    expect(ROUTE).not.toContain('status: 403');
    expect(ROUTE).toContain("new Response('Not found', { status: 404 })");
  });

  it('validates the company id and the month before it queries anything', () => {
    expect(ROUTE).toContain('UUID.test(companyId)');
    expect(ROUTE).toContain('YEAR.test(year)');
    expect(ROUTE).toContain('MONTH.test(month)');
  });

  // Rendering a form is a read, and this download is explicitly NOT a filing — same deliberate skip the
  // per-joiner route and the EA make.
  it('records no artefact and emits no domain event', () => {
    expect(ROUTE).not.toContain('appendEvent');
    expect(ROUTE).not.toContain('recordReport');
  });

  it('fills through the ONE mapping, and streams as a private attachment', () => {
    expect(ROUTE).toContain('cp22Particulars(s,');
    expect(ROUTE).toContain('renderCp22Batch(readCp22Template()');
    expect(ROUTE).toContain("'Cache-Control': 'private, no-store'");
    expect(ROUTE).toContain('attachment; filename="cp22-');
  });
});

/**
 * THE WORDING. The plan commits to two things in words, and both are the kind of promise that a later
 * "tidy-up" quietly reverses.
 */
describe('the CP22 copy says what the download is', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const messages = (loc: string) =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8')) as {
      payroll: { cp22: Record<string, string>; statutoryForms: Record<string, string> };
    };

  const NEW_KEYS = [
    'monthTitle',
    'monthHint',
    'monthEmpty',
    'monthEmptyHint',
    'branchLabel',
    'branchPlaceholder',
    'downloadAll',
    'downloadAllTitle',
    'notFilingTitle',
    'notFiling',
    'colHireDate',
    'missingTaxNo',
    'missingIdentityNo',
    'missingEmployerNo',
  ];

  it.each(LOCALES)('%s carries every new key, with its placeholders intact', (loc) => {
    const cp22 = messages(loc).payroll.cp22;
    for (const k of NEW_KEYS) expect(cp22[k], `${loc}.${k}`).toBeTruthy();
    // An ICU {placeholder} rendered without its argument THROWS at render time, behind a 200 — so the
    // arguments the screen passes and the ones the string names have to be pinned per locale.
    expect(cp22.monthTitle).toContain('{month}');
    expect(cp22.monthEmpty).toContain('{month}');
    expect(cp22.monthEmptyHint).toContain('{company}');
    expect(cp22.missingEmployerNo).toContain('{company}');
    for (const k of ['monthHint', 'branchLabel', 'branchPlaceholder', 'downloadAll', 'notFilingTitle', 'notFiling', 'colHireDate', 'missingTaxNo', 'missingIdentityNo']) {
      expect(cp22[k], `${loc}.${k}`).not.toMatch(/\{/);
    }
  });

  // Since 1 September 2024 a CP22 must go through e-CP22 on MyTax; posted and hand-delivered forms are not
  // accepted. Every locale says so where the operator can see it, not only English.
  it.each(LOCALES)('%s names e-CP22 and MyTax beside the download', (loc) => {
    const cp22 = messages(loc).payroll.cp22;
    expect(cp22.notFiling).toContain('e-CP22');
    expect(cp22.notFiling).toContain('MyTax');
    expect(cp22.downloadTitle).toContain('e-CP22');
    expect(cp22.blankTitle).toContain('e-CP22');
    expect(messages(loc).payroll.statutoryForms.link_cp22_hint).toContain('e-CP22');
  });

  // The reporter's reference labels its button "Download For Submission". The plan explicitly refuses that
  // wording, because the file is not a submission.
  it.each(LOCALES)('%s never labels the CP22 download a submission', (loc) => {
    for (const v of Object.values(messages(loc).payroll.cp22)) {
      expect(v.toLowerCase()).not.toContain('for submission');
    }
  });
});

/**
 * THE ARTWORK. The reporter's reference shows CP22 [Pin. 1/2021]; what we hold and ship is [Pin. 1/2020].
 * We could not establish which revision LHDN publishes today, and the plan promises we will not swap the
 * artwork of a statutory form on a guess. Every rect in lib/cp22-fields.ts was measured against THIS file.
 */
describe('the bundled artwork is untouched by this round', () => {
  it('is still the 1/2020 page, at the byte length the coordinate map was measured against', () => {
    const bytes = fs.readFileSync(path.join(ROOT, 'public', 'forms', 'cp22-pin-1-2020.pdf'));
    expect(bytes.length).toBe(156503);
    expect(fs.existsSync(path.join(ROOT, 'public', 'forms', 'cp22-pin-1-2021.pdf'))).toBe(false);
  });
});
