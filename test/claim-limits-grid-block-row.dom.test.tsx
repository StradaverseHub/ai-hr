/**
 * e7eb5d83 rev 6 — the Per Block row, rendered, in all six locales.
 *
 * WHY A RENDER TEST AND NOT A DEV-SERVER 200. The plan called a render check mandatory across the six
 * locales because the block cell's "every" label and its month/year options are translated, and a missing
 * key paints MISSING_MESSAGE while returning 200 and passing tsc, the suite and `next build`. But a curl
 * against a dev server cannot see this grid either: it is a client island whose rows come from a grade
 * selection, so what a server log proves is that the PAGE rendered, not that this component resolved its
 * keys. So the check lives here, against the real catalogue for each locale, in the precedent set by
 * test/r191-panel-order-locales.dom.test.tsx.
 *
 * `onError` THROWS below, deliberately. next-intl's default behaviour on a missing key is to log and
 * render the key path, which a happy-path assertion can easily read straight past. Throwing makes any
 * unresolved key anywhere in this subtree — not just the ones asserted by name — fail the test.
 *
 * Scope, inherited from every other dom test here: jsdom applies no CSS and computes no layout, so this
 * cannot prove a pixel or that the row fits. What it proves is that the five controls are children of ONE
 * container carrying the classes that keep them on one line, and that each of them resolves its text in
 * each of the six languages. The cascade fact those classes depend on is measured in
 * test/claims-config-layout.test.ts section D.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { ClaimLimitsGrid, type ClaimLimitGridRow } from '../components/claim-limits-grid';

// The grid imports the server action directly (that is the point — a closure prop across the RSC boundary
// 500s). In jsdom that module would drag the database in, so it is stubbed to a no-op: nothing here
// submits.
vi.mock('@/app/admin/claims/limits/actions', () => ({
  setGradeClaimLimitsAction: async () => {},
}));

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

const values = {
  perClaimCap: '',
  monthlyLimit: '',
  annualBudget: '',
  blockEnabled: true,
  blockLimit: '500',
  blockLength: '1',
  blockUnit: 'year',
  maxClaimsPerYear: '',
};

/** One of each shape the grid can draw, so every translated string in the component is exercised. */
const ROWS: ClaimLimitGridRow[] = [
  {
    key: 'ct1:',
    claimTypeId: 'ct1',
    claimItemId: null,
    name: 'Medical',
    code: 'MEDICAL',
    depth: 0,
    inherited: true, // paints the fallback badge
    values,
    hint: null,
  },
  {
    key: 'ct1:i1',
    claimTypeId: 'ct1',
    claimItemId: 'i1',
    name: 'Dental',
    code: 'DENTAL',
    depth: 1,
    inherited: false,
    values,
    hint: { kind: 'sub', typeName: 'Medical' }, // paints gridSubHint
  },
  {
    key: 'ct2:',
    claimTypeId: 'ct2',
    claimItemId: null,
    name: 'Mileage',
    code: 'MILEAGE',
    depth: 0,
    inherited: false,
    values: { ...values, blockEnabled: false },
    hint: { kind: 'mileage', bands: 'RM 0.60 (0-500km)' }, // paints the mileage rate line
  },
];

function renderGrid(messages: (typeof LOCALES)[number][1]) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      onError={(err) => {
        throw err;
      }}
    >
      <ClaimLimitsGrid rows={ROWS} gradeId="g1" gradeLabel="Grade 12" today="2026-08-13" mileageHref="/admin/claims/mileage" />
    </NextIntlClientProvider>,
  );
}

/** The Per Block cell of the first row: the flex container holding the five controls. */
function blockCell(container: HTMLElement): HTMLElement {
  const row = container.querySelectorAll('tbody tr')[0] as HTMLElement;
  const cell = row.querySelectorAll('td')[4] as HTMLElement; // 6 columns; Per Block is the fifth
  const flex = cell.firstElementChild as HTMLElement;
  expect(flex, 'the Per Block cell must hold its controls in one container').not.toBeNull();
  return flex;
}

describe('e7eb5d83 rev 6 · the Per Block row resolves its text in all six locales', () => {
  it.each(LOCALES)('%s', (_locale, messages) => {
    const { container } = renderGrid(messages);
    const m = messages.admin.claims;

    // The three strings the plan named. `.toLowerCase()` mirrors the component; for th/ta/zh it is a
    // no-op, which is exactly why asserting the transformed value rather than the raw one matters.
    const cell = blockCell(container);
    expect(within(cell).getByText(m.blockEveryLabel.toLowerCase())).toBeInTheDocument();
    const select = cell.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([m.blockUnit_month, m.blockUnit_year]);

    // The column heading it sits under, and the tick's accessible name — both translated, both easy to
    // lose in a layout change.
    expect(screen.getAllByText(m.blockLimitLabel).length).toBeGreaterThan(0);
    expect(within(cell).getByLabelText(m.blockEnableLabel)).toBeInTheDocument();
  });
});

describe('e7eb5d83 rev 6 · the five controls are ONE row', () => {
  it('all five live in a single container that stops wrapping at md', () => {
    const { container } = renderGrid(en);
    const cell = blockCell(container);

    // tick · amount · "every" · how many · unit — five children of one flex container. A future edit that
    // splits them into two rows of markup would pass a class check and still stack.
    expect(cell.children).toHaveLength(5);
    expect(cell.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(cell.querySelectorAll('input[type="number"]')).toHaveLength(2);
    expect(cell.querySelectorAll('select')).toHaveLength(1);

    const cls = cell.className;
    expect(cls).toContain('flex-wrap'); // small screens fold on purpose
    expect(cls).toContain('md:flex-nowrap'); // desktop does not
  });

  it('the sized controls carry basis-*, and no w-* that inputCls would beat', () => {
    // The rendered check of the rule test/claims-config-layout.test.ts pins in source: whatever template
    // composition builds these class strings, what ends up on the element must not be a w-* that loses to
    // inputCls's w-full. Asserted on markup so cn()/template changes cannot slip past it.
    const { container } = renderGrid(en);
    const cell = blockCell(container);
    const sized = [...cell.querySelectorAll('input[type="number"], select')] as HTMLElement[];
    expect(sized).toHaveLength(3);
    for (const el of sized) {
      expect(el.className, `${el.tagName} must be sized by flex-basis`).toMatch(/\bbasis-\d+\b/);
      expect(el.className, `${el.tagName} carries a w-* that silently loses to w-full`).not.toMatch(/\bw-\d+\b/);
      expect(el.className).toContain('shrink-0');
    }
  });

  it('unticking Per Block disables the other four but keeps them on the row', () => {
    // The third fixture row has blockEnabled: false. Disabled is a visual state, not a layout one — the
    // controls must still be there, or "the row reads as one row" stops being true half the time.
    const { container } = renderGrid(en);
    const row = container.querySelectorAll('tbody tr')[3] as HTMLElement; // rows 0-2 plus row 1's hint row
    const cell = row.querySelectorAll('td')[4] as HTMLElement;
    const flex = cell.firstElementChild as HTMLElement;
    expect(flex.children).toHaveLength(5);
    expect((flex.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    for (const el of [...flex.querySelectorAll('input[type="number"], select')] as (
      | HTMLInputElement
      | HTMLSelectElement
    )[]) {
      expect(el.disabled).toBe(true);
    }
  });
});
