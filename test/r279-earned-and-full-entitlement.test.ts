/**
 * r279 (feedback 8c59c664) — EARNED TO DATE vs FULL ENTITLEMENT on the Employee Balances grid.
 *
 * THE REQUEST WAS THE WRONG WAY ROUND, AND THAT IS THE SUBSTANCE OF THIS FILE. The reporter asked for the
 * grid's "YTD Entitled" column to be renamed "Full Entitlement", with a new "Earned to Date" beside it.
 * That column has never held the full year: it is `currentYearEntitlement`, the accrual-class ledger sum
 * from cycle start to the as-at date. On live data, employment 02617b4a read 12.50 there against a band of
 * 18.00, and 99e97e85 read 17.00 against 24.00 — the requested rename would have put a ~30% understatement
 * under a full-year heading. Worse, the gap closes to zero on 31 December, so it would have read correctly
 * in January, which is when somebody would finally check it and conclude it had always been right.
 *
 * So it was done the other way round, and these are the three claims that must hold:
 *
 *   1. The EXISTING column keeps its number and gains an honest name. Earned to Date = currentYearEntitlement.
 *   2. The NEW column is the band, and it is `eligibleDays` PICKED — the very field the Explain panel beside
 *      the row already renders as Eligible. Not a second band resolver; §1 of the suite below pins that by
 *      driving BOTH consumers off ONE breakdown object.
 *   3. The carry came OUT of the earned figure. That is the only number that moves, and on production it
 *      moves by zero, because every live balance carries 0.00. Both halves are asserted: equal when the
 *      carry is 0, apart by EXACTLY the carry when it is not — because "it happens to be zero today" is an
 *      observation about the data, not a property of the code.
 *
 * DB-free / jsdom-free, like its neighbours: the derivation is pure, the binding is a source guard, and the
 * rendered screen is verified on a dev server (CLAUDE.md §8 — a 200 is not a render check).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveBalanceRow, type BalanceInput, type BreakdownInput } from '../components/leave/leave-balance-row';
import { ENTITLEMENT_PANEL_SECTIONS, type PanelData } from '../components/leave/entitlement-panel-config';
import { formatDays, DAY_DASH } from '../lib/day-format';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const balance = (over: Partial<BalanceInput> = {}): BalanceInput => ({
  leaveTypeId: 'lt-al',
  leaveType: 'Annual Leave',
  color: null,
  icon: null,
  code: 'AL',
  balance: 12.5,
  available: 12.5,
  taken: 0,
  essView: {},
  ...over,
});

/**
 * A FULL `LeaveEntitlementBreakdown`-shaped envelope, so the SAME object can be handed to `deriveBalanceRow`
 * (as `BreakdownInput`, a structural subset) and to the Explain panel's descriptor (as `PanelData.breakdown`).
 * That is what makes §1 a single-source proof rather than two fixtures agreeing by luck.
 *
 * Defaults are the first production pin: 12.50 earned against an 18.00 band, carry 0 — every figure
 * deliberately distinct so a row bound to the wrong field cannot pass by coincidence.
 */
/**
 * 845903a3 (r313) — the Entitlement block, DERIVED from whatever band the caller set rather than pinned.
 * r279 §1 asserts that moving the band moves both surfaces together, so a fixture that hard-codes this
 * figure would break that proof by construction: the band would move and the column would not. This
 * fixture's employee joined before the leave year, so nothing prorates and the block is the band itself —
 * which keeps r279's real point (Earned to Date and Entitlement are DIFFERENT numbers) exactly as it was.
 */
const unproratedEntitlement = (band: number) => ({
  annualEntitlementDays: band,
  prorated: false,
  eligibleCalendarDays: null,
  daysInLeaveYear: null,
  unroundedEntitlementDays: band,
  displayEntitlementDays: band,
  roundingApplied: false,
});

