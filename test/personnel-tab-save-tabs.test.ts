import {getTaxSelectionMY} from '../localization/my/tax-selection';
/**
 * 420ebab5 part two, r255 — the REMAINING consolidated tabs: Bank & Statutory, Attendance, Employment.
 *
 * test/personnel-tab-save.test.ts pins the Profile tab and the shape of the whole mechanism. This file
 * pins the three tabs r255 added and, above all, THE ONE THING THAT IS NOT A REPEAT OF PROFILE.
 *
 * ── WHY BANK & STATUTORY NEEDED MEASURING BEFORE IT NEEDED CODE ─────────────────────────────────────
 * `setStatutoryProfileMY` is a FULL-ROW overwrite of the columns it writes. The Statutory (Malaysia) form
 * carries no residency control at all — and `applyStatutorySection` used to read one anyway
 * (`formData.get('isResident') === 'on'`), so it sent `isResident: false` on EVERY save. The Income Tax
 * (PCB) card's setter re-derives that same column from the `taxResidency` the admin picks, which is what
 * usually put it back and what hid the defect while every card had its own button.
 *
 * IT WAS NOT INERT. `is_resident` reaches the payroll kernel SEPARATELY from `flatTaxRate`
 * (core/payroll.ts), and it decides the outcome exactly when `taxResidency` is 'resident' and the flat
 * rate is therefore null: `resident === false` alone charges flat 30% with no reliefs (RM8,000/month =
 * 514.20 as a resident, 2,400.00 with the flag off). So a LONE statutory save — an EPF-number edit and
 * nothing else — moved a resident onto the non-resident basis. r255 fixed the writer: the flag is now
 * derived from the STORED `tax_residency` rather than from a control the form does not have.
 *
 * §1 pins BOTH halves: the lone statutory save must leave the residency untouched (the money guard), and
 * the declared BANK_STATUTORY_TAB_SECTION_ORDER must still be statutory-first because that writer's
 * pass-throughs read the stored row at the moment it runs.
 *
 * ── WHAT THE OTHER SECTIONS PIN ─────────────────────────────────────────────────────────────────────
 * §2  the full-row pass-throughs: bank details written in the SAME request as a statutory edit survive.
 * §3  Attendance — three independent writers, and an untouched card is never written.
 * §4  Employment — ABSENT IS NOT BLANK survives the consolidated door (the namespaced unpack is what
 *     keeps a field the card dropped dropped, and a field the card cleared cleared).
 * §5  the fence, per tab: a section name a tab does not own is refused before anything is written.
 * §6  SOURCE SHAPE — each tab's scope encloses exactly its own (a) cards, the (b) cards on those tabs are
 *     rendered outside it with their own buttons, and every declared section id has a writer.
 * §7  r256 — PAYROLL, the tab the audit held back twice and the last one with a bucket (a) form on its own
 *     button. Six of its seven cards contain a child-record form, so what this section pins is mostly what
 *     the tab's Save CANNOT reach: a recorded salary revision, the pay items, the CP38 orders and the
 *     encashment adjustments, none of which moves when the tab is saved.
 *
 * next/navigation and next/cache are stubbed inert and requireAdmin is stubbed to the seeded admin, so
 * the real FormData → service → database path runs. The consolidated actions RETURN a result rather than
 * redirecting, which is what lets a per-section failure be reported at all.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { redirect, sess } = vi.hoisted(() => ({
  redirect: vi.fn((_url: string) => undefined),
  sess: { ctx: null as unknown },
}));
vi.mock('next/navigation', () => ({ redirect, notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('../lib/authz', async (importActual) => {
  const actual = await importActual<typeof import('../lib/authz')>();
  return { ...actual, requireAdmin: vi.fn(async () => sess.ctx) };
});
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import * as schema from '../db/schema';
import { hireEmployee, setEmploymentInfo } from '../core/org';
import { createLocation } from '../core/location';
import { createClockingLocation } from '../core/clocking-location';
import { setStatutoryProfileMY, setTaxProfileMY, setBankProfileMY } from '../localization/my/statutory';
import { setCompensation } from '../core/comp';
import { assignPolicy, createPolicy } from '../core/payroll-policy';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import {
  saveAttendanceTabAction,
  saveBankStatutoryTabAction,
  saveJobTabAction,
  savePayrollTabAction,
} from '../app/admin/personnel/[employmentId]/actions';
import {
  ATTENDANCE_TAB_SECTION_ORDER,
  BANK_STATUTORY_TAB_SECTION_ORDER,
  JOB_TAB_SECTION_ORDER,
  PAYROLL_TAB_SECTION_ORDER,
  PERSONNEL_TAB_SECTIONS,
  SECTION_FIELD_PREFIX,
} from '../lib/personnel-tab-sections';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/**
 * AGENTS 27 — source-scanning guards do not strip comments, and this file's subject (which form carries
 * which attribute, which card sits inside which scope) is exactly the kind a prose mention would answer
 * wrongly. Same stripper as test/personnel-tab-save.test.ts, including the line-comments-first ordering:
 * one of the page's `//` notes contains the characters that open a block comment, and stripping blocks
 * first made that note swallow real JSX.
 */
function stripComments(src: string): string {
  const withoutLines = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('* ') || t === '*');
    })
    .join('\n');
  return withoutLines.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
}

const PAGE = () => stripComments(read('app/admin/personnel/[employmentId]/page.tsx'));
const ACTIONS = () => read('app/admin/personnel/[employmentId]/actions.ts');

const key = (section: string, field: string) => `${SECTION_FIELD_PREFIX}.${section}.${field}`;

function payload(sections: string[], fields: Record<string, string>, employmentId: string, tab: string) {
  const fd = new FormData();
  fd.set('employmentId', employmentId);
  fd.set('sections', sections.join(','));
  fd.set('tab', tab);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const readStatutory = (personId: string) =>
  owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, personId))
    .limit(1)
    .then((r) => r[0]);

const readEmployment = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1)
    .then((r) => r[0]);

const readCompensation = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.compensation)
    .where(eq(schema.compensation.employmentId, employmentId))
    .then((rows) =>
      rows
        .map((r) => `${r.validFrom}|${r.validTo ?? 'open'}|${r.basicSalary}|${r.remarks ?? ''}`)
        .sort(),
    );

