/**
 * r303 (31492f74) — THE LEAVE SUMMARY SENTENCES, RENDERED: HR sees them, the employee sees exactly what they saw.
 *
 * WHY A DOM TEST. The panel is a Radix Dialog behind a click; nothing of it is in the HTML a curl receives, and
 * the RSC payload carries the whole catalogue, so a dev-server render cannot say whether a sentence resolves
 * (CLAUDE.md §8). This mounts the real components under the SHIPPING catalogues in all six locales, with
 * next-intl's `onError` collected and asserted empty, and clicks.
 *
 *   1. EMPLOYEE, BYTE FOR BYTE. My Leave's side-sheet (opened, and with an HR-authored explanation opened) and the
 *      uncontrolled employee mount are compared with markup captured by the same helper on the r303 base, before
 *      LeaveDetailsPanel changed (test/fixtures/r303-employee-leave-panel.json). Any change to what an employee
 *      sees — a stray wrapper, a lost icon, a new sentence — fails here.
 *   2. HR. The Employee Balances / Personnel mount (`hrExplanation`) shows a sentence under every one of the nine
 *      lines, no info icon anywhere, and HR's own explanation as a plain paragraph — six locales, no errors.
 *   3. EVERY MESSAGE FORMATS, every select branch is reachable, and every locale carries en's placeholders.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import { EntitlementBreakdown, type EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';
import {
  LEAVE_SUMMARY_EXPLAIN_KEYS,
  LEAVE_SUMMARY_LINE_KEYS,
  explainLeaveSummary,
  type LeaveSummaryDerivation,
} from '../lib/leave-summary-explain';
import {
  EMPLOYEE_PANEL_CATALOGUES,
  renderEmployeeDashboardPanel,
  renderEmployeeTriggerPanel,
  type EmployeePanelLocale,
} from './helpers/r303-employee-leave-panel';

const LOCALES = Object.keys(EMPLOYEE_PANEL_CATALOGUES) as EmployeePanelLocale[];
type Msgs = (typeof EMPLOYEE_PANEL_CATALOGUES)['en'];

// ── 1. The employee side is unchanged ─────────────────────────────────────────────────────────────────

describe('r303: the employee Leave Summary renders byte-for-byte what it rendered on the base', () => {
  const baseline = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/r303-employee-leave-panel.json'), 'utf8')) as Record<
    string,
    { opened: string; tooltip: string; trigger: string }
  >;

  /**
   * ⚠️ 845903a3 (r313) — THE BASELINE WAS REGENERATED, AND HERE IS THE PROOF IT WAS SAFE TO.
   *
   * A byte-for-byte fixture is worthless if it is refreshed whenever it goes red, so it was regenerated
   * and then DIFFED against the old one before being committed. Every difference, in all six locales and
   * all three rendered surfaces, was the removal of the qualifier in the Entitlement label and nothing
   * else: "Full " / " Penuh" / "முழு " / "เต็มปี" / " cả năm" / "全年". No figure, attribute or element
   * changed. Eighteen sections differed; eighteen were that word.
   *
   * If this file goes red again, diff before regenerating. The employee panel not moving is the whole
   * point of it, and r303's sentences must still not leak into the employee's view.
   */
  it('the baseline really is the employee panel (guard the guard)', () => {
    expect(Object.keys(baseline).sort()).toEqual([...LOCALES].sort());
    const en = baseline.en;
    expect(en.opened).toContain('Entitlement');
    expect(en.opened, 'the qualifier went with r313').not.toContain('Full Entitlement');
    expect(en.opened).toContain('aria-label="Show explanation"'); // HR-authored explanation icon
    expect(en.opened).toContain('title="Leave you'); // a static summary tooltip icon
    expect(en.tooltip).toContain('role="tooltip"');
    expect(en.trigger).toContain('name="asOf"');
    // …and none of r303's HR sentences.
    for (const html of [en.opened, en.tooltip, en.trigger]) expect(html).not.toContain('leave-explain-');
  });

  for (const loc of LOCALES) {
    it(`${loc}: My Leave Details (opened, and with HR's explanation opened) is identical to the base`, async () => {
      const now = await renderEmployeeDashboardPanel(loc);
      expect(now.opened).toBe(baseline[loc].opened);
      expect(now.tooltip).toBe(baseline[loc].tooltip);
    });
    it(`${loc}: the uncontrolled employee mount is identical to the base`, async () => {
      expect(await renderEmployeeTriggerPanel(loc)).toBe(baseline[loc].trigger);
    });
  }
});

