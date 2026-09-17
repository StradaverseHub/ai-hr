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
 *   §D a third decimal is REFUSED, never tidied: "0.245" is posted as typed on blur and named as a problem;
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
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider, createTranslator, useTranslations } from 'next-intl';

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
/** Every problem message the table draws, in order, as [kind, text]. `data-problem` is on each paragraph. */
const problemsShown = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-problem]')].map((p) => [p.dataset.problem, p.textContent ?? '']);
/** The shipping catalogue's message, formatted by the real ICU engine with the arguments the screen passes. */
const say = (locale: string, messages: Record<string, unknown>, key: keyof Sub, values?: Record<string, string>) =>
  // Untyped on purpose: the six catalogues are loaded as JSON, and the key list is `keyof Sub` already.
  (createTranslator({ locale, messages, namespace: 'admin.leave.subStep' }) as unknown as (k: string, v?: Record<string, string>) => string)(key, values);

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
    expect(problemsShown(view.container)).toEqual([]);
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
    expect(problemsShown(view.container)).toEqual([['blank', S.roundingBandBlank]]);
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
    // No refusal and no gap warning: the four ranges join up with both ends included.
    expect(problemsShown(view.container)).toEqual([]);
    expect(intlErrors).toEqual([]);
  });
});

describe('§C every rule has its own message, and a gap warns with the uncovered decimals', () => {
  type Case = [string, LeaveTypeRules['roundingBands'], (locale: string, m: Record<string, unknown>) => [string, string][]];
  const PROBLEMS: Case[] = [
    ['blank', [{ from: 0, to: Number.NaN, result: 0 }], (l, m) => [['blank', say(l, m, 'roundingBandBlank')]]],
    ['decimals', [{ from: 0, to: 0.245, result: 0 }], (l, m) => [['decimals', say(l, m, 'roundingBandDecimals')]]],
    ['range', [{ from: 0, to: 1, result: 1.5 }], (l, m) => [['range', say(l, m, 'roundingBandRange')]]],
    ['order', [{ from: 0.6, to: 0.5, result: 0 }], (l, m) => [['order', say(l, m, 'roundingBandOrder')]]],
    [
      // The approved mockup's own example check: "0.25 to 0.49 overlaps 0.40 to 0.60".
      'overlap',
      [
        { from: 0, to: 0.24, result: 0 },
        { from: 0.25, to: 0.49, result: 0.5 },
        { from: 0.4, to: 0.6, result: 0.5 },
      ],
      (l, m) => [['overlap', say(l, m, 'roundingBandOverlap', { from: '0.25', to: '0.49', otherFrom: '0.40', otherTo: '0.60' })]],
    ],
    [
      'duplicate',
      [
        { from: 0, to: 0.99, result: 0 },
        { from: 0, to: 0.99, result: 1 },
      ],
      (l, m) => [['duplicate', say(l, m, 'roundingBandDuplicate', { from: '0.00', to: '0.99' })]],
    ],
  ];

  for (const [locale, messages] of LOCALES) {
    it.each(PROBLEMS)(`${locale}: %s — its own message and nothing else, on a highlighted row`, (_kind, bands, want) => {
      const view = mount(custom(bands), locale, messages);
      expect(problemsShown(view.container)).toEqual(want(locale, messages));
      expect(view.container.querySelectorAll('tr.bg-destructive\\/10').length).toBeGreaterThan(0);
      expect(intlErrors).toEqual([]);
    });

    it(`${locale}: a gap is a warning naming both ends, and the table is still posted`, () => {
      const view = mount(
        custom([
          { from: 0, to: 0.24, result: 0 },
          { from: 0.5, to: 0.74, result: 0.5 },
        ]),
        locale,
        messages,
      );
      expect(problemsShown(view.container)).toEqual([
        ['gap', say(locale, messages, 'roundingBandGap', { from: '0.25', to: '0.49' })],
        ['gap', say(locale, messages, 'roundingBandGap', { from: '0.75', to: '0.99' })],
      ]);
      expect(view.container.querySelectorAll('tr.bg-destructive\\/10')).toHaveLength(0);
      expect(posted(view.container)).toEqual([
        { from: 0, to: 0.24, result: 0 },
        { from: 0.5, to: 0.74, result: 0.5 },
      ]);
      expect(intlErrors).toEqual([]);
    });
  }
});

describe('§D a third decimal is refused, never tidied', () => {
  it('"0.245" is NOT tidied to 0.25 on blur: it is posted as typed and draws the decimals message', async () => {
    // ⚠️ Asserted on what the form POSTS (the component's state), not only on the box: React leaves a
    // controlled type="number" box alone when the new text is numerically equal, so a harmless widening
    // ("0.5" → "0.50") never shows in the DOM, while a NARROWING ("0.245" → "0.25") changes the posted table.
    const S = en.admin.leave.subStep;
    const user = userEvent.setup();
    const view = mount(custom([{ from: 0, to: 0.99, result: 0 }]));
    const to = cells(S.roundingBandTo)[0]!;
    await user.clear(to);
    await user.type(to, '0.245');
    await user.tab(); // a real focus move — React's onBlur listens for focusout
    expect(cells(S.roundingBandTo)[0]!.value).toBe('0.245');
    expect(posted(view.container)).toEqual([{ from: 0, to: 0.245, result: 0 }]);
    expect(text(view.container)).toContain(S.roundingBandDecimals);
    // A two-decimal figure is still accepted as the same number.
    const result = cells(S.roundingBandResult)[0]!;
    await user.clear(result);
    await user.type(result, '0.5');
    await user.tab();
    expect(posted(view.container)).toEqual([{ from: 0, to: 0.245, result: 0.5 }]);
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