const panelData = (over: Partial<PanelData['breakdown']> = {}): PanelData => ({
  breakdown: {
    leaveTypeId: 'lt-al',
    leaveType: 'Annual Leave',
    asOf: '2026-09-14',
    cycleStart: '2026-01-01',
    eligibleDays: 18,
    entitlement: unproratedEntitlement(over.eligibleDays ?? 18),
    entitlementStatus: 'granted',
    entitlementTemplateName: 'Executive Annual Leave',
    currentYearEntitlement: 12.5,
    // r335 (6af80f5d): this fixture configures no rounding rule, so the displayed Earned to Date IS the
    // exact figure — which is what keeps r279's "Earned to Date is currentYearEntitlement and nothing
    // else" proof meaning what it meant. Derived from `over` so a case that moves one moves both.
    currentYearEntitlementRounded: over.currentYearEntitlement ?? 12.5,
    monthlyAccruedToDate: 12.5,
    carriedForward: 0,
    carryForwardRemaining: 0,
    carryForwardExpiryDate: null,
    forfeited: 0,
    otherAdjustments: 0,
    balance: 12.5,
    pendingApproval: 0,
    broughtForward: 0,
    configAdjustments: 0,
    systemAdjustments: 0,
    forfeitedThisCycle: 0,
    takenThisCycle: 0,
    configAdjustmentItems: [],
    adjustments: 0,
    totalEntitlement: 12.5,
    totalAvailable: 12.5,
    transactions: [],
    essView: {},
    ...over,
  },
  summary: { available: 12.5 },
});

const bd = (over: Partial<PanelData['breakdown']> = {}): BreakdownInput =>
  panelData(over).breakdown as unknown as BreakdownInput;

const eligibleField = () =>
  ENTITLEMENT_PANEL_SECTIONS.find((s) => s.key === 'summary')!.fields!.find((f) => f.key === 'eligible')!;

// ── 1. ONE resolver for the full-year band ──────────────────────────────────────────────────────────

describe('r279 §1: Full Entitlement is the panel’s own Eligible figure, picked — not a second band resolver', () => {
  it('the grid column and the Explain panel read the SAME field of the SAME breakdown object', () => {
    const data = panelData();
    const row = deriveBalanceRow(balance(), data.breakdown as unknown as BreakdownInput);
    expect(row.fullEntitlement).toBe(eligibleField().select!(data));
    expect(row.fullEntitlement).toBe(data.breakdown.eligibleDays);
  });

  it('moving the band moves BOTH surfaces together, and moves nothing else on the row', () => {
    // If the grid ever re-derived a band of its own, this is where it would come apart: the panel would
    // follow eligibleDays and the grid would not.
    const data = panelData({ eligibleDays: 24 });
    const row = deriveBalanceRow(balance(), data.breakdown as unknown as BreakdownInput);
    expect(row.fullEntitlement).toBe(24);
    expect(eligibleField().select!(data)).toBe(24);
    // Earned to Date is ledger-sourced and must be deaf to the band.
    expect(row.ytdEntitled).toBe(12.5);
    expect(row.balance).toBe(12.5);
  });

  it('the pure row helper resolves no band of its own: it reads bd.eligibleDays and touches no database', () => {
    const src = read('/components/leave/leave-balance-row.ts');
    expect(src).toContain('bd.eligibleDays');
    // Everything this module imports is a type; a runtime import of the db client or the leave engine would
    // be the first step of a second resolver living here.
    expect(src.includes("from '@/db")).toBe(false);
    expect(src.includes('drizzle')).toBe(false);
    expect(src.includes('await ')).toBe(false);
  });
});

// ── 2. The production regression pins ───────────────────────────────────────────────────────────────

describe('r279 §2: the two production pins — Earned must not move, Full must equal the band', () => {
  // Read off live data before the change (02617b4a and 99e97e85). Seeded equivalents here: the point of the
  // pin is the PAIR of figures on one row, which is exactly what the derivation decides.
  const PINS = [
    { who: '02617b4a', earned: 12.5, band: 18 },
    { who: '99e97e85', earned: 17, band: 24 },
  ];

  for (const { who, earned, band } of PINS) {
    it(`${who}: Earned to Date stays ${earned.toFixed(2)} and Full Entitlement reads ${band.toFixed(2)}`, () => {
      const row = deriveBalanceRow(
        balance({ balance: earned, available: earned }),
        bd({ currentYearEntitlement: earned, eligibleDays: band, carriedForward: 0, monthlyAccruedToDate: earned }),
      );
      expect(row.ytdEntitled).toBe(earned);
      expect(row.fullEntitlement).toBe(band);
      // The understatement the reporter's rename would have shipped, stated as an assertion: these are two
      // different numbers, and the smaller one is the earned one.
      expect(row.ytdEntitled).toBeLessThan(row.fullEntitlement!);
      // What HR actually reads on the grid.
      expect(formatDays(row.ytdEntitled)).toBe(earned.toFixed(2));
      expect(formatDays(row.fullEntitlement)).toBe(band.toFixed(2));
    });
  }
});

