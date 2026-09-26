/**
 * r343 · item 03f89c0f — the TYPED-ABOVE-THE-RECORD table rendered in all six locales, with rows.
 *
 * WHY THIS FILE EXISTS. `pnpm db:seed` creates no employee with children and no employee_statutory_my row
 * at all, so the §8 dev-server render check can only ever reach this screen's EMPTY state: every string on
 * the populated table — seven column headers, the partial-coverage note — is unreachable by any URL a curl
 * can request. They are proved here instead, against the REAL catalogue for each locale.
 *
 * ⚠️ `disagreeCategorised` carries TWO ICU arguments, which is exactly the shape that paints a
 * FORMATTING_ERROR in a browser while passing tsc, the suite and `next build` alike. That is the specific
 * failure this file is worth having for.
 *
 * ⚠️ PRESENCE, NOT DISTINCTNESS, FOR THE NEW KEYS. `i18n/request.ts` deep-merges each locale over English,
 * and these keys carry the English sentence in all six files — this project's convention for a NEW key,
 * because a translation nobody can verify is worse than a visible English one (r340 shipped two misspelled
 * ones no guard could see). So this asserts that every caption RESOLVES and that no raw key path or
 * un-substituted placeholder reaches the screen; it does NOT assert six different sentences, which would be
 * asserting a translation that has not happened.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import {
  ChildReliefDisagreementTable,
  type ChildReliefDisagreementRow,
} from '../components/child-relief-review-table';

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

/** Two shapes the screen has to be able to say out loud. No figure here is a statutory amount. */
const ROWS: ChildReliefDisagreementRow[] = [
  {
    // A00001's shape: a big typed figure over a single child on file, whose category IS recorded.
    personId: 'p1',
    name: 'Aisha Rahman',
    jobs: [{ employmentId: 'e1', employeeCode: 'EMP-001', company: 'Acme Sdn Bhd' }],
    numChildren: 9,
    familyEligible: 1,
    familyCategorised: 1,
    typedExcess: 8,
    todayRM: 18000,
    recordRM: 2000,
    excessRM: 16000,
  },
  {
    // A half-keyed record — the reader has to know the record itself may be the incomplete half.
    personId: 'p2',
    name: 'Bala Krishnan',
    jobs: [
      { employmentId: 'e2', employeeCode: 'EMP-002', company: 'Beta Sdn Bhd' },
      { employmentId: 'e3', employeeCode: 'EMP-003', company: 'Acme Sdn Bhd' },
    ],
    numChildren: 4,
    familyEligible: 2,
    familyCategorised: 1,
    typedExcess: 2,
    todayRM: 8000,
    recordRM: 4000,
    excessRM: 4000,
  },
];

const wrap = (locale: string, messages: unknown, ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages as never}>
      {ui}
    </NextIntlClientProvider>,
  );

/** next-intl paints the KEY PATH when a message is missing and leaves `{placeholder}` un-substituted. */
const resolves = (el: Element | null, what: string) => {
  expect(el, `${what}: nothing rendered`).not.toBeNull();
  const txt = el!.textContent ?? '';
  expect(txt.trim(), `${what}: empty`).not.toBe('');
  expect(txt, `${what}: unresolved ICU placeholder`).not.toMatch(/\{[a-zA-Z]/);
  expect(txt, `${what}: a raw key path, i.e. MISSING_MESSAGE`).not.toMatch(/\bpeople\.childRelief\b/);
};

describe.each(LOCALES)('03f89c0f · %s — the disagreement table resolves against the real catalogue', (loc, m) => {
  it('renders seven column headers, one row per person, and no raw key anywhere', () => {
    const { container } = wrap(loc, m, <ChildReliefDisagreementTable rows={ROWS} />);
    const headers = [...container.querySelectorAll('thead th')];
    expect(headers.length, 'seven columns').toBe(7);
    headers.forEach((h, i) => resolves(h, `column ${i}`));
    const bodyRows = [...container.querySelectorAll('tbody tr')];
    expect(bodyRows.length).toBe(ROWS.length);
    expect(container.textContent ?? '').not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });

  it('the two-argument coverage note substitutes BOTH counts, and is absent when coverage is complete', () => {
    const { container } = wrap(loc, m, <ChildReliefDisagreementTable rows={ROWS} />);
    const bodyRows = [...container.querySelectorAll('tbody tr')];
    const note = (m as { people: { childRelief: { disagreeCategorised: string } } }).people.childRelief
      .disagreeCategorised;
    // The row whose record is fully categorised must NOT carry it.
    expect(bodyRows[0].textContent, 'fully categorised row carries no coverage note').not.toContain(
      note.replace(/\{done\}/, '1').replace(/\{total\}/, '1'),
    );
    const partial = bodyRows[1].textContent ?? '';
    expect(partial, 'the half-keyed row says how much of the record is keyed').toContain('1');
    expect(partial, 'no placeholder survived').not.toMatch(/\{(done|total)\}/);
  });

  it('every row offers a link to ONE record and NO bulk control anywhere', () => {
    const { container } = wrap(loc, m, <ChildReliefDisagreementTable rows={ROWS} />);
    // One link per JOB — the corrections are made one person at a time, on their own record.
    expect(container.querySelectorAll('a[href^="/admin/personnel/"]').length).toBe(3);
    // ⚠️ THE ABSENCE IS THE REQUIREMENT. 52 children whose reality nobody has established must not be
    // changeable in one click, so there is no form, no button, no checkbox and no select on this table.
    for (const tag of ['form', 'button', 'input', 'select', 'textarea']) {
      expect(container.querySelectorAll(tag).length, `no <${tag}> may appear`).toBe(0);
    }
  });

  it('the page’s own captions resolve — head-count, not-an-error, no-bulk and the Auto caveat', () => {
    const cr = (m as { people: { childRelief: Record<string, string> } }).people.childRelief;
    for (const key of [
      'disagreeTitle',
      'disagreeDescription',
      'disagreeStatPeople',
      'disagreeStatChildren',
      'disagreeStatReliefRM',
      'disagreeHeadCountNote',
      'disagreeNotAnErrorNote',
      'disagreeNoBulkNote',
      'disagreeAutoCaveatNote',
    ]) {
      expect(cr[key], `${loc}.people.childRelief.${key} must exist`).toBeTypeOf('string');
      expect((cr[key] ?? '').trim(), `${loc}.${key} must not be blank`).not.toBe('');
      expect(cr[key], `${loc}.${key} must carry no ICU argument the page does not pass`).not.toMatch(
        /\{[a-zA-Z]/,
      );
    }
  });
});
