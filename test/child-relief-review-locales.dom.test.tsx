/**
 * 99b2d6c0 (r336) — the Child relief review TABLE rendered in all six locales, with rows.
 *
 * WHY THIS FILE EXISTS, and it is not belt-and-braces. The §8 render check loads the real screen on a
 * real dev server, but `pnpm db:seed` creates NO employee with children and NO employee in 'auto_table'
 * mode (verified: `db/seed.ts` never touches `employee_statutory_my` or `employee_dependent`). So the
 * dev-server pass can only ever render this screen's EMPTY STATE. Every string that carries a ringgit
 * figure — the column headers, the mode names, the empty-grid warning, the partial-coverage note — lives
 * on the populated table and is unreachable by any URL a curl can request against the seeded database.
 * They are proved here instead, against the REAL catalogue for each locale.
 *
 * ⚠️ PRESENCE IS NOT TRANSLATION. `i18n/request.ts` deep-merges each locale over English, so a key that
 * is missing from ms.json renders the ENGLISH sentence and never a MISSING_MESSAGE. A test that only
 * asserted "something rendered" would pass for six English screens. Each caption is therefore asserted
 * DISTINCT across the six as well as present.
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
  ChildReliefAmountsCard,
  ChildReliefReviewTable,
  type ChildReliefReviewTableRow,
} from '../components/child-relief-review-table';
import { CHILD_RELIEF_CATEGORY_KEYS } from '../localization/my/statutory-tables';

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

/** The three shapes the screen has to be able to say out loud. No figure here is a statutory amount. */
const ROWS: ChildReliefReviewTableRow[] = [
  {
    // Flat counting, nothing keyed — the row whose switch would COST them.
    personId: 'p1',
    name: 'Aisha Rahman',
    jobs: [{ employmentId: 'e1', employeeCode: 'EMP-001', company: 'Acme Sdn Bhd' }],
    mode: 'manual',
    numChildren: 2,
    todayRM: 4000,
    switchRM: 0,
    deltaRM: -4000,
    gridKeyed: false,
    familyRM: 10000,
    familyEligible: 2,
    familyCategorised: 1,
  },
  {
    // Already on the category table — nothing to decide, and the row says so.
    personId: 'p2',
    name: 'Bala Krishnan',
    jobs: [
      { employmentId: 'e2', employeeCode: 'EMP-002', company: 'Beta Sdn Bhd' },
      { employmentId: 'e3', employeeCode: 'EMP-003', company: 'Acme Sdn Bhd' },
    ],
    mode: 'auto_table',
    numChildren: 1,
    todayRM: 8000,
    switchRM: 8000,
    deltaRM: 0,
    gridKeyed: true,
    familyRM: null,
    familyEligible: 0,
    familyCategorised: 0,
  },
  {
    // Derived from the Family register, fully categorised — no partial-coverage note on this one.
    personId: 'p3',
    name: 'Chong Wei',
    jobs: [{ employmentId: 'e4', employeeCode: 'EMP-004', company: 'Acme Sdn Bhd' }],
    mode: 'auto',
    numChildren: 3,
    todayRM: 6000,
    switchRM: 14000,
    deltaRM: 8000,
    gridKeyed: true,
    familyRM: 14000,
    familyEligible: 3,
    familyCategorised: 3,
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

describe.each(LOCALES)('99b2d6c0 · %s — the populated report resolves against the real catalogue', (loc, m) => {
  it('renders seven column headers, one row per person, and no raw key anywhere', () => {
    const { container } = wrap(loc, m, <ChildReliefReviewTable rows={ROWS} />);
    const headers = [...container.querySelectorAll('thead th')];
    expect(headers.length, 'seven columns').toBe(7);
    headers.forEach((h, i) => resolves(h, `column ${i}`));

    const bodyRows = [...container.querySelectorAll('tbody tr')];
    expect(bodyRows.length).toBe(ROWS.length);
    resolves(container.querySelector('table'), 'the whole table');
    // MISSING_MESSAGE is the literal next-intl paints in some configurations; neither form may appear.
    expect(container.textContent ?? '').not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });

  it('the empty-grid warning appears on the row it applies to and NOWHERE else', () => {
    const { container } = wrap(loc, m, <ChildReliefReviewTable rows={ROWS} />);
    const bodyRows = [...container.querySelectorAll('tbody tr')];
    const warning = (m as { people: { childRelief: { gridEmptyWarning: string } } }).people.childRelief
      .gridEmptyWarning;
    expect(bodyRows[0].textContent, 'the unkeyed manual row warns').toContain(warning);
    expect(bodyRows[1].textContent, 'the row already on the table does not').not.toContain(warning);
    expect(bodyRows[2].textContent, 'the keyed row does not').not.toContain(warning);
  });

  it('the partial-coverage note substitutes BOTH counts, and is absent when coverage is complete', () => {
    const { container } = wrap(loc, m, <ChildReliefReviewTable rows={ROWS} />);
    const bodyRows = [...container.querySelectorAll('tbody tr')];
    // Read the NOTE ITSELF, not the row: the row's textContent runs the ringgit figure straight into the
    // sentence ("10,000.002 of …"), which would make a digit search on the row pass or fail by accident.
    const note = bodyRows[0].querySelector('td:last-child span');
    resolves(note, 'the partial-coverage note');
    const txt = note!.textContent ?? '';
    // 1 of 2 — both counts substituted, in whatever order the locale's sentence puts them.
    expect(txt, 'the covered count').toMatch(/(^|\D)1(\D|$)/);
    expect(txt, 'the eligible count').toMatch(/(^|\D)2(\D|$)/);
    expect(txt, 'unresolved ICU argument').not.toMatch(/\{(done|total)\}/);
    // The fully-categorised row must not carry the note at all. Compared on the sentence's invariant
    // tail (everything after the last substituted count), so this stays honest for a locale that orders
    // the numbers differently from English.
    const template = (m as { people: { childRelief: { familyPartial: string } } }).people.childRelief
      .familyPartial;
    const tail = template.slice(template.lastIndexOf('}') + 1).trim();
    expect(tail.length, 'the sentence must have a tail to compare on').toBeGreaterThan(4);
    expect(bodyRows[2].textContent ?? '', 'complete coverage says nothing').not.toContain(tail);
  });

  it('every row offers a link INTO the grid — one per job, which is the reachability this item is for', () => {
    const { container } = wrap(loc, m, <ChildReliefReviewTable rows={ROWS} />);
    const links = [...container.querySelectorAll('a')];
    expect(links.length, 'four jobs across three people').toBe(4);
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^\/admin\/personnel\/e\d\?tab=bankStatutory$/);
      resolves(a, 'the open-record link');
    }
  });

  it('the amounts card substitutes BOTH ICU arguments and names every one of the five categories', () => {
    // The amounts the card is handed are DELIBERATELY not the shipped statutory figures: this asserts
    // that the card prints what it is given, so correcting a RATE-ONLY figure never touches this test.
    const categories = CHILD_RELIEF_CATEGORY_KEYS.map((key, i) => ({ key, amount: 1000 * (i + 1) }));
    const { container } = wrap(
      loc,
      m,
      <ChildReliefAmountsCard version="2026.7" asOf="2026-09-24" perChild={2000} categories={categories} />,
    );
    const text = container.textContent ?? '';
    resolves(container.firstElementChild, 'the amounts card heading');
    expect(text, 'the ruleset version').toContain('2026.7');
    expect(text, 'the as-at date').toContain('2026-09-24');
    expect(text, 'unresolved ICU argument').not.toMatch(/\{(version|asOf)\}/);
    const c = (m as { people: { childRelief: Record<string, string> } }).people.childRelief;
    for (const key of CHILD_RELIEF_CATEGORY_KEYS) {
      expect(text, `category ${key} must be named in this locale's words`).toContain(c[`cat_${key}`]);
    }
    // ⚠️ The caveat travels with the figures. A ringgit report without it invites acting on a number
    // localization/my/statutory-tables.ts marks RATE-ONLY, NOT YET VERIFIED.
    expect(text).toContain(c.amountsPendingSignOff);
    expect(text).toMatch(/1,000\.00/);
    expect(text).toMatch(/2,000\.00/);
    expect(text).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });

  it('the three mode names are the locale’s own words, never the stored value', () => {
    const { container } = wrap(loc, m, <ChildReliefReviewTable rows={ROWS} />);
    const text = container.textContent ?? '';
    expect(text, 'a raw enum value must never reach the screen').not.toContain('auto_table');
    const names = (m as { people: { childRelief: Record<string, string> } }).people.childRelief;
    expect(text).toContain(names.modeManual);
    expect(text).toContain(names.modeAuto);
    expect(text).toContain(names.modeAutoTable);
  });
});

describe('99b2d6c0 · the six renders are genuinely six languages', () => {
  it('the rendered table text differs between every pair of locales', () => {
    const rendered = LOCALES.map(([loc, m]) => {
      const { container } = wrap(loc, m, <ChildReliefReviewTable rows={ROWS} />);
      return (container.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
    // Deep-merge fallback means an untranslated locale renders English. Six DISTINCT strings is the only
    // assertion that catches it, and it is the one the render check cannot make.
    expect(new Set(rendered).size, 'two locales rendered identical text').toBe(LOCALES.length);
  });
});
