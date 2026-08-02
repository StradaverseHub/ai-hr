/**
 * ADR-0080 slice 6 (D-9) — a total over mixed currencies is not a number.
 *
 * r115 fixed the overtime report by resolving its pack per company and labelling its currency. This
 * pins the GENERAL primitive, so the next cross-company report cannot reintroduce the same fault by
 * writing `rows.reduce(...)` and printing one figure.
 *
 * The fault being guarded is arithmetic, not labelling: `listUnattachedGroups` spans every company in
 * scope, and its grand total used to add the amounts blind. Two companies on different currencies
 * produced one unlabelled number that meant nothing.
 */
import { describe, expect, it } from 'vitest';
import { formatMoney, isMixedCurrency, singleCurrencyOf, totalsByCurrency } from '../lib/money';

describe('slice 6 — mixed-currency detection', () => {
  it('one currency across every row resolves to that currency', () => {
    expect(singleCurrencyOf([{ currency: 'MYR' }, { currency: 'MYR' }])).toBe('MYR');
    expect(isMixedCurrency([{ currency: 'MYR' }, { currency: 'MYR' }])).toBe(false);
  });

  it('two currencies resolve to NULL — there is no single currency to report in', () => {
    expect(singleCurrencyOf([{ currency: 'MYR' }, { currency: 'SGD' }])).toBeNull();
    expect(isMixedCurrency([{ currency: 'MYR' }, { currency: 'SGD' }])).toBe(true);
  });

  it('an UNKNOWN currency is its own bucket, never a match for a known one', () => {
    // Treating absent as "same as the others" is exactly how a foreign row gets folded into a ringgit
    // total. An unknown currency must break the single-currency claim, not inherit one.
    expect(isMixedCurrency([{ currency: 'MYR' }, { currency: null }])).toBe(true);
    expect(singleCurrencyOf([{ currency: 'MYR' }, { currency: undefined }])).toBeNull();
  });

  it('no rows means no currency, not a defaulted one', () => {
    expect(singleCurrencyOf([])).toBeNull();
    expect(isMixedCurrency([])).toBe(false);
  });
});

describe('slice 6 — per-currency subtotals', () => {
  it('splits the total per currency instead of adding across them', () => {
    const out = totalsByCurrency([
      { currency: 'MYR', amount: '1200.50' },
      { currency: 'SGD', amount: '300.25' },
      { currency: 'MYR', amount: '99.50' },
    ]);
    expect(out).toEqual([
      { currency: 'MYR', total: 1300 },
      { currency: 'SGD', total: 300.25 },
    ]);
  });

  it('sums in cents — the four-figure bonuses this screen exists to surface must not drift', () => {
    const out = totalsByCurrency(
      Array.from({ length: 3 }, () => ({ currency: 'MYR', amount: 0.1 })),
    );
    expect(out[0].total).toBe(0.3); // 0.1+0.1+0.1 as floats is 0.30000000000000004
  });

  it('keeps an unknown-currency bucket separate rather than merging it into a known one', () => {
    const out = totalsByCurrency([
      { currency: 'MYR', amount: 100 },
      { currency: null, amount: 50 },
    ]);
    expect(out).toEqual([
      { currency: null, total: 50 },
      { currency: 'MYR', total: 100 },
    ]);
  });

  it('offers NO grand total — a caller cannot accidentally get one figure back', async () => {
    // The absence is the design. If this module ever grows a `grandTotal`, the fault returns.
    const mod = await import('../lib/money');
    expect(Object.keys(mod)).not.toContain('grandTotal');
  });
});

describe('slice 6 — money is labelled with the currency it is in', () => {
  it('renders the ISO code as a prefix, not a locale-dependent symbol', () => {
    // Intl currency style would render MYR as "RM" or "MYR" depending on the READER's locale, so the
    // same payroll figure would read differently to two people looking at the same screen.
    expect(formatMoney(1234.5, 'MYR')).toBe('MYR 1,234.50');
    expect(formatMoney(1234.5, 'SGD')).toBe('SGD 1,234.50');
  });

  it('an unknown currency prints the bare number — unlabelled is honest, defaulted is a claim', () => {
    expect(formatMoney(1234.5, null)).toBe('1,234.50');
  });

  it('accepts the numeric STRINGS postgres returns, and refuses garbage visibly', () => {
    expect(formatMoney('1200.50', 'MYR')).toBe('MYR 1,200.50');
    expect(formatMoney(null, 'MYR')).toBe('—');
    expect(formatMoney('not a number', 'MYR')).toBe('—');
  });
});

/**
 * ADR-0080 slice 6 — the compliance worklist is JURISDICTION-OWNED.
 *
 * CP22 / CP22A are Malaysian LHDN forms. Before this, `complianceWorklist` emitted them for every
 * company in the tenant, so a company in a jurisdiction no pack owns was told it had a statutory filing
 * obligation, complete with a due date. The gate mirrors r111's two-tier company: no pack, no worklist.
 */
import { beforeAll, describe as describeWl, expect as expectWl, it as itWl } from 'vitest';
import { adminCtx, migrateTestDb, seedBase, type Base } from './harness';
import { complianceWorklist } from '../core/reporting';
import { createCompany } from '../core/admin';

let wlBase: Base;
beforeAll(async () => {
  await migrateTestDb();
  wlBase = await seedBase();
});

describeWl('slice 6 — the statutory worklist follows the company jurisdiction', () => {
  itWl('a company whose country no pack owns gets an EMPTY worklist, not Malaysian forms', async () => {
    const ctx = adminCtx(wlBase);
    const co = await createCompany(ctx, {
      legalName: `Offshore Holdings ${Math.floor(performance.now())}`,
      country: 'SG',
      // SG has no registered pack, so the two-tier model (D-14) requires the tier to be DECLARED —
      // never inferred, so a mis-keyed ISO code cannot silently become a tier.
      nonStatutory: true,
    });
    const wl = await complianceWorklist(ctx, { companyId: co.id, today: '2026-03-01' });
    // The correct empty. A non-statutory company has no statutory obligations to list.
    expectWl(wl).toEqual([]);
  });
});