const readClockingAssignments = (employmentId: string) =>
  owner.db
    .select({ id: schema.employeeClockingLocation.clockingLocationId })
    .from(schema.employeeClockingLocation)
    .where(eq(schema.employeeClockingLocation.employmentId, employmentId))
    .then((rows) => rows.map((r) => r.id).sort());

describe('420ebab5 r255 — one Save per tab on Bank & Statutory, Attendance and Employment', () => {
  let base: Base;
  let employmentId: string;
  let personId: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    const a = adminCtx(base);
    sess.ctx = a;
    const emp = await hireEmployee(a, {
      person: { fullName: 'Siti binti Rahman', primaryEmail: `tabsave2-${Date.now()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    employmentId = emp.employmentId;
    personId = emp.personId;
    redirect.mockClear();
  });
  afterAll(async () => {
    await closeAll();
  });

  /** The statutory row the statutory/tax/bank cards all edit. The IC seeds it (Profile tab, in the app). */
  async function seedStatutory(over: Record<string, unknown> = {}) {
    const a = adminCtx(base);
    await setStatutoryProfileMY(a, {
      personId,
      icNumber: '900101015020',
      epfNumber: 'EPF-OLD',
      socsoNumber: 'SOC-OLD',
      bankName: 'Maybank',
      bankAccountNo: '111122223333',
      tp3Year: 2026,
      tp3NetRemuneration: 5000,
      isResident: false,
      ...over,
    });
  }

  /** The fields the Statutory (Malaysia) form actually posts. Note: no `isResident` — that is the point. */
  const statutoryFields = (epfNumber: string) => ({
    [key('statutory', 'personId')]: personId,
    [key('statutory', 'employmentId')]: employmentId,
    [key('statutory', 'epfNumber')]: epfNumber,
    [key('statutory', 'socsoNumber')]: 'SOC-OLD',
    [key('statutory', 'nationality')]: 'Malaysian',
    [key('statutory', 'socsoCategory')]: 'auto',
    [key('statutory', 'eisCategory')]: 'auto',
    [key('statutory', 'epfCitizenship')]: 'citizen',
    [key('statutory', 'epfMode')]: 'statutory',
  });

  /** The fields the Income Tax (PCB) card posts. */
  const taxFields = (taxResidency: string) => ({
    [key('tax', 'personId')]: personId,
    [key('tax', 'employmentId')]: employmentId,
    [key('tax', 'taxNumber')]: 'IG1234567890',
    [key('tax', 'taxCategory')]: '1',
    [key('tax', 'taxResidency')]: taxResidency,
    [key('tax', 'expectedTaxCompanyId')]: base.companyId,
    [key('tax', 'expectedTaxSelectionVersion')]: '1',
    [key('tax', 'numChildren')]: '0',
    [key('tax', 'childReliefMode')]: 'manual',
  });

  // ── §1 THE ORDER IS THE FEATURE ────────────────────────────────────────────────────────────────────
  describe('§1 Bank & Statutory writes in the DECLARED order, and that is what keeps the residency', () => {
    it('the order is statutory → tax → bank → others, and the statutory card carries no residency control', () => {
      expect([...BANK_STATUTORY_TAB_SECTION_ORDER]).toEqual(['statutory', 'tax', 'bank', 'others']);
      // The form the admin sees has no `isResident` input; the tax card is the only place the real answer
      // comes from. If a residency control were ever added to the statutory form, this assertion would
      // fail and the whole argument below would have to be re-derived.
      const page = PAGE();
      const from = page.indexOf('<form action={setStatutoryAction}');
      const statutoryForm = page.slice(from, page.indexOf('</form>', from));
      expect(from).toBeGreaterThan(-1);
      expect(statutoryForm).not.toContain('name="isResident"');
      // …and the writer must NOT read that absent control. Reading it is the defect: it sent `false` on
      // every save and put the employee on flat-rate PCB (see the file header). The value comes from the
      // stored row instead. Source-pinned as well as behaviour-pinned, because the behaviour test below
      // would still pass if someone reintroduced the read on a form that happened to post the field.
      const actions = ACTIONS();
      expect(actions, 'the statutory writer must not read a residency control the form does not have')
        .not.toContain("isResident: formData.get('isResident')");
      expect(actions).toContain("isResident: current.isResident ?? true");
    });

    it('a LONE statutory save leaves the residency alone — an EPF edit cannot move the tax basis', async () => {
      // THE MONEY GUARD. `is_resident` reaches the payroll kernel separately from `flatTaxRate`, and with
      // `tax_residency` = 'resident' the flat rate is null — so `is_resident = false` on its own charges
      // flat 30% PCB with no reliefs. This is the case no second card corrects: the admin opens Bank &
      // Statutory, edits the EPF number, presses the tab's one Save, and touches nothing else.
      await seedStatutory({ isResident: true });
      await setTaxProfileMY(adminCtx(base), { personId, taxResidency: 'resident' });
      expect((await readStatutory(personId)).isResident).toBe(true);

      const result = await saveBankStatutoryTabAction(
        payload(['statutory'], statutoryFields('EPF-ONLY'), employmentId, 'bankStatutory'),
      );
      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['statutory']);

      const row = await readStatutory(personId);
      expect(row.epfNumber, 'the edit the admin actually made').toBe('EPF-ONLY');
      expect(row.isResident, 'an EPF-number edit must not move an employee onto flat-rate PCB').toBe(true);
      expect(row.taxResidency).toBe('resident');
    });

    it('a LONE statutory save on a NON-resident leaves them non-resident too', async () => {
      // The mirror case: deriving from the stored residency must not flip the flag the other way either.
      await seedStatutory();
      await setTaxProfileMY(adminCtx(base), { personId, taxResidency: 'non_resident' });
      expect((await readStatutory(personId)).isResident).toBe(false);

      const result = await saveBankStatutoryTabAction(
        payload(['statutory'], statutoryFields('EPF-NR'), employmentId, 'bankStatutory'),
      );
      expect(result.ok).toBe(true);

      const row = await readStatutory(personId);
      expect(row.epfNumber).toBe('EPF-NR');
      expect(row.isResident).toBe(false);
      expect(row.taxResidency).toBe('non_resident');
    });

    it('a statutory edit saved WITH a residency change ends on the residency the admin chose', async () => {
      await seedStatutory();
      await setTaxProfileMY(adminCtx(base), { personId, taxResidency: 'non_resident' });
      expect((await readStatutory(personId)).isResident).toBe(false);

      const result = await saveBankStatutoryTabAction(
        payload(
          // Deliberately named in the WRONG order by the client — the action must use the declared one.
          ['tax', 'statutory'],
          { ...statutoryFields('EPF-NEW'), ...taxFields('resident') },
          employmentId,
          'bankStatutory',
        ),
      );

      expect(result.ok).toBe(true);

      const row = await readStatutory(personId);
      // The residency the admin picked must survive a request that also carries a statutory edit. Since
      // r255's fix this holds in EITHER order — the statutory writer derives the flag from the stored
      // `tax_residency` instead of inventing one — which is the point: the correctness no longer depends
      // on a declared order being remembered. Before the fix, tax-first left this `false` and moved the
      // employee onto flat-rate PCB.
      expect(await getTaxSelectionMY(adminCtx(base),employmentId)).toMatchObject({scheme:'resident',version:2});
      expect(row.isResident, 'person legacy provenance stays unchanged; scoped category owns calculation').toBe(false);
      expect(row.epfNumber).toBe('EPF-NEW');
      expect(row.taxResidency).toBe('non_resident');
      // `saved` is reported in the DECLARED order, not the order the client listed them in.
      expect(result.saved).toEqual(['statutory', 'tax']);
      expect(redirect).not.toHaveBeenCalled();
    });
  });

  // ── §2 the full-row overwrite must not undo its neighbours ────────────────────────────────────────
  describe('§2 the statutory full-row overwrite does not eat the cards saved beside it', () => {
    it('bank details written in the same request survive, and so do the TP3 balances nobody touched', async () => {
      await seedStatutory();

      const result = await saveBankStatutoryTabAction(
        payload(
          ['statutory', 'bank'],
          {
            ...statutoryFields('EPF-NEW'),
            [key('bank', 'personId')]: personId,
            [key('bank', 'employmentId')]: employmentId,
            [key('bank', 'bankName')]: 'CIMB Bank',
            [key('bank', 'bankAccountNo')]: '999988887777',
          },
          employmentId,
          'bankStatutory',
        ),
      );

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['statutory', 'bank']);

      const row = await readStatutory(personId);
      // The statutory write passes the STORED bank values through (it is a full-row overwrite of columns
      // its own form no longer carries). Running it FIRST means the bank card then lands its own on top.
      expect(row.bankName).toBe('CIMB Bank');
      expect(row.bankAccountNo).toBe('999988887777');
      // …and the columns no card in this request carries are untouched.
      expect(row.tp3Year).toBe(2026);
      expect(Number(row.tp3NetRemuneration)).toBe(5000);
    });

    it('a card the admin did not touch is never written, even when its fields ride along', async () => {
      await seedStatutory();
      await setBankProfileMY(adminCtx(base), { personId, bankName: 'Maybank', bankAccountNo: '111122223333' });

      const result = await saveBankStatutoryTabAction(
        payload(
          ['others'],
          {
            [key('others', 'personId')]: personId,
            [key('others', 'employmentId')]: employmentId,
            [key('others', 'subjectToHrdf')]: 'yes',
            // Present in the payload, absent from `sections` — must not be written.
            [key('bank', 'personId')]: personId,
            [key('bank', 'bankName')]: 'Should Not Land',
            [key('bank', 'bankAccountNo')]: '000000000000',
          },
          employmentId,
          'bankStatutory',
        ),
      );

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['others']);
      const row = await readStatutory(personId);
      expect(row.subjectToHrdf).toBe(true);
      expect(row.bankName).toBe('Maybank');
      expect(row.bankAccountNo).toBe('111122223333');
    });

    it('the HRDF tri-state still reaches the setter as three states, not a checkbox', async () => {
      await seedStatutory();
      for (const [posted, stored] of [
        ['yes', true],
        ['no', false],
        ['', null],
      ] as const) {
        const result = await saveBankStatutoryTabAction(
          payload(
            ['others'],
            {
              [key('others', 'personId')]: personId,
              [key('others', 'employmentId')]: employmentId,
              [key('others', 'subjectToHrdf')]: posted,
            },
            employmentId,
            'bankStatutory',
          ),
        );
        expect(result.ok).toBe(true);
        expect((await readStatutory(personId)).subjectToHrdf, `posted "${posted}"`).toBe(stored);
      }
    });
  });

  // ── §3 Attendance ─────────────────────────────────────────────────────────────────────────────────
  describe('§3 Attendance — independent writers under one Save', () => {
    /**
     * r423 (83c0d3c8) — the `clocking` and `geofencing` sections MERGED into one `clocking` section: the
     * "Use Geofencing for Clocking" switch (`geofencingEnabled`) and the locations it needs are one rule with
     * one writer. The three cases that pinned the separate geofencing section (with its radius override, now
     * retired) pin the merged one.
     */
    const twoSites = async () => {
      const a = adminCtx(base);
      const loc = await createLocation(a, { companyId: base.companyId, code: 'SITE1', name: 'HQ' });
      const mk = (name: string, lat: number) =>
        createClockingLocation(a, { name, lat, lng: 101.6, radiusM: 300, locationId: loc.id, companyIds: [base.companyId] });
      return { siteA: await mk('Gate A', 3.1), siteB: await mk('Gate B', 3.2) };
    };

    it('writes the holiday calendar and the clocking control in one request', async () => {
      const { siteA } = await twoSites();
      const fd = payload(
        ['holiday', 'clocking'],
        {
          [key('holiday', 'employmentId')]: employmentId,
          [key('holiday', 'holidayCalendar')]: 'state:Selangor',
          [key('clocking', 'employmentId')]: employmentId,
          [key('clocking', 'geofencingEnabled')]: 'on',
          [key('clocking', 'clockingLocationIds')]: siteA.id,
        },
        employmentId,
        'attendance',
      );
      const result = await saveAttendanceTabAction(fd);

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['holiday', 'clocking']);
      const emp = await readEmployment(employmentId);
      expect(emp.workState).toBe('Selangor');
      expect(emp.holidayGroupId).toBeNull();
      expect(emp.geofencingEnabled).toBe(true);
      expect(await readClockingAssignments(employmentId)).toEqual([siteA.id]);
    });

    it('an unticked switch means OFF, and OFF clears the assigned locations', async () => {
      const { siteA } = await twoSites();
      await saveAttendanceTabAction(
        payload(
          ['clocking'],
          {
            [key('clocking', 'employmentId')]: employmentId,
            [key('clocking', 'geofencingEnabled')]: 'on',
            [key('clocking', 'clockingLocationIds')]: siteA.id,
          },
          employmentId,
          'attendance',
        ),
      );
      // The client packs an unticked checkbox exactly as a form post does: it contributes nothing. The
      // picker is unmounted while the switch is off, so no ids are posted either.
      const result = await saveAttendanceTabAction(
        payload(['clocking'], { [key('clocking', 'employmentId')]: employmentId }, employmentId, 'attendance'),
      );
      expect(result.ok).toBe(true);
      const emp = await readEmployment(employmentId);
      expect(emp.geofencingEnabled).toBe(false);
      expect(await readClockingAssignments(employmentId)).toEqual([]);
    });

    it('with the switch ON the multi-select is a set-based replace', async () => {
      const { siteA, siteB } = await twoSites();
      const both = new FormData();
      both.set('employmentId', employmentId);
      both.set('sections', 'clocking');
      both.set('tab', 'attendance');
      both.set(key('clocking', 'employmentId'), employmentId);
      both.set(key('clocking', 'geofencingEnabled'), 'on');
      // A multi-select posts one entry per ticked option — `buildTabPayload` appends them the same way.
      both.append(key('clocking', 'clockingLocationIds'), siteA.id);
      both.append(key('clocking', 'clockingLocationIds'), siteB.id);
      expect((await saveAttendanceTabAction(both)).ok).toBe(true);
      expect(await readClockingAssignments(employmentId)).toEqual([siteA.id, siteB.id].sort());

      const one = new FormData();
      one.set('employmentId', employmentId);
      one.set('sections', 'clocking');
      one.set('tab', 'attendance');
      one.set(key('clocking', 'employmentId'), employmentId);
      one.set(key('clocking', 'geofencingEnabled'), 'on');
      one.append(key('clocking', 'clockingLocationIds'), siteB.id);
      expect((await saveAttendanceTabAction(one)).ok).toBe(true);
      expect(await readClockingAssignments(employmentId)).toEqual([siteB.id]);
    });
  });
  });

  // ── §4 Employment ─────────────────────────────────────────────────────────────────────────────────
  describe('§4 Employment — absent is not blank, through the consolidated door', () => {
    it('a field the card did not post is left as-is; a field it posted EMPTY is cleared', async () => {
      await setEmploymentInfo(adminCtx(base), {
        employmentId,
        resignationDate: '2026-06-30',
        tenderResignationDate: '2026-05-01',
      });

      const result = await saveJobTabAction(
        payload(
          ['employment'],
          {
            [key('employment', 'employmentId')]: employmentId,
            [key('employment', 'probationValue')]: '3',
            [key('employment', 'probationUnit')]: 'month',
            // Present and EMPTY ⇒ an explicit clear.
            [key('employment', 'tenderResignationDate')]: '',
            // `resignationDate` is deliberately NOT here — absent ⇒ leave as-is.
          },
          employmentId,
          'job',
        ),
      );

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['employment']);
      const emp = await readEmployment(employmentId);
      expect(emp.probationValue).toBe(3);
      expect(emp.probationUnit).toBe('month');
      expect(emp.tenderResignationDate).toBeNull();
      // The one that would have been silently wiped by a client-side form posting every field it knows.
      expect(emp.resignationDate, 'an absent field means leave as-is, not clear to NULL').toBe('2026-06-30');
    });
  });

  // ── §5 the fence, on the server, per tab ──────────────────────────────────────────────────────────
  describe('§5 a tab can only write the sections it declares', () => {
    it('refuses a section from ANOTHER tab and writes nothing', async () => {
      await seedStatutory();
      const result = await saveBankStatutoryTabAction(
        payload(
          // `person` is a real section — on the Profile tab. It is not this tab's to write.
          ['person', 'statutory'],
          {
            ...statutoryFields('EPF-NEW'),
            [key('person', 'personId')]: personId,
            [key('person', 'fullName')]: 'Should Not Land',
          },
          employmentId,
          'bankStatutory',
        ),
      );
      expect(result.ok).toBe(false);
      expect(result.failedSection).toBe('person');
      expect(result.saved).toEqual([]);
      expect((await readStatutory(personId)).epfNumber).toBe('EPF-OLD');
    });

    it('refuses a bucket (b) name outright — a salary revision is not reachable from a tab Save', async () => {
      for (const [action, tab] of [
        [saveBankStatutoryTabAction, 'bankStatutory'],
        [saveAttendanceTabAction, 'attendance'],
        [saveJobTabAction, 'job'],
        // r256 — and Payroll, where it matters most: `compensationCard` is rendered INSIDE that tab's
        // scope (Payment Method is nested in it), so this is the one tab whose Save is adjacent to the
        // revision on screen. The server vocabulary is what makes the adjacency harmless.
        [savePayrollTabAction, 'payroll'],
      ] as const) {
        const result = await action(
          payload(
            ['compensation'],
            {
              [key('compensation', 'employmentId')]: employmentId,
              [key('compensation', 'basicSalary')]: '99999',
            },
            employmentId,
            tab,
          ),
        );
        expect(result.ok, `${tab} must refuse a bucket (b) section`).toBe(false);
        expect(result.failedSection).toBe('compensation');
        expect(result.saved).toEqual([]);
      }
    });

    it('reports which card broke and which had already committed', async () => {
      await seedStatutory();
      const result = await saveAttendanceTabAction(
        payload(
          ['holiday', 'clocking'],
          {
            [key('holiday', 'employmentId')]: employmentId,
            [key('holiday', 'holidayCalendar')]: 'state:Selangor',
            [key('clocking', 'employmentId')]: employmentId,
            // r423 — refused by the service: the switch ON with no location chosen.
            [key('clocking', 'geofencingEnabled')]: 'on',
          },
          employmentId,
          'attendance',
        ),
      );
      expect(result.ok).toBe(false);
      expect(result.failedSection).toBe('clocking');
      expect(result.error).toContain('Choose at least one clocking location, or turn geofencing off.');
      expect(result.saved, 'the card that DID commit is named so the client can mark it clean').toEqual([
        'holiday',
      ]);
      expect((await readEmployment(employmentId)).workState).toBe('Selangor');
    });
  });

  // ── §6 SOURCE SHAPE — the fence as the page renders it ────────────────────────────────────────────
  describe('§6 each tab scope encloses exactly its own (a) cards', () => {
    /** The three tabs' scopes, sliced out of the page by their `tabKey`. */
    function scopeOf(tabKey: string): string {
      const page = PAGE();
      const open = page.indexOf(`<TabSaveScope\n            tabKey="${tabKey}"`);
      const openInline = page.indexOf(`<TabSaveScope tabKey="${tabKey}"`);
      const from = open > -1 ? open : openInline;
      expect(from, `the ${tabKey} tab opens a TabSaveScope`).toBeGreaterThan(-1);
      const to = page.indexOf('</TabSaveScope>', from);
      expect(to).toBeGreaterThan(from);
      return page.slice(from, to);
    }

    it('Bank & Statutory: all four cards inside, and the tab has no bucket (b) card at all', () => {
      const scope = scopeOf('bankStatutory');
      expect(scope).toContain('{bankCard}');
      expect(scope).toContain('{statutoryCard}');
      expect(scope).toContain('{othersStatutoryCard}');
      // The tax section is inside statutoryCard (item df09f22a merged it in as "Income Tax (PCB)"), so
      // its marker is on the island rather than here — pinned in test/personnel-tab-save.test.ts.
      expect(stripComments(read('components/identity-tax-card.tsx'))).toContain('data-save-section="tax"');
      expect(stripComments(read('components/bank-info-card.tsx'))).toContain('data-save-section="bank"');
    });

    it('Attendance: Work Location and Shift Arrangement are OUTSIDE the scope, with their own buttons', () => {
      const page = PAGE();
      const scope = scopeOf('attendance');
      expect(scope).toContain('{holidayCalendarCard}');
      expect(scope).toContain('{clockingCard}');
      // Both bucket (b): a transfer movement event, and a dated shift period the service refuses to
      // back-insert. A tab-wide Discard must not appear to cover either.
      expect(scope).not.toContain('{locationCard}');
      expect(scope).not.toContain('{defaultShiftCard}');
      const attendancePanel = page.slice(page.indexOf('attendance: ('), page.indexOf('bankStatutory: ('));
      expect(attendancePanel).toContain('{locationCard}');
      expect(attendancePanel).toContain('{defaultShiftCard}');
      // …and they still submit on their own.
      expect(page).toContain('action={setLocationAction}');
      expect(page).toContain('action={setDefaultShiftAction}');
      // The two (b) cards leave the contiguous run BELOW it, not above it. Above it reads better for the
      // Save bar (the bar ends up last on the tab) and was tried first — but it pushes Holiday Calendar
      // off the top and reverses item 52a30630. test/personnel-holiday-grade-relocation.test.ts (5) is
      // the guard on the reading order itself; this one pins the structural half.
      expect(attendancePanel.indexOf('{holidayCalendarCard}')).toBeLessThan(
        attendancePanel.indexOf('{locationCard}'),
      );
    });

    it('Employment: the company transfer sits inside the same card and keeps its OWN button and no marker', () => {
      const page = PAGE();
      const scope = scopeOf('job');
      expect(scope).toContain('{employmentInfoCard}');
      // Direct Superior (a bitemporal line tagged as a movement) and the delegations (windowed records)
      // are bucket (b) and render outside.
      expect(scope).not.toContain('{directSuperiorCard}');
      expect(scope).not.toContain('{delegationsCard}');

      // The company-change forms live INSIDE employmentInfoCard, which is inside the scope. That is why
      // the fence is the MARKER and not the subtree: neither form carries one, so neither is read, packed
      // or reset — and the transfer keeps its own submit button.
      const from = page.indexOf('<form action={changeEmploymentCompanyAction}');
      expect(from).toBeGreaterThan(-1);
      const transferForm = page.slice(from, page.indexOf('</form>', from));
      expect(transferForm).not.toContain('data-save-section');
      expect(transferForm).toContain("t('employmentInfo.companyChangeSave')");
      // The phase-1 navigation form saves nothing at all (bucket (c)) and likewise carries no marker.
      const nav = page.indexOf('<form method="get"');
      expect(nav).toBeGreaterThan(-1);
      expect(page.slice(nav, page.indexOf('</form>', nav))).not.toContain('data-save-section');

      // r257 — THE READING ORDER, guarded, because the bar's honesty argument rests on it. r255's verify
      // pass reported this tab's Save bar rendering in the MIDDLE of the tab, above two editable cards it
      // does not cover, and the answer was `covers` naming the one card it owns rather than moving the
      // bar (Employment Information has to lead the tab, and a bar pushed to the foot would then read as
      // covering the two below it — worse). That answer only holds while the scope LEADS the tab: move
      // either bucket (b) card above it and the bar sinks further into the middle with more uncovered
      // cards above it as well as below. Attendance got this guard in r255
      // (test/personnel-holiday-grade-relocation.test.ts) and Payroll in r256
      // (test/personnel-payroll-tab-order.test.ts); this is the same guard for the third tab whose bar is
      // not last.
      const jobPanel = page.slice(page.indexOf('job: ('), page.indexOf('careerMovement: ('));
      expect(jobPanel).toContain('{directSuperiorCard}');
      expect(jobPanel).toContain('{delegationsCard}');
      expect(
        jobPanel.indexOf('{employmentInfoCard}'),
        'the consolidated card leads the tab, so the Save bar sits above only the two (b) cards',
      ).toBeLessThan(jobPanel.indexOf('{directSuperiorCard}'));
      expect(jobPanel.indexOf('{directSuperiorCard}')).toBeLessThan(jobPanel.indexOf('{delegationsCard}'));
    });

    it('Payroll: the three registers are OUTSIDE the scope, and the salary revision has no marker', () => {
      const page = PAGE();
      const scope = scopeOf('payroll');
      // The three bucket (a) cards, and the reorder that let them form a contiguous run.
      expect(scope).toContain('{compensationCard}');
      expect(scope).toContain('{payrollPolicyCard}');
      expect(scope).toContain('{tp3Card}');
      // Pay Items, CP38 and Leave Encashment are whole bucket (b) cards. Unlike the Employment tab's
      // company transfer, nothing forces them inside the run, so they stay out of it entirely.
      expect(scope).not.toContain('{payComponentsCard}');
      expect(scope).not.toContain('{cp38Card}');
      expect(scope).not.toContain('{encashmentCard}');
      const payrollPanel = page.slice(page.indexOf('payroll: ('), page.indexOf('leave: ('));
      for (const card of ['{payComponentsCard}', '{cp38Card}', '{encashmentCard}', '{zakatSummaryCard}']) {
        expect(payrollPanel, `${card} still renders on the tab, below the scope`).toContain(card);
      }
      // THE REORDER, pinned here as structure and in test/personnel-payroll-tab-order.test.ts as the
      // reading order it changes: TP3 moved from sixth to third so the (a) run is contiguous, and
      // compensation stays first (326f0b5e) with the policy second (R46 79eb7151).
      expect(payrollPanel.indexOf('{compensationCard}')).toBeLessThan(payrollPanel.indexOf('{payrollPolicyCard}'));
      expect(payrollPanel.indexOf('{payrollPolicyCard}')).toBeLessThan(payrollPanel.indexOf('{tp3Card}'));
      expect(payrollPanel.indexOf('{tp3Card}')).toBeLessThan(payrollPanel.indexOf('{payComponentsCard}'));

      // THE MARKER IS THE FENCE, and this is the sharpest case on the screen: the effective-dated salary
      // revision is a form inside a card the scope encloses. It must carry no marker and keep its own
      // submit, or the tab's Discard would appear to undo a recorded revision.
      const from = page.indexOf('<form action={setCompensationAction}');
      expect(from, 'the salary revision form exists').toBeGreaterThan(-1);
      expect(page.slice(from, page.indexOf('</form>', from))).not.toContain('data-save-section');
    });

    it('the four consolidated cards no longer carry a Save button of their own', () => {
      const page = PAGE();
      // Each card's former label, gone from the card it used to sit in.
      const statutory = page.slice(
        page.indexOf('<form action={setStatutoryAction}'),
        page.indexOf('</form>', page.indexOf('<form action={setStatutoryAction}')),
      );
      expect(statutory).not.toContain("t('saveStatutory')");
      expect(page).not.toContain("t('othersStatutorySave')}");
      expect(page).not.toContain("t('saveDetails')}");
      expect(page).not.toContain("t('employmentInfo.save')}");
      expect(page).not.toContain("tc('save')}");
      expect(stripComments(read('components/bank-info-card.tsx'))).not.toContain("t('bankSave')");
      expect(stripComments(read('components/identity-tax-card.tsx'))).not.toContain("t('identityTaxSave')");
      // r256 — the Payroll three. The message keys stay in messages/*.json (nothing prunes them and
      // test/tp3-payroll-relocation.test.ts still asserts `tp3Save` exists in all six locales); what must
      // be gone is the BUTTON, because a card that kept one would save twice on one tab.
      expect(page).not.toContain("t('paymentMethodSave')}");
      expect(page).not.toContain("tp('assignSave')}");
      expect(page).not.toContain("t('tp3Save')}");
    });

    it('every scope NAMES the cards its Save owns, because on three tabs the bar is not the last thing', () => {
      // A tab Save encloses a CONTIGUOUS run, so on Profile, Attendance and Employment the sticky bar
      // renders above cards it does not cover (emergency contacts; Work Location + Shift Arrangement;
      // Direct Superior + delegations). A bar reading only "Save Changes" there is a control that appears
      // to do something it does not — edit the Direct Superior, press the Save above it, and it answers
      // "No unsaved changes". `covers` prints the owned card names on the bar. It is a required prop, so
      // tsc already refuses a scope without one; this pins that each tab names its OWN cards.
      const page = PAGE();
      // The card names live in ONE map above the panels rather than inline on each scope: three existing
      // guards slice a tab panel from its key to the first `),`, and an inline `covers={[t('a'), t('b')]}`
      // would truncate all three (see the note on `tabSaveCovers`).
      expect(page).toContain("profile: [t('personalDetails'), t('contactAddressTitle')]");
      expect(page).toContain("bankStatutory: [t('bankCardTitle'), t('statutoryMalaysia'), t('othersStatutoryTitle')]");
      // f513ec02 (r281) — the Schedule Group card joined this scope, so the bar names it too. The entry is
      // UPDATED rather than loosened: Holiday Calendar stays first (item 52a30630), and a bar that gained
      // a card without gaining its name would be the same control-that-lies `covers` exists to prevent.
      expect(page).toContain(
        "attendance: [t('holidayCalendarCardTitle'), t('scheduleGroupCardTitle'), ...whenLive(tc('cardTitle'))]",
      );
      expect(page).toContain("job: [t('employmentInfo.title')]");
      // r256 — Payroll's entry names a SUB-SECTION of a card, not the card. Payment Method is rendered
      // inside Basic Salary, whose own headline control records an effective-dated salary revision, so a
      // bar reading "Basic Salary" would claim exactly what the classification forbids it to claim.
      // `payMethodGroup` is the heading the reader sees directly above the control the Save owns.
      // r298 (ceb1c560) — the policy card's name is dropped on a SECOND axis too: it is not drawn for a
      // tenant without Payroll, so `whenPayroll` wraps the same `whenLive` entry rather than replacing it.
      expect(page).toContain(
        "payroll: [t('payMethodGroup'), ...whenPayroll(...whenLive(tp('assignTitle'))), t('tp3SectionTitle')]",
      );
      expect(page, 'the bar must not name the card that holds the salary revision').not.toContain(
        "payroll: [t('compensation')",
      );
      // Five scopes, five `covers` — no scope may render a bare bar.
      expect(page.match(/<TabSaveScope/g)?.length).toBe(5);
      expect(page.match(/covers=\{tabSaveCovers\./g)?.length).toBe(5);
      // And the bar actually prints it (the key exists in all six locales — pinned by the i18n parity suite).
      expect(stripComments(read('components/tab-save-scope.tsx'))).toContain(
        "{t('covers', { cards: covers.join(', ') })}",
      );
    });

    /**
     * r256, and found by RENDERING the screen rather than by any test that existed.
     *
     * `covers` was added so a bar could not silently own LESS than the tab it sits on. The mirror fault
     * is a bar that claims MORE than it owns, and two cards had it: `clockingCard` and `payrollPolicyCard`
     * are both gated `admin && !emp.terminatedOn`, so on a terminated employment they render as nothing —
     * while the bar went on printing "Clocking locations & geofencing" and "Payroll policy". Attendance
     * shipped that way in r255; measured on a terminated employment the Attendance bar named two cards
     * with one on screen, and the Payroll bar would have named three with two.
     *
     * The guard is written so a THIRD conditional card cannot be added to a scope without answering the
     * question: it enumerates the `!emp.terminatedOn`-gated cards that any scope renders and pins that
     * set, so adding one fails here until its title is dropped by `whenLive` too.
     */
    it('the bar never names a card that a terminated employment does not render', () => {
      const page = PAGE();
      expect(page).toContain(
        'const whenLive = (...names: string[]): string[] => (emp.terminatedOn ? [] : names);',
      );
      // r298 — `payrollPolicyCard` gained a `payrollOn` term between `admin` and the termination test; it is
      // still a card a terminated employment does not render, so the pattern admits the term rather than
      // letting the card fall out of this set (which would make the whenLive assertion below vacuous for it).
      const gated = [...page.matchAll(/const (\w+Card) = admin (?:&& payrollOn )?&& !emp\.terminatedOn \?/g)].map(
        (m) => m[1],
      );
      // Every scope region on the page, gathered by scanning rather than through `scopeOf` — that helper
      // keys on a 12-space indentation the Profile scope does not have, so using it here silently checked
      // four of the five tabs.
      const regions: string[] = [];
      for (let at = page.indexOf('<TabSaveScope'); at > -1; at = page.indexOf('<TabSaveScope', at + 1)) {
        regions.push(page.slice(at, page.indexOf('</TabSaveScope>', at)));
      }
      expect(regions.length, 'one region per consolidated tab').toBe(5);
      const inAScope = gated.filter((card) => regions.some((r) => r.includes(`{${card}}`)));
      expect(
        inAScope.sort(),
        'a conditionally-rendered card inside a save scope must have its name dropped by whenLive',
      ).toEqual(['clockingCard', 'payrollPolicyCard']);
      // Payment Method is deliberately NOT dropped: that card IS rendered on a terminated employment,
      // with its select disabled, so naming it describes something the reader can see.
      expect(page).toContain("payroll: [t('payMethodGroup'), ...whenPayroll(...whenLive");
    });

    /**
     * r298 (ceb1c560) — THE SAME RULE ON THE PAYROLL AXIS. A tenant that has not bought Payroll is not
     * shown the Payroll Policy picker (its read, core/payroll-policy.ts, is the Payroll pack's). The bar
     * that owns that card must then not name it — the r256 fault again, reached by a different condition.
     * Every `payrollOn`-gated card inside a save scope must have its name inside `whenPayroll(...)`.
     */
    it('the bar never names a card that a tenant without Payroll does not render', () => {
      const page = PAGE();
      expect(page).toContain('const whenPayroll = (...names: string[]): string[] => (payrollOn ? names : []);');
      const gated = [...page.matchAll(/const (\w+Card) = admin && payrollOn\b[^?]*\?/g)].map((m) => m[1]);
      const regions: string[] = [];
      for (let at = page.indexOf('<TabSaveScope'); at > -1; at = page.indexOf('<TabSaveScope', at + 1)) {
        regions.push(page.slice(at, page.indexOf('</TabSaveScope>', at)));
      }
      expect(regions.length, 'one region per consolidated tab').toBe(5);
      const inAScope = gated.filter((card) => regions.some((r) => r.includes(`{${card}}`)));
      expect(
        inAScope.sort(),
        'a Payroll-gated card inside a save scope must have its name dropped by whenPayroll',
      ).toEqual(['payrollPolicyCard']);
      expect(page).toContain("...whenPayroll(...whenLive(tp('assignTitle')))");
    });

    it('every section the map declares has a writer in its tab action, and no tab has a stray one', () => {
      const actions = ACTIONS();
      const writersOf = (fn: string) => {
        const from = actions.indexOf(`export async function ${fn}(`);
        expect(from, `${fn} exists`).toBeGreaterThan(-1);
        const body = actions.slice(from, actions.indexOf('\n}', from));
        return [...body.matchAll(/^\s{4}(\w+): apply/gm)].map((m) => m[1]);
      };
      expect(writersOf('saveBankStatutoryTabAction').sort()).toEqual([...BANK_STATUTORY_TAB_SECTION_ORDER].sort());
      expect(writersOf('saveAttendanceTabAction').sort()).toEqual([...ATTENDANCE_TAB_SECTION_ORDER].sort());
      expect(writersOf('saveJobTabAction').sort()).toEqual([...JOB_TAB_SECTION_ORDER].sort());
      expect(writersOf('savePayrollTabAction').sort()).toEqual([...PAYROLL_TAB_SECTION_ORDER].sort());
    });

    /**
     * r256 UPDATED THIS CASE RATHER THAN REPLACING IT. It read "the map still declares FOUR tabs —
     * Payroll, Family and Qualification are not among them", and its reasoning for holding Payroll back
     * was: three field edits among six child-record cards including the effective-dated salary revision,
     * with Payment Method rendered INSIDE the Basic Salary card. Both halves were answered rather than
     * waived — the fence is the marker and not the subtree (so the revision in that card is untouched),
     * and `covers` names the sub-section rather than the card (so the bar cannot claim it). §7 below is
     * the behaviour half of that answer.
     *
     * FAMILY AND QUALIFICATION STAY OUT, and no mechanism can change that: every form on both tabs is a
     * child record — a dependant, a qualification — so a tab-wide Save there would have nothing to save
     * and a tab-wide Discard would cover nothing. That is a fact about those tabs, not a caution.
     */
    it('the map declares FIVE tabs — Family and Qualification are not, and cannot be, among them', () => {
      expect(Object.keys(PERSONNEL_TAB_SECTIONS).sort()).toEqual(
        ['attendance', 'bankStatutory', 'job', 'payroll', 'profile'],
      );
      // Not "not yet". Every writer either tab would need is a child-record action with its own button.
      const page = PAGE();
      for (const childRecordAction of [
        'addDependentAction',
        'archiveDependentAction',
        'addQualificationAction',
        'archiveQualificationAction',
      ]) {
        const from = page.indexOf(`action={${childRecordAction}}`);
        const ternary = page.indexOf(childRecordAction);
        expect(ternary, `${childRecordAction} is still wired to a form`).toBeGreaterThan(-1);
        if (from > -1) {
          expect(page.slice(from, page.indexOf('</form>', from))).not.toContain('data-save-section');
        }
      }
    });
  });

  // ── §7 r256 · PAYROLL — the tab the audit held back twice ─────────────────────────────────────────
  //
  // What is worth pinning here is NOT that three fields save. It is what the tab's one Save leaves alone.
  // Six of the seven cards on this tab carry a bucket (b) form, and one of them — the effective-dated
  // salary revision — is inside the very card the scope encloses, because Payment Method is nested in it.
  // The classification exists to stop a Discard appearing to cover that revision; these cases are the
  // behavioural half of the argument that it does not.
  describe('§7 Payroll writes its three field edits and reaches nothing else', () => {
    const paymentFields = (method: string) => ({
      [key('payment', 'employmentId')]: employmentId,
      [key('payment', 'paymentMethod')]: method,
    });
    const policyFields = (policyId: string) => ({
      [key('policy', 'employmentId')]: employmentId,
      [key('policy', 'policyId')]: policyId,
    });
    const tp3Fields = (year: string, net: string) => ({
      [key('tp3', 'employmentId')]: employmentId,
      [key('tp3', 'personId')]: personId,
      [key('tp3', 'tp3Year')]: year,
      [key('tp3', 'tp3NetRemuneration')]: net,
      [key('tp3', 'tp3EpfClaimed')]: '',
      [key('tp3', 'tp3PcbPaid')]: '',
    });

    /** A policy in the employment's OWN company — assignPolicy refuses a cross-company one. */
    async function seedPolicy(name = 'Monthly Staff') {
      const { id } = await createPolicy(adminCtx(base), {
        companyId: base.companyId,
        name,
        policyType: 'monthly',
      });
      return id;
    }

    it('the declared order is payment → policy → tp3', () => {
      expect([...PAYROLL_TAB_SECTION_ORDER]).toEqual(['payment', 'policy', 'tp3']);
    });

    it('one request saves all three cards through their own services', async () => {
      await seedStatutory();
      const policyId = await seedPolicy();

      const result = await savePayrollTabAction(
        payload(
          ['payment', 'policy', 'tp3'],
          { ...paymentFields('cheque'), ...policyFields(policyId), ...tp3Fields('2026', '12345.50') },
          employmentId,
          'payroll',
        ),
      );

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['payment', 'policy', 'tp3']);
      const emp = await readEmployment(employmentId);
      expect(emp.paymentMethod).toBe('cheque');
      expect(emp.payrollPolicyId).toBe(policyId);
      const row = await readStatutory(personId);
      expect(row.tp3Year).toBe(2026);
      expect(Number(row.tp3NetRemuneration)).toBe(12345.5);
    });

    /**
     * THE MONEY GUARD FOR THIS TAB. `compensationCard` is rendered INSIDE the Payroll scope — it has to
     * be, because Payment Method is nested in it — so this is the one place on the screen where a tab
     * Save sits in the same card as an effective-dated salary revision. Saving the tab must leave the
     * compensation history byte-identical: same rows, same amounts, same open/closed periods.
     */
    it('a Payroll tab save does not touch the salary revisions in the card it is nested in', async () => {
      await seedStatutory();
      const a = adminCtx(base);
      await setCompensation(a, {
        employmentId,
        basicSalary: 8000,
        effectiveFrom: '2026-01-01',
        remarks: 'Hire',
      });
      await setCompensation(a, {
        employmentId,
        basicSalary: 9000,
        effectiveFrom: '2026-07-01',
        remarks: 'Annual increment',
      });
      const before = await readCompensation(employmentId);
      expect(before.length, 'two revisions: one closed, one in force').toBe(2);

      const result = await savePayrollTabAction(
        payload(
          ['payment', 'tp3'],
          { ...paymentFields('cash'), ...tp3Fields('2025', '999') },
          employmentId,
          'payroll',
        ),
      );

      expect(result.ok).toBe(true);
      expect(await readCompensation(employmentId), 'the salary history is untouched').toEqual(before);
      expect((await readEmployment(employmentId)).paymentMethod, 'the edit that was asked for').toBe('cash');
    });

    it('an untouched card is never written — its service is not called at all', async () => {
      await seedStatutory({ tp3Year: 2024, tp3NetRemuneration: 1 });
      const policyId = await seedPolicy();
      const a = adminCtx(base);
      await assignPolicy(a, { employmentId, policyId });

      // Only TP3 is dirty. Payment Method and the policy are not in `sections`, so neither writer runs.
      const result = await savePayrollTabAction(
        payload(['tp3'], tp3Fields('2026', '4200'), employmentId, 'payroll'),
      );

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['tp3']);
      const emp = await readEmployment(employmentId);
      expect(emp.paymentMethod, 'never set, and a TP3 edit must not set it').toBeNull();
      expect(emp.payrollPolicyId, 'the assignment the admin made earlier stands').toBe(policyId);
      expect((await readStatutory(personId)).tp3Year).toBe(2026);
    });

    it('reports which card broke, names the ones that had already committed, and stops there', async () => {
      await seedStatutory({ tp3Year: 2024 });
      // payment commits, policy refuses (no such policy), tp3 is never reached — the declared order is
      // payment → policy → tp3, so a mid-request failure must leave the LAST section unwritten.
      const result = await savePayrollTabAction(
        payload(
          ['payment', 'policy', 'tp3'],
          {
            ...paymentFields('cheque'),
            ...policyFields('11111111-1111-1111-1111-111111111111'),
            ...tp3Fields('2026', '4200'),
          },
          employmentId,
          'payroll',
        ),
      );

      expect(result.ok).toBe(false);
      expect(result.failedSection).toBe('policy');
      expect(result.saved, 'the card that DID commit is named so the client can mark it clean').toEqual([
        'payment',
      ]);
      expect((await readEmployment(employmentId)).paymentMethod).toBe('cheque');
      expect((await readStatutory(personId)).tp3Year, 'the section after the failure never ran').toBe(2024);
    });

    it('a tampered payment method is refused before anything on the tab is written', async () => {
      await seedStatutory({ tp3Year: 2024 });
      const result = await savePayrollTabAction(
        payload(
          ['payment', 'tp3'],
          { ...paymentFields('crypto'), ...tp3Fields('2026', '4200') },
          employmentId,
          'payroll',
        ),
      );
      expect(result.ok).toBe(false);
      expect(result.failedSection).toBe('payment');
      expect(result.saved).toEqual([]);
      expect((await readEmployment(employmentId)).paymentMethod).toBeNull();
      expect((await readStatutory(personId)).tp3Year).toBe(2024);
    });
  });
});