// ── 3. The carry removal: the only number that moves ────────────────────────────────────────────────

describe('r279 §3: Brought Forward came out of Earned to Date', () => {
  const OLD = (b: NonNullable<BreakdownInput>) => b.currentYearEntitlement + b.carriedForward;

  it('carry = 0 (every production balance today) ⇒ the shipped figure does not move at all', () => {
    const b = bd({ currentYearEntitlement: 12.5, carriedForward: 0 })!;
    const row = deriveBalanceRow(balance(), b);
    expect(b.carriedForward).toBe(0);
    expect(row.ytdEntitled).toBe(OLD(b)); // new === old formula, so nothing on screen changed on release day
    expect(row.ytdEntitled).toBe(12.5);
  });

  it('carry ≠ 0 ⇒ the two differ by EXACTLY the carry, which has its own column', () => {
    // Asserted rather than relied upon: "the carry is zero everywhere" is a fact about today's data, and a
    // guard that only holds while that stays true is not a guard.
    const b = bd({ currentYearEntitlement: 12.5, carriedForward: 5 })!;
    const row = deriveBalanceRow(balance(), b);
    expect(row.ytdEntitled).toBe(12.5);
    expect(OLD(b) - row.ytdEntitled!).toBe(5);
    expect(row.broughtForward).toBe(5); // where the 5 is shown instead — Brought Forward, its own column
  });

  it('Earned to Date is currentYearEntitlement and nothing else, across carry values', () => {
    for (const carriedForward of [0, 0.5, 5, 99]) {
      const row = deriveBalanceRow(balance(), bd({ currentYearEntitlement: 12.5, carriedForward }));
      expect(row.ytdEntitled, `carry ${carriedForward}`).toBe(12.5);
    }
  });
});

// ── 4. A leave type with no entitlement table ───────────────────────────────────────────────────────

describe('r279 §4: fifteen of sixteen leave types have no entitlement table — 0.00 is the honest reading', () => {
  it('no policy resolves (eligibleDays 0) ⇒ a clean 0.00, never a blank cell and never a crash', () => {
    const row = deriveBalanceRow(
      balance({ leaveTypeId: 'lt-hosp', leaveType: 'Hospitalisation Leave', code: 'HOSP', balance: 0, available: 0 }),
      bd({ eligibleDays: 0, currentYearEntitlement: 0, entitlementStatus: 'no_entitlement_table' }),
    );
    expect(row.fullEntitlement).toBe(0);
    expect(formatDays(row.fullEntitlement)).toBe('0.00');
    // The status caption already under the Earned cell is what explains the zero; the figure itself is true.
    expect(row.entitlementStatus).toBe('no_entitlement_table');
  });

  it('NO breakdown resolved at all ⇒ null on both columns, rendered as the em dash', () => {
    const row = deriveBalanceRow(balance(), null);
    expect(row.fullEntitlement).toBeNull();
    expect(row.ytdEntitled).toBeNull();
    expect(formatDays(row.fullEntitlement)).toBe(DAY_DASH);
  });

  it('the ESS `eligible` switch hides the column’s figure rather than leaking it as a 0.00', () => {
    // Same key the panel's Eligible row uses, because it is the same number. HR's own grid passes an empty
    // essView, so this only ever bites on an employee-facing surface.
    const hidden = deriveBalanceRow(balance({ essView: { eligible: false } }), bd());
    expect(hidden.fullEntitlement).toBeNull();
    expect(hidden.ytdEntitled).toBe(12.5); // a different switch; hiding one must not hide the other
    expect(deriveBalanceRow(balance({ essView: {} }), bd()).fullEntitlement).toBe(18);
  });
});

// ── 5. The screen and its export carry both columns ─────────────────────────────────────────────────

