/**
 * r303 (05db6aa7) "Custom Rounding Table Configuration" — THE EDITOR, RENDERED, UNDER ALL SIX CATALOGUES.
 *
 * The reporter approved a table they can fill in the way they think about it:
 *   §A the columns are From / To / Round To, in every catalogue, and a saved table shows exactly what was
 *      saved — From included (it used to be derived from the row above and read-only);
 *   §B From and To can both be typed on every row, and the reporter's own table posts exactly as typed with
 *      no problem and no gap;
 *   §C every rule gets its OWN message (blank, decimals, range, order, overlap, duplicate) and a gap is a
 *      warning naming the uncovered decimals, both ends included;
 *   §D a third decimal is REFUSED, never tidied: "0.245" stays "0.245" on blur, "0.5" still widens to "0.50";
 *   §E the worked example beside the table reads the table in its new meaning.
 *
 * Why rendered rather than grepped: every one of these is live `useState` inside a client island, and a
 * missing key paints MISSING_MESSAGE only in the browser. The real component, the SHIPPING catalogues, and
 * an `onError` that records every next-intl error so a missing or broken message fails the test.
 *
 * NOTHING ABOUT THE SERVICE IS ASSERTED HERE — test/leave-rounding-bands.test.ts §2 and
 * test/leave-rounding-bands-0473.test.ts §3 refuse and accept against a real database.
 */
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider, useTranslations } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import {
  EarningMethodForm,
  type EarnedSweepFacts,
  type LeaveTypeRules,
} from '../app/admin/leave-config/types/leave-type-sub-forms';

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

type Sub = typeof en.admin.leave.subStep;

const SWEEP: EarnedSweepFacts = {
  leaveTypeName: 'Annual Leave',
  annualSwitch: 'on',
  otherAnnualLeaveTypeNames: [],
  earnedMethods: ['earned_monthly', 'earned_quarterly', 'earned_daily'],
};

/** Production's table as migration 0473 writes it. */
const CONVERTED: LeaveTypeRules['roundingBands'] = [
  { from: 0, to: 0.39, result: 0 },
  { from: 0.4, to: 0.69, result: 0.5 },
  { from: 0.7, to: 0.99, result: 1 },
];

const custom = (roundingBands: LeaveTypeRules['roundingBands']): LeaveTypeRules => ({
  accrualMethod: 'grant_on_hire_prorated',
  roundingMethod: 'custom',
  roundingBands,
});

function Mount({ rules }: { rules: LeaveTypeRules }) {
  const t = useTranslations('admin.leave');
  return <EarningMethodForm t={t} rules={rules} action={() => {}} leaveTypeId="lt-1" sweep={SWEEP} />;
}

let intlErrors: string[] = [];
const wrap = (locale: string, messages: Record<string, unknown>, ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages} onError={(e) => intlErrors.push(`${e.code}: ${e.message}`)}>
      {ui}
    </NextIntlClientProvider>,
  );

const mount = (rules: LeaveTypeRules, locale = 'en', messages: Record<string, unknown> = en) => {
  intlErrors = [];
  return wrap(locale, messages, <Mount rules={rules} />);
};

const subOf = (messages: Record<string, unknown>) => (messages as typeof en).admin.leave.subStep as Sub;
const cells = (label: string) => screen.getAllByRole('spinbutton', { name: label }) as HTMLInputElement[];
const posted = (container: HTMLElement) =>
  JSON.parse((container.querySelector('input[name="roundingBands"]') as HTMLInputElement).value) as unknown;
const text = (container: HTMLElement) => container.textContent ?? '';

