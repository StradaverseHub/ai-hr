/**
 * ADR-0077 slice 6 (D-9) — THE CUSTOM REPORT RUNNER MUST NOT ADD TWO CURRENCIES TOGETHER.
 *
 * WHERE THE FAULT WAS. `runReportSpec` (core/report-registry.ts) appends an optional `Total` / `Average`
 * row over whatever numeric or currency columns the operator ticked in the builder. Every dataset in the
 * registry is read with `companyIds: scopeIds` — across every company the operator can see — so that one
 * row summed ringgit into whatever else was in scope and printed a single number. lib/money.ts calls that
 * out as the fault that MATTERS ("a grand total that ADDS ringgit to some other currency … is arithmetic
 * nobody authorised, and no amount of relabelling fixes it"), and until this slice the primitive that
 * refuses it was wired to exactly one screen.
 *
 * WHY THIS FILE IS PURE. The arithmetic is the thing under test, not the reads. A fake dataset gives
 * exact control of the currency mix, which is what makes "1500 and 200, never 1700" assertable; a DB
 * fixture would prove the same property far less directly and much more slowly. The registry entry is
 * removed in `afterAll` so nothing leaks — and vitest isolates modules per file anyway.
 *
 * LATENT, NOT LIVE. Production is nine companies, all Malaysian, in one tenant: every bucket is MYR, the
 * single-total path is taken, and the printed number is unchanged. This is for the second country.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { REPORT_DATASETS, getDataset, runReportSpec, type ReportDataset, type ReportRow } from '../core/report-registry';

const FAKE = 'test_mixed_currency';
/**
 * r292 — A RESOLVED SNAPSHOT, not `{}`. `runReportSpec` now gates the run on the dataset's category
 * (core/report-registry.ts `assertReportCategoryEnabled`), so a report over a PAYROLL dataset asks
 * whether this tenant holds Payroll. `{} as SessionContext` is the synthetic-context state
 * `EntitlementsUnresolvedError` exists to flag — it is not "entitled", it is "nobody resolved this" —
 * and the fixture must therefore state which modules the tenant has rather than leaving the question
 * unanswerable. The dataset below is category 'payroll' and stays that way: the fixture is about the
 * per-currency summary rows, and downgrading it to a core category to dodge the gate would quietly stop
 * exercising the money-shaped dataset this file is named for.
 */
const TENANT = '11111111-1111-1111-1111-111111111111';
const ctx = {
  tenantId: TENANT,
  entitlements: {
    tenantId: TENANT,
    enabledModules: ['payroll'],
    scopedModules: {},
    settings: {},
    tenantStatus: 'active',
  },
} as unknown as SessionContext;

/** Rows are supplied per test; the dataset itself never touches the database. */
let supplied: ReportRow[] = [];

const dataset: ReportDataset = {
  id: FAKE,
  category: 'payroll',
  label: 'Mixed currency fixture',
  fields: [
    { id: 'name', label: 'Employee Name', type: 'text', group: 'Identity' },
    { id: 'currency', label: 'Currency', type: 'text', group: 'Identity' },
    { id: 'net', label: 'Nett Wage', type: 'currency', group: 'Pay' },
    { id: 'hours', label: 'Hours', type: 'number', group: 'Time' },
  ],
  filters: [],
  defaultColumns: ['name', 'net'],
  run: async () => supplied,
};

beforeAll(() => {
  REPORT_DATASETS[FAKE] = dataset;
});
afterAll(() => {
  delete REPORT_DATASETS[FAKE];
});

const run = (columns: string[], layout: Record<string, unknown>) =>
  runReportSpec(ctx, ['scope'], { datasetId: FAKE, columns, layout } as never);

/** The appended aggregate rows — everything after the supplied body. */
const tail = (rows: (string | number | null)[][]) => rows.slice(supplied.length);