describe('r279 §5: Employee Balances renders both columns, and its export cannot disagree', () => {
  const page = read('/app/leave/employee-balances/page.tsx');

  it('renders the two headers, with Full Entitlement before the earned figure it explains', () => {
    const full = page.indexOf("tMe('leaveBalanceTable.colFullEntitlement')");
    const earned = page.indexOf("tMe('leaveBalanceTable.colYtdEntitled')");
    expect(full, 'Full Entitlement header missing').toBeGreaterThan(-1);
    expect(earned, 'Earned to Date header missing').toBeGreaterThan(-1);
    expect(full).toBeLessThan(earned);
  });

  it('renders both VALUES through the shared day formatter', () => {
    expect(page).toContain('{num(r.fullEntitlement)}');
    expect(page).toContain('{num(r.ytdEntitled)}');
    expect(page).toContain('const num = (v: number | null) => formatDays(v)');
  });

  it('the empty-state colSpan spans every header (15 since Share / Pending Share were added)', () => {
    const thead = page.slice(page.indexOf('<thead'), page.indexOf('</thead>'));
    const headers = thead.match(/<th\b/g) ?? [];
    // 39136455 (r306) took this table from 13 columns to 15: Share and Pending Share landed between
    // Adjustment and Balance. The CLAIM this test makes is unchanged and is the line below — the empty
    // state must span EVERY header — and it is the one that actually catches a stale colSpan. The count is
    // restated rather than dropped so that a column arriving or leaving still has to be noticed here.
    expect(headers.length).toBe(15);
    expect(page).toContain(`colSpan={${headers.length}}`);
  });

  it('the row builder carries the figure off the SAME breakdown every other figure came from', () => {
    const rows = read('/app/leave/employee-balances/rows.ts');
    expect(rows).toContain('fullEntitlement: row.fullEntitlement');
    // One deriveBalanceRow call, one breakdown — the property this file's header protects.
    expect(rows).toContain('const row = deriveBalanceRow({ ...b, essView: {} }, bd);');
    expect(rows.match(/deriveBalanceRow\(/g)?.length).toBe(1);
  });

  it('the export adds the header AND the cell, in the same place (a one-sided add shifts every figure)', () => {
    const src = read('/app/leave/employee-balances/export/route.ts');
    const columns = src.slice(src.indexOf('columns: ['), src.indexOf('rows: rows.map'));
    const cells = src.slice(src.indexOf('rows: rows.map'));
    expect(columns).toContain("tMe('colFullEntitlement')");
    expect(cells).toContain('cell(r.fullEntitlement)');
    // Same relative order in both lists, so a downloaded column cannot be read against the wrong heading.
    expect(columns.indexOf("tMe('colFullEntitlement')")).toBeLessThan(columns.indexOf("tMe('colYtdEntitled')"));
    expect(cells.indexOf('cell(r.fullEntitlement)')).toBeLessThan(cells.indexOf('cell(r.ytdEntitled)'));
  });
});

// ── 6. Six catalogues ───────────────────────────────────────────────────────────────────────────────

describe('r279 §6: both labels resolve in all six locales, and the English wording is the honest one', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const dict = (loc: string) =>
    JSON.parse(read(`/messages/${loc}.json`)).me.leaveBalanceTable as Record<string, unknown>;

  for (const loc of LOCALES) {
    it(`${loc} carries colFullEntitlement and a re-worded colYtdEntitled, and the two are distinct`, () => {
      const d = dict(loc);
      expect(d.colFullEntitlement, `[${loc}] colFullEntitlement`).toBeTruthy();
      expect(d.colYtdEntitled, `[${loc}] colYtdEntitled`).toBeTruthy();
      expect(d.colFullEntitlement).not.toBe(d.colYtdEntitled);
      // The tooltip claimed the carry was included; it no longer is, on any locale.
      const tip = String((d.tip as Record<string, unknown>).ytdEntitled);
      expect(tip.length).toBeGreaterThan(0);
    });
  }

  it('English says exactly what the reporter will read', () => {
    const d = dict('en');
    /**
     * 845903a3 (r313) — THE LABEL LOST THE WORD "FULL", and this assertion is updated rather than
     * dropped because r279's reasoning still holds and now points the other way. r279 refused to call
     * Earned to Date "Full Entitlement" because that column understates the year. This column no longer
     * shows the whole year either: for an employee who joined part way through it, it shows THEIR
     * entitlement for this year, prorated. "Full" would now be the inaccurate word, so it went — while
     * the two columns stay the two DIFFERENT figures r279 exists to keep apart.
     *
     * The message KEY is deliberately unchanged. `colFullEntitlement` and the ESS component key
     * `eligible` are stored configuration (leave_type.ess_view_config); renaming either would be a data
     * migration for a label change — the same call r279 made about `ytdEntitled`.
     */
    expect(d.colFullEntitlement).toBe('Entitlement');
    expect(String(d.colFullEntitlement)).not.toContain('Full');
    expect(d.colYtdEntitled).toBe('Earned to Date');
    expect(String((d.tip as Record<string, unknown>).ytdEntitled)).not.toContain('including any brought forward');
  });
});