// ── 2. HR sees the sentences ──────────────────────────────────────────────────────────────────────────

/** A breakdown whose derivation and figures agree, exercising every line with records in it. */
const DERIVATION: LeaveSummaryDerivation = {
  entitlement: {
    tableName: 'Annual — all staff',
    via: 'scheme',
    schemeName: 'All staff',
    winReason: 'later_start',
    hiredOn: '2023-05-02',
    serviceYears: 2,
    band: { fromYears: 2, toYears: 5 },
    days: 14,
  },
  earned: {
    method: 'earned_monthly',
    leaveYear: 'calendar',
    leaveYearOverride: null,
    cycleEnd: '2026-12-31',
    rounding: 'custom',
    joinYear: null,
    credits: [
      { effectiveOn: '2026-03-31', days: 3.5, kind: 'grant' },
      { effectiveOn: '2026-06-30', days: 3.5, kind: 'grant' },
      { effectiveOn: '2026-09-30', days: 3.5, kind: 'grant' },
    ],
  },
  carry: { rule: 'on', maxDays: 5, percent: null },
  adjustments: {
    manual: [{ effectiveOn: '2026-02-01', days: 2, reason: 'CNY 2026' }],
    system: [{ effectiveOn: '2026-05-01', days: -1, kind: 'profile_recalc' }],
  },
  taken: { leaveDays: 3.5, other: [{ effectiveOn: '2026-10-01', days: 0.5, kind: 'credit_expired', reason: null }] },
  pending: [{ startDate: '2026-12-01', endDate: '2026-12-02', days: 2 }],
  forfeited: [{ effectiveOn: '2026-03-31', days: 1, kind: 'carry_expiry' }],
};

const HR_DATA: EntitlementBreakdownData = {
  leaveTypeId: 'lt-annual',
  leaveType: 'Annual Leave',
  asOf: '2026-12-31',
  cycleStart: '2026-01-01',
  eligibleDays: 14,
  // 845903a3 (r313) — joined before the leave year, so nothing prorates and the Entitlement line
  // shows the band figure, exactly as it did before.
  entitlement: { annualEntitlementDays: 14, prorated: false, eligibleCalendarDays: null,
    daysInLeaveYear: null, unroundedEntitlementDays: 14, displayEntitlementDays: 14, roundingApplied: false },
  entitlementStatus: 'granted',
  entitlementTemplateName: 'Annual — all staff',
  currentYearEntitlement: 10.5,
  monthlyAccruedToDate: 10.5,
  carriedForward: 3,
  carryForwardRemaining: 0,
  carryForwardExpiryDate: '2026-03-31',
  forfeited: 1,
  otherAdjustments: 2,
  balance: 9.5,
  pendingApproval: 2,
  broughtForward: 3,
  configAdjustments: 2,
  systemAdjustments: -1,
  forfeitedThisCycle: 1,
  takenThisCycle: 4,
  configAdjustmentItems: [{ effectiveOn: '2026-02-01', days: 2, reason: 'CNY 2026' }],
  adjustments: 1,
  totalEntitlement: 14.5,
  totalAvailable: 7.5,
  transactions: [],
  // ESS hides two lines for EMPLOYEES; HR must still see all nine.
  essView: { adjustment: false, forfeited: false },
  formulaExplanations: { taken: { description: 'Approved leave already used.', formula: 'Sum of approved days' } },
  derivation: DERIVATION,
};