describe('summing a currency column across companies', () => {
  it('splits the Total per currency, and never prints their sum', async () => {
    supplied = [
      { name: 'Aisyah', currency: 'MYR', net: 1000, hours: 8 },
      { name: 'Nurul', currency: 'MYR', net: 500, hours: 8 },
      { name: 'Wei', currency: 'SGD', net: 200, hours: 8 },
    ];
    const out = await run(['name', 'net'], { summary: ['net'] });
    const totals = tail(out.rows);

    expect(totals).toEqual([
      ['Total (MYR)', 1500],
      ['Total (SGD)', 200],
    ]);
    // THE LOAD-BEARING ASSERTION. 1700 is what the old code printed: three payslips in two currencies
    // added into one figure, under a header that named neither.
    expect(totals.flat()).not.toContain(1700);
  });

  it('one currency ⇒ ONE unlabelled Total row, exactly as before', async () => {
    // The regression guard for production. Nine Malaysian companies must see a byte-identical report.
    supplied = [
      { name: 'Aisyah', currency: 'MYR', net: 1000, hours: 8 },
      { name: 'Nurul', currency: 'MYR', net: 500, hours: 8 },
    ];
    const out = await run(['name', 'net'], { summary: ['net'] });
    expect(tail(out.rows)).toEqual([['Total', 1500]]);
  });

  it('a dataset that carries NO currency at all takes the single-total path', async () => {
    // Eight of the nine registered datasets are in this position today. They must be untouched, not
    // silently relabelled "(unlabelled)" — an absent concept is not a mixed one.
    supplied = [
      { name: 'Aisyah', net: 1000, hours: 8 },
      { name: 'Nurul', net: 500, hours: 8 },
    ];
    const out = await run(['name', 'net'], { summary: ['net'] });
    expect(tail(out.rows)).toEqual([['Total', 1500]]);
  });

  it('an UNKNOWN currency is its own bucket, not a match for the others', async () => {
    // money.ts: "Treating absent as 'same as the others' is precisely how a foreign row gets silently
    // folded into a ringgit total." The bucket sorts first ('' < 'MYR') and says what it is.
    supplied = [
      { name: 'Aisyah', currency: 'MYR', net: 1000, hours: 8 },
      { name: 'Ghost', currency: null, net: 77, hours: 8 },
    ];
    const out = await run(['name', 'net'], { summary: ['net'] });
    expect(tail(out.rows)).toEqual([
      ['Total (unlabelled)', 77],
      ['Total (MYR)', 1000],
    ]);
  });

  it('Average splits the same way, and averages WITHIN a currency', async () => {
    supplied = [
      { name: 'Aisyah', currency: 'MYR', net: 1000, hours: 8 },
      { name: 'Nurul', currency: 'MYR', net: 500, hours: 8 },
      { name: 'Wei', currency: 'SGD', net: 200, hours: 8 },
    ];
    const out = await run(['name', 'net'], { averages: ['net'] });
    // 750 is the MYR mean. The old code produced 566.67 — the mean of three amounts in two currencies,
    // which is not a quantity that exists.
    expect(tail(out.rows)).toEqual([
      ['Average (MYR)', 750],
      ['Average (SGD)', 200],
    ]);
  });

  it('a NON-money column stays one row even across currencies — hours are hours everywhere', async () => {
    // The split is a property of MONEY, not of the row set. Splitting an hours total by currency would be
    // noise, and would make the fix feel arbitrary to whoever meets it next.
    supplied = [
      { name: 'Aisyah', currency: 'MYR', net: 1000, hours: 8 },
      { name: 'Wei', currency: 'SGD', net: 200, hours: 10 },
    ];
    const out = await run(['name', 'hours'], { summary: ['hours'] });
    expect(tail(out.rows)).toEqual([['Total', 18]]);
  });

  it('protects a report whose author never added the Currency column', async () => {
    // The currency is read off the ROW, not off the chosen columns. This is the realistic case: nobody
    // ticks a Currency column on a report they believe is single-country.
    supplied = [
      { name: 'Aisyah', currency: 'MYR', net: 1000, hours: 8 },
      { name: 'Wei', currency: 'SGD', net: 200, hours: 8 },
    ];
    const out = await run(['name', 'net'], { summary: ['net'] });
    expect(out.columns).not.toContain('Currency');
    expect(tail(out.rows)).toEqual([
      ['Total (MYR)', 1000],
      ['Total (SGD)', 200],
    ]);
  });
});

describe('the real datasets carry the currency the runner needs', () => {
  it('payroll_register offers Currency, and did not change its default columns', async () => {
    const ds = getDataset('payroll_register')!;
    expect(ds.fields.some((f) => f.id === 'currency')).toBe(true);
    // Additive by construction: a saved report's column set is untouched by this slice.
    expect(ds.defaultColumns).not.toContain('currency');
  });

  it('attendance_ot offers Currency — r115 already resolved it per company, the projection dropped it', () => {
    const ds = getDataset('attendance_ot')!;
    expect(ds.fields.some((f) => f.id === 'currency')).toBe(true);
    expect(ds.defaultColumns).not.toContain('currency');
  });

  it('payroll_history offers Currency — seven money columns, read across every company in scope', () => {
    const ds = getDataset('payroll_history')!;
    expect(ds.fields.some((f) => f.id === 'currency')).toBe(true);
    expect(ds.defaultColumns).not.toContain('currency');
  });

  it('master already carried one — this slice did not invent the pattern', () => {
    expect(getDataset('master')!.fields.some((f) => f.id === 'currency')).toBe(true);
  });

  /**
   * THE GAP THIS SLICE DID NOT CLOSE, pinned so it is a failing expectation the day someone fixes it
   * rather than a paragraph nobody reads. `attendance_daily` has one money column
   * (`attendanceAllowance`) and no currency, so a mixed-currency Total over it is not merely unlabelled —
   * the runner cannot even SEE that it is mixed, and takes the single-total path. Harmless today (nine
   * Malaysian companies); wrong the day a second country lands. Closing it means threading the company
   * currency through `attendanceDailyReport` (core/reporting.ts), which is a wider read than this sweep
   * took on.
   */
  it('KNOWN GAP: every dataset with a money column carries a currency, EXCEPT attendance_daily', () => {
    const unguarded = Object.values(REPORT_DATASETS)
      .filter((d) => d.fields.some((f) => f.type === 'currency'))
      .filter((d) => !d.fields.some((f) => f.id === 'currency'))
      .map((d) => d.id);
    expect(unguarded).toEqual(['attendance_daily']);
  });
});