describe('§A the columns are From / To / Round To, and a saved table shows exactly what was saved', () => {
  it.each(LOCALES)('%s', (locale, messages) => {
    const S = subOf(messages);
    const view = mount(custom(CONVERTED), locale, messages);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 3)).toEqual([S.roundingBandFrom, S.roundingBandTo, S.roundingBandResult]);
    // Every row's From is the From it was saved with — not the row above's To, not 0.00 by default.
    expect(cells(S.roundingBandFrom).map((c) => c.value)).toEqual(['0.00', '0.40', '0.70']);
    expect(cells(S.roundingBandTo).map((c) => c.value)).toEqual(['0.39', '0.69', '0.99']);
    expect(cells(S.roundingBandResult).map((c) => c.value)).toEqual(['0.00', '0.50', '1.00']);
    for (const c of [...cells(S.roundingBandFrom), ...cells(S.roundingBandTo), ...cells(S.roundingBandResult)]) {
      expect(c.readOnly).toBe(false);
      expect(c).toBeEnabled();
      expect(c).toHaveAttribute('step', '0.01');
    }
    // A converted table is complete: no refusal, no gap.
    for (const key of ['roundingBandBlank', 'roundingBandDecimals', 'roundingBandRange', 'roundingBandOrder', 'roundingBandOverlap', 'roundingBandDuplicate'] as const) {
      expect(text(view.container), `${locale} ${key}`).not.toContain(S[key]);
    }
    expect(text(view.container)).toContain(S.roundingBandsHelp);
    expect(posted(view.container)).toEqual(CONVERTED);
    expect(intlErrors).toEqual([]);
  });

  it('the retired key is gone from the screen: no "Rounded Result", no derived-From explanation', () => {
    const view = mount(custom(CONVERTED));
    expect(text(view.container)).not.toContain('Rounded Result');
    expect(text(view.container)).not.toContain('filled in for you');
    expect(en.admin.leave.subStep.roundingBandTo).toBe('To');
    expect(en.admin.leave.subStep.roundingBandResult).toBe('Round To');
  });
});

describe("§B From and To are typed on every row, and the reporter's table posts exactly as typed", () => {
  const REPORTER = [
    ['0.00', '0.24', '0.00'],
    ['0.25', '0.49', '0.50'],
    ['0.50', '0.74', '0.50'],
    ['0.75', '0.99', '1.00'],
  ];

  it.each(LOCALES)('%s', async (locale, messages) => {
    const S = subOf(messages);
    const user = userEvent.setup();
    const view = mount(custom(null), locale, messages);
    for (let i = 0; i < REPORTER.length; i++) await user.click(screen.getByRole('button', { name: S.roundingBandAddRow }));
    // Blank rows are not a rule nobody typed — they are a blank-cell problem until filled in.
    expect(text(view.container)).toContain(S.roundingBandBlank);
    for (const [i, [from, to, result]] of REPORTER.entries()) {
      await user.type(cells(S.roundingBandFrom)[i]!, from!);
      await user.type(cells(S.roundingBandTo)[i]!, to!);
      await user.type(cells(S.roundingBandResult)[i]!, result!);
    }
    await user.tab();
    expect(posted(view.container)).toEqual([
      { from: 0, to: 0.24, result: 0 },
      { from: 0.25, to: 0.49, result: 0.5 },
      { from: 0.5, to: 0.74, result: 0.5 },
      { from: 0.75, to: 0.99, result: 1 },
    ]);
    for (const key of ['roundingBandBlank', 'roundingBandDecimals', 'roundingBandRange', 'roundingBandOrder', 'roundingBandOverlap', 'roundingBandDuplicate'] as const) {
      expect(text(view.container), `${locale} ${key}`).not.toContain(S[key]);
    }
    // No gap warning: the four ranges join up with both ends included.
    expect(view.container.querySelector('p.text-amber-600')).toBeNull();
    expect(intlErrors).toEqual([]);
  });
});

