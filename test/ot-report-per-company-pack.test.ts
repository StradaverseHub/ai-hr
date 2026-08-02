/**
 * ADR-0077 slice 6 — the overtime report resolves its ruleset PER COMPANY, and labels its currency.
 *
 * WHAT IT USED TO DO, in its own words: *"All companies in scope share the tenant-wide ruleset; resolve
 * via the pack of the first company that has one."* It then did exactly that —
 * `emps.find((e) => packFor(e.country))?.country` — so ONE jurisdiction's overtime multipliers and wage
 * ceiling were applied to EVERY company in the report.
 *
 * With MY the only registered pack that is byte-identical, which is why nothing caught it. With two, a
 * report spanning a Malaysian and a Singaporean company computes the Singaporean employees under
 * Malaysian overtime rules and presents the result as theirs — the same harm the two-tier company (D-14)
 * exists to prevent, arriving through a report instead of a mis-keyed country field.
 *
 * SO THESE TESTS REGISTER A SECOND COUNTRY PACK with deliberately different multipliers. That is the only
 * way to tell the fix from the bug before a real second pack ships. (Safe here for the reason recorded in
 * test/state-vocabulary-scoping.test.ts: test/pack-registry.test.ts:28 asserts `listPacks('country')`
 * EXACTLY equals ['country-my'], so a leak across files fails loudly there rather than silently here.)
 *
 * THE CURRENCY COLUMN is the other half (D-9). `otAmount` was a bare number under a header that said
 * 'OT amount (RM)' — a literal that is simply false for a company not in Malaysia, and an invitation to
 * sum two currencies in a spreadsheet. The amount now travels with its company's own currency.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, adminCtx, type Base } from './harness';
import { OVERTIME_REPORT_COLUMNS, overtimeReport, overtimeReportToReportData } from '../core/reporting';
import { registerPack, packById } from '../packs/registry';
import { packFor } from '../localization/registry';

/** A second jurisdiction whose OT excess multipliers differ from Malaysia's, so the two are separable. */
const XX_REST = 9;
const XX_HOLIDAY = 11;

beforeAll(() => {
  const my = packFor('MY');
  if (!my) throw new Error('the MY pack must be registered for this test to mean anything');
  registerPack({
    id: 'country-xx',
    kind: 'country',
    country: 'XX',
    pack: {
      ...my,
      country: 'XX',
      payroll: {
        ...my.payroll,
        // Same shape as MY's, with the two excess multipliers moved so a row computed under the wrong
        // jurisdiction is unmistakable in the output rather than merely slightly off.
        loadRuleset: async (tx: unknown, o: { asOf: string }) => {
          const base = await my.payroll.loadRuleset(tx as never, o);
          return {
            ...base,
            ot: { ...base.ot, restDayExcessMultiplier: XX_REST, holidayExcessMultiplier: XX_HOLIDAY },
          };
        },
      },
    },
  });
});

describe('the second pack is really registered — otherwise everything below is vacuous', () => {
  it('country-xx resolves', () => {
    expect(packById('country-xx')).toBeTruthy();
    expect(packFor('XX')).toBeTruthy();
  });
});