async function openHrPanel(loc: EmployeePanelLocale, data: EntitlementBreakdownData = HR_DATA, available = 7.5) {
  const errors: string[] = [];
  render(
    <NextIntlClientProvider
      locale={loc}
      messages={EMPLOYEE_PANEL_CATALOGUES[loc]}
      onError={(e) => errors.push(`${(e as { code?: string }).code ?? ''} ${String((e as Error).message ?? e)}`)}
    >
      <EntitlementBreakdown
        data={data}
        summary={{ available }}
        visual={{ color: null, icon: null, code: 'ANNUAL' }}
        asOf="2026-12-31"
        action="/leave/employee-balances"
        triggerLabel="Explain"
        hrExplanation={{ sharedBalance: null }}
      />
    </NextIntlClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Explain' }));
  const dialog = await screen.findByRole('dialog');
  return { dialog, panel: within(dialog), errors };
}

describe('r303: the HR mount shows a sentence under every line, and no icon', () => {
  for (const loc of LOCALES) {
    it(`${loc}: nine explained lines, no info icon, HR's own explanation as a paragraph, no i18n errors`, async () => {
      const dict = EMPLOYEE_PANEL_CATALOGUES[loc] as unknown as Msgs;
      const { dialog, panel, errors } = await openHrPanel(loc);
      for (const key of LEAVE_SUMMARY_LINE_KEYS) {
        const block = panel.getByTestId(`leave-explain-${key}`);
        expect(block.textContent?.trim().length, `[${loc}] ${key} has a sentence`).toBeGreaterThan(0);
      }
      // No icon of either kind: no static tooltip span, no HR-explanation toggle.
      expect(dialog.querySelectorAll('span[title]').length, `[${loc}] static tooltip icons`).toBe(0);
      expect(panel.queryAllByRole('button', { name: dict.leave.breakdown.explanationShow })).toEqual([]);
      expect(panel.queryByRole('tooltip')).toBeNull();
      // HR's own explanation, as a plain paragraph under Taken's generated sentences.
      const hr = panel.getByTestId('leave-explain-hr-taken');
      expect(hr.textContent).toContain('Approved leave already used.');
      expect(hr.textContent).toContain('Sum of approved days');
      expect(panel.getByTestId('leave-explain-taken').contains(hr)).toBe(true);
      expect(panel.queryByText(/MISSING_MESSAGE|FORMATTING_ERROR/)).toBeNull();
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }

  it('English: the sentences carry this employee’s real figures and records, line by line', async () => {
    const { panel } = await openHrPanel('en');
    const text = (key: string) => panel.getByTestId(`leave-explain-${key}`).textContent ?? '';
    expect(text('eligible')).toContain('Entitlement table: Annual — all staff. It applies because the benefit scheme All staff matches this employee.');
    expect(text('eligible')).toContain('this one won because it starts later');
    expect(text('eligible')).toContain('Joined 2023-05-02: 2 completed years of service at the start of the leave year on 2026-01-01.');
    expect(text('eligible')).toContain("The table's band for 2 years and under 5 years of service gives 14.00 days.");
    expect(text('ytdEntitled')).toContain('Earning method: earned monthly.');
    expect(text('ytdEntitled')).toContain('Leave year: 2026-01-01 to 2026-12-31 (calendar year).');
    expect(text('ytdEntitled')).toContain("Rounding: this leave type's own rounding table.");
    expect(text('ytdEntitled')).toContain('2026-06-30: +3.50 — entitlement credited');
    expect(text('ytdEntitled')).toContain('Together: 10.50.');
    expect(text('broughtForward')).toContain('3.00 days were left unused before this leave year started on 2026-01-01.');
    expect(text('broughtForward')).toContain('up to 5.00 days carry into the next leave year');
    expect(text('adjustment')).toContain('2026-02-01: +2.00 — CNY 2026');
    expect(text('adjustment')).toContain("2026-05-01: -1.00 — after the employee's record changed");
    expect(text('adjustment')).toContain('Together: 1.00.');
    expect(text('total')).toBe('3.00 brought forward + 10.50 earned to date + 1.00 adjustments = 14.50.');
    expect(text('taken')).toContain('Approved leave taken from 2026-01-01 to 2026-12-31: 3.50.');
    expect(text('taken')).toContain('2026-10-01: 0.50 — an expired Leave Credit');
    expect(text('pendingApproval')).toContain('2026-12-01 to 2026-12-02: 2.00');
    expect(text('forfeited')).toContain('2026-03-31: 1.00 — carried days expired');
    expect(text('available')).toBe('14.50 total − 4.00 taken − 2.00 pending − 1.00 forfeited = 7.50.');
    // Each list is a list, under the sentence that introduces it.
    expect(within(panel.getByTestId('leave-explain-ytdEntitled')).getAllByRole('listitem')).toHaveLength(3);
  });

  it('English: a shared pool names the pool, and Available says why it is not the column’s total', async () => {
    const errors: string[] = [];
    render(
      <NextIntlClientProvider locale="en" messages={EMPLOYEE_PANEL_CATALOGUES.en} onError={(e) => errors.push(String(e))}>
        <EntitlementBreakdown
          data={HR_DATA}
          summary={{ available: 5.5 }}
          visual={{ color: null, icon: null, code: 'ANNUAL' }}
          asOf="2026-12-31"
          action="/leave/employee-balances"
          triggerLabel="Explain"
          hrExplanation={{
            sharedBalance: {
              sourceLeaveTypeId: 'lt-annual',
              sourceLeaveTypeName: 'Annual Leave',
              contributingLeaveTypes: ['Annual Leave', 'Emergency Leave'],
            },
          }}
        />
      </NextIntlClientProvider>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Explain' }));
    const panel = within(await screen.findByRole('dialog'));
    const text = (key: string) => panel.getByTestId(`leave-explain-${key}`).textContent ?? '';
    expect(text('eligible')).toContain('These are the Annual Leave figures. The same balance is also used by Emergency Leave.');
    expect(text('taken')).toContain('Includes leave taken on every leave type that shares this balance: Annual Leave and Emergency Leave.');
    expect(text('pendingApproval')).toContain('Counts Annual Leave applications only.');
    expect(text('available')).toBe(
      '5.50 is the Annual Leave balance of 9.50 less applications waiting on every leave type that shares it (Annual Leave and Emergency Leave). Pending Approval above counts Annual Leave applications only, so the lines above come to 7.50.',
    );
    expect(errors).toEqual([]);
  });

  it('English: a breakdown read without its working says so on every line rather than guessing', async () => {
    const { derivation: _d, ...withoutDerivation } = HR_DATA;
    const { panel, errors } = await openHrPanel('en', withoutDerivation as EntitlementBreakdownData);
    for (const key of LEAVE_SUMMARY_LINE_KEYS) {
      // The first paragraph under every line; Taken also keeps HR's own explanation beneath it.
      expect(panel.getByTestId(`leave-explain-${key}`).querySelector('p')!.textContent).toBe('No working was loaded for this figure.');
    }
    expect(errors).toEqual([]);
  });

  it('English: a list that does not reach its figure is not printed', async () => {
    const broken: EntitlementBreakdownData = {
      ...HR_DATA,
      derivation: { ...DERIVATION, earned: { ...DERIVATION.earned, credits: DERIVATION.earned.credits.slice(1) } },
    };
    const { panel } = await openHrPanel('en', broken);
    expect(panel.getByTestId('leave-explain-ytdEntitled').textContent).toContain(
      'The records behind 10.50 could not be listed so that they add up to it, so they are not shown here.',
    );
    expect(panel.getByTestId('leave-explain-ytdEntitled').textContent).not.toContain('2026-06-30');
  });

  it('pure: a default table is named as the default, and Available differing with no pool is stated, not hidden', () => {
    const data = { ...HR_DATA, derivation: { ...DERIVATION, entitlement: { ...DERIVATION.entitlement, via: 'default_table' as const, schemeName: null, winReason: null } } };
    const lines = explainLeaveSummary(data, { available: 6 });
    expect(lines.eligible.map((s) => s.key)).toEqual(['eligibleViaDefault', 'eligibleService', 'eligibleBand', 'eligibleFullYear']);
    expect(lines.available).toEqual([{ key: 'availableDiffers', args: { available: { days: 6 }, column: { days: 7.5 } } }]);
  });
});

// ── 3. Every message formats in every locale, and every branch is reachable ──────────────────────────

const CHOICES: Record<string, Record<string, string[]>> = {
  eligibleWin: { reason: ['more_specific', 'later_start', 'later_created', 'arbitrary'] },
  earnedMethod: { method: ['up_front', 'earned_monthly', 'earned_quarterly', 'earned_daily'] },
  earnedLeaveYear: { kind: ['calendar', 'anniversary', 'a2c'] },
  earnedRounding: { method: ['none', 'up', 'down', 'nearest_half', 'custom', 'custom_no_table'] },
  creditItem: { kind: ['grant', 'leave_credit', 'a2c_correction'] },
  adjSystemItem: { kind: ['policy_recalc', 'profile_recalc', 'a2c_recalc'] },
  takenOtherItem: { kind: ['credit_expired', 'credit_paid_out', 'credit_reversed'] },
  forfeitItem: { kind: ['carry_cap', 'carry_expiry', 'type_expiry'] },
};

/** A value for every argument any explain message names (ICU ignores the ones a message does not use). */
const ARGS = {
  figure: '10.50', total: '10.50', source: 'Annual Leave', others: 'Emergency Leave', table: 'Table', scheme: 'Scheme',
  reason: 'CNY 2026', hiredOn: '2023-05-02', cycleStart: '2026-01-01', years: 2, from: 2, to: 5, days: '14.00',
  method: 'none', start: '2026-01-01', end: '2026-12-31', kind: 'grant', date: '2026-03-31', max: '5.00', percent: 50,
  bf: '3.00', earned: '10.50', adj: '1.00', asOf: '2026-12-31', types: 'Annual Leave and Emergency Leave',
  type: 'Annual Leave', available: '7.50', taken: '4.00', pending: '2.00', forfeited: '1.00', balance: '9.50', column: '7.50',
  // 845903a3 (r313) — the Entitlement proration working. Registered HERE rather than at the emit site
  // because this map is what proves a new sentence cannot ship as a FORMATTING_ERROR: a placeholder with
  // no value listed makes the message throw at render, which tsc, the suite and `next build` are all
  // green over (CLAUDE.md section 8). That is exactly what this guard caught when the keys first landed.
  annual: '16.00', eligibleDays: 292, yearDays: 365, unrounded: '12.80', final: '12.00',
};

const placeholders = (msg: string) => new Set([...msg.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1]));

describe('r303: every explain message exists, formats, and reaches every branch in all six locales', () => {
  for (const loc of LOCALES) {
    it(`${loc}: all ${LEAVE_SUMMARY_EXPLAIN_KEYS.length} keys format; select branches are distinct; placeholders match en`, () => {
      const messages = EMPLOYEE_PANEL_CATALOGUES[loc] as unknown as Msgs;
      const t = createTranslator({
        locale: loc,
        messages: messages as never,
        namespace: 'leave.breakdown.explain' as never,
        onError: (e) => {
          throw e;
        },
      }) as unknown as (key: string, values?: Record<string, string | number>) => string;
      const catalogue = messages.leave.breakdown.explain as Record<string, string>;
      const en = EMPLOYEE_PANEL_CATALOGUES.en.leave.breakdown.explain as Record<string, string>;
      expect(Object.keys(catalogue).sort(), `[${loc}] key set`).toEqual([...LEAVE_SUMMARY_EXPLAIN_KEYS].sort());
      for (const key of LEAVE_SUMMARY_EXPLAIN_KEYS) {
        expect(placeholders(catalogue[key]), `[${loc}] ${key} placeholders`).toEqual(placeholders(en[key]));
        const out = t(key, ARGS);
        expect(out.length, `[${loc}] ${key}`).toBeGreaterThan(0);
        expect(out).not.toMatch(/leave\.breakdown\.explain/);
      }
      for (const [key, byArg] of Object.entries(CHOICES)) {
        for (const [arg, values] of Object.entries(byArg)) {
          const outs = values.map((v) => t(key, { ...ARGS, [arg]: v }));
          // A mistyped branch keyword falls through to `other`, and would then print the same text as a real
          // `other` value — so every value the renderer can emit must print something different.
          expect(new Set(outs).size, `[${loc}] ${key}.${arg}: ${outs.join(' | ')}`).toBe(values.length);
        }
      }
    });
  }
});