describe('§C every rule has its own message, and a gap warns with the uncovered decimals', () => {
  const PROBLEMS: [keyof Sub, LeaveTypeRules['roundingBands']][] = [
    ['roundingBandBlank', [{ from: 0, to: Number.NaN, result: 0 }]],
    ['roundingBandDecimals', [{ from: 0, to: 0.245, result: 0 }]],
    ['roundingBandRange', [{ from: 0, to: 1, result: 1.5 }]],
    ['roundingBandOrder', [{ from: 0.6, to: 0.5, result: 0 }]],
    [
      'roundingBandOverlap',
      [
        { from: 0, to: 0.24, result: 0 },
        { from: 0.24, to: 0.99, result: 1 },
      ],
    ],
    [
      'roundingBandDuplicate',
      [
        { from: 0, to: 0.99, result: 0 },
        { from: 0, to: 0.99, result: 1 },
      ],
    ],
  ];
  const ALL = PROBLEMS.map(([k]) => k);

  for (const [locale, messages] of LOCALES) {
    it.each(PROBLEMS)(`${locale}: %s — shown alone, on the row it concerns`, (key, bands) => {
      const S = subOf(messages);
      const view = mount(custom(bands), locale, messages);
      expect(text(view.container)).toContain(S[key]);
      for (const other of ALL.filter((k) => k !== key)) expect(text(view.container), `${locale} ${other}`).not.toContain(S[other]);
      expect(view.container.querySelectorAll('tr.bg-destructive\\/10').length).toBeGreaterThan(0);
      expect(intlErrors).toEqual([]);
    });

    it(`${locale}: a gap is a warning naming both ends, and the table is still posted`, () => {
      const S = subOf(messages);
      const view = mount(
        custom([
          { from: 0, to: 0.24, result: 0 },
          { from: 0.5, to: 0.74, result: 0.5 },
        ]),
        locale,
        messages,
      );
      const warnings = [...view.container.querySelectorAll('p.text-amber-600')].map((p) => p.textContent ?? '');
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('0.25');
      expect(warnings[0]).toContain('0.49');
      expect(warnings[1]).toContain('0.75');
      expect(warnings[1]).toContain('0.99');
      for (const k of ALL) expect(text(view.container)).not.toContain(S[k]);
      expect(intlErrors).toEqual([]);
    });
  }
});

describe('§D a third decimal is refused, never tidied', () => {
  it('"0.245" stays "0.245" on blur and draws the decimals message; "0.5" widens to "0.50"', async () => {
    const S = en.admin.leave.subStep;
    const user = userEvent.setup();
    const view = mount(custom([{ from: 0, to: 0.99, result: 0 }]));
    const to = cells(S.roundingBandTo)[0]!;
    await user.clear(to);
    await user.type(to, '0.245');
    fireEvent.blur(to);
    expect(cells(S.roundingBandTo)[0]!.value).toBe('0.245');
    expect(text(view.container)).toContain(S.roundingBandDecimals);
    expect(posted(view.container)).toEqual([{ from: 0, to: 0.245, result: 0 }]);

    const result = cells(S.roundingBandResult)[0]!;
    await user.clear(result);
    await user.type(result, '0.5');
    fireEvent.blur(result);
    expect(cells(S.roundingBandResult)[0]!.value).toBe('0.50');
  });

  it('a stored third decimal (a hand-written row) is SHOWN as stored, so the next save cannot quietly round it', () => {
    const S = en.admin.leave.subStep;
    const view = mount(custom([{ from: 0.001, to: 0.99, result: 1 }]));
    expect(cells(S.roundingBandFrom)[0]!.value).toBe('0.001');
    expect(text(view.container)).toContain(S.roundingBandDecimals);
  });
});

describe('§E the worked example reads the table in its new meaning', () => {
  it.each(LOCALES)('%s', (locale, messages) => {
    const S = subOf(messages);
    // One month of 14 days is 1.17. 0.17 is INSIDE 0.00–0.24 on the reporter's table ⇒ 1.00; and a single-point
    // row at exactly 0.17 — legal now, an empty band before — catches it too.
    const reporter = mount(
      custom([
        { from: 0, to: 0.24, result: 0 },
        { from: 0.25, to: 0.49, result: 0.5 },
        { from: 0.5, to: 0.74, result: 0.5 },
        { from: 0.75, to: 0.99, result: 1 },
      ]),
      locale,
      messages,
    );
    const expected = (rounded: string) =>
      S.roundingWorkedExample.replace('{raw}', '1.17').replace('{rounded}', rounded);
    expect(text(reporter.container)).toContain(expected('1.00'));
    reporter.unmount();
    const point = mount(custom([{ from: 0.17, to: 0.17, result: 0.5 }]), locale, messages);
    expect(text(point.container)).toContain(expected('1.50'));
    expect(intlErrors).toEqual([]);
  });
});