describe('against the real database', () => {
  let b: Base;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  /** A second company in `country`, with its own currency. */
  const addCompany = async (legalName: string, country: string, currency: string) => {
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName, country, currency })
      .returning({ id: schema.company.id });
    return c.id;
  };

  const addEmployee = async (companyId: string, name: string) => {
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name.toLowerCase()}@example.test` })
      .returning({ id: schema.person.id });
    const [e] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, companyId, personId: p.id, hiredOn: '2020-01-01' })
      .returning({ id: schema.employment.id });
    return e.id;
  };

  it('gives each company its OWN jurisdiction’s multipliers, not the first one found', async () => {
    // The base company is MY. Add an XX company; both appear in one report.
    const xxCompany = await addCompany('Overseas Plant', 'XX', 'SGD');
    await addEmployee(b.companyId, 'Aisyah');
    await addEmployee(xxCompany, 'Wei');

    const report = await overtimeReport(adminCtx(b), { month: '2026-07' });
    expect(report.rows).toHaveLength(2);

    const my = report.rows.find((r) => r.name === 'Aisyah')!;
    const xx = report.rows.find((r) => r.name === 'Wei')!;

    // Malaysia's configured defaults, unchanged.
    expect(my.restDayExcessMultiplier).toBe(2);
    expect(my.holidayExcessMultiplier).toBe(3);
    // The other jurisdiction's — which the OLD code could never have produced, because it resolved one
    // ruleset for the whole report and applied it to every row.
    expect(xx.restDayExcessMultiplier).toBe(XX_REST);
    expect(xx.holidayExcessMultiplier).toBe(XX_HOLIDAY);
  });

  it('is order-independent — the answer does not depend on which company sorts first', async () => {
    // The old bug was literally "the first company that has a pack", so a report whose first row is the
    // FOREIGN company would previously have imposed the foreign ruleset on the Malaysian one. Sorting is
    // by employee name, so 'Aaron' (XX) precedes 'Zulkifli' (MY).
    const xxCompany = await addCompany('Overseas Plant', 'XX', 'SGD');
    await addEmployee(xxCompany, 'Aaron');
    await addEmployee(b.companyId, 'Zulkifli');

    const report = await overtimeReport(adminCtx(b), { month: '2026-07' });
    const first = report.rows[0];
    const my = report.rows.find((r) => r.name === 'Zulkifli')!;
    expect(first.name).toBe('Aaron');
    expect(my.restDayExcessMultiplier).toBe(2);
    expect(my.holidayExcessMultiplier).toBe(3);
  });

  it('carries each row’s own company currency', async () => {
    const xxCompany = await addCompany('Overseas Plant', 'XX', 'SGD');
    await addEmployee(b.companyId, 'Aisyah');
    await addEmployee(xxCompany, 'Wei');

    const report = await overtimeReport(adminCtx(b), { month: '2026-07' });
    expect(report.rows.find((r) => r.name === 'Aisyah')!.currency).toBe('MYR');
    expect(report.rows.find((r) => r.name === 'Wei')!.currency).toBe('SGD');
  });

  it('a company with NO registered pack still reports, with the statutory fallbacks', async () => {
    // Not an error case: r111's non-statutory tier makes packless companies a legitimate state, and a
    // report must show those employees rather than omit them silently.
    const thCompany = await addCompany('Bangkok Plant', 'TH', 'THB');
    await addEmployee(thCompany, 'Somchai');

    const report = await overtimeReport(adminCtx(b), { month: '2026-07' });
    const th = report.rows.find((r) => r.name === 'Somchai')!;
    expect(th).toBeTruthy();
    expect(th.currency).toBe('THB');
    // The documented fallbacks, not another country's configured values.
    expect(th.restDayExcessMultiplier).toBe(2);
    expect(th.holidayExcessMultiplier).toBe(3);
    expect(th.otAmount).toBe(0); // no pack ⇒ no overtimePay computation, and zero is stated not guessed
  });
});

describe('the export never asserts a currency it does not know', () => {
  it('has a Currency column and no hardcoded RM in the amount header', () => {
    expect(OVERTIME_REPORT_COLUMNS).toContain('Currency');
    expect(OVERTIME_REPORT_COLUMNS).toContain('OT amount');
    // The old header. False for any company outside Malaysia.
    expect(OVERTIME_REPORT_COLUMNS).not.toContain('OT amount (RM)');
  });

  it('emits the currency cell alongside the amount, in matching positions', () => {
    const data = overtimeReportToReportData({
      month: '2026-07',
      statutoryVersion: 'test',
      rows: [
        {
          employmentId: 'e1', name: 'Wei', employeeCode: 'E1',
          normalWorkingHours: 160, totalWorkedHours: 170, totalOtHours: 10,
          normalDayOtHours: 10, restDayOtHours: 0, publicHolidayOtHours: 0,
          workdayMultiplier: 1.5, restDayExcessMultiplier: 2, holidayExcessMultiplier: 3,
          otAmount: 123.45, currency: 'SGD', eligible: true, otSource: 'system', otApprovalStatus: 'approved',
        },
      ],
    });
    const amountAt = data.columns.indexOf('OT amount');
    const currencyAt = data.columns.indexOf('Currency');
    expect(currencyAt).toBe(amountAt + 1);
    expect(data.rows[0][amountAt]).toBe('123.45');
    expect(data.rows[0][currencyAt]).toBe('SGD');
  });
});
