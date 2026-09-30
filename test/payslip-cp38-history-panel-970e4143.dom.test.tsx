/**
 * Item 970e4143 — THE TRANSACTION HISTORY BREAKDOWN PANEL, RENDERED, because it is the one surface of the
 * eight that cannot be checked any other way.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `history-table.tsx` is a CLIENT component and the breakdown only exists
 * once a row is expanded: no server render and no source grep reaches what it draws. Its deductions block
 * printed EPF / SOCSO / SKBBK / EIS / PCB / CP38 / Zakat above a TOTAL DEDUCTIONS and had NO
 * other-deductions row ANYWHERE in the file, so on every run where `other_deductions` held something — a
 * staff loan, a manual deduction, unpaid leave, a carry-forward recovery — the rows an operator reconciles
 * a run with fell SHORT of the total printed under them. It gained three rows in this round (the two named
 * absence halves and the residual) and a CP38 row that now prints what was DEDUCTED rather than what the
 * LHDN direction demanded. Three new rows on a client component is exactly the change a 200 cannot check.
 *
 * ⚠️ THE FIGURES ARE COPIED FROM A REAL RUN, not invented. jsdom has no database, so this file cannot feed
 * itself from `generatePayslips` the way test/payslip-cp38-reconcile-970e4143.test.ts does — that file is
 * where the kernel-fed arithmetic lives, over the SAME row projection this panel renders
 * (`deriveHistoryBreakdown`). What is pinned here is the RENDER. So the fixture carries the figures measured
 * on the r368 render check (Daniel Tan, EMP-0002, RM11,000 basic, 2026-11, CP38 450 plus a keyed RM125
 * deduction item: EPF 1,210.00 · SOCSO 29.75 · EIS 11.90 · PCB 0.00 · CP38 450.00 · other_deductions 575.00
 * · total_deductions 1,826.65) and the kernel invariant behind them is asserted BEFORE anything is
 * rendered — a fixture that did not satisfy it would make every row assertion below meaningless.
 *
 * SCOPE NOTE (inherited from the other dom tests): jsdom applies no CSS and computes no layout, so this
 * catches rendering logic, not a visual regression.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { HistoryTable } from '../app/payroll/transaction-view/history-table';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const SLIP = messages.me.payslip;

/** The measured run. `statutory` carries the 970e4143 stamp; the clamped variant strips/rewrites it. */
const slip = (
  over: Partial<ProcessedPayslipViewRow>,
  /** ⚠️ THE WHOLE CP38 SHAPE, always explicit. There is no default pair to forget to override: a fixture
   *  that meant "legacy, no stamp" and silently inherited `cp38Applied` would assert the opposite of what
   *  it says, which is exactly the class of fixture error this whole item is about. */
  cp38: { cp38: number; cp38Applied?: number },
  st: Record<string, unknown> = {},
): ProcessedPayslipViewRow =>
  ({
    id: '00000000-0000-0000-0000-000000000001',
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    employeeName: 'Daniel Tan',
    employeeCode: 'EMP-0002',
    companyId: '00000000-0000-0000-0000-0000000000c1',
    company: 'Demo Sdn Bhd',
    payPeriod: '2026-11',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'processed',
    releasedAt: null,
    version: 1,
    basic: '11000.00',
    allowance: '0.00',
    overtime: '0.00',
    bonus: '0.00',
    gross: '11000.00',
    statutory: {
      epfEmployee: 1210, socsoEmployee: 29.75, socsoSkbbk: 0, eisEmployee: 11.9, pcb: 0,
      epfEmployer: 1320, socsoEmployer: 104.15, eisEmployer: 11.9, hrdf: 0,
      ...cp38,
      ...st,
    },
    otherDeductions: '575.00',
    totalDeductions: '1826.65',
    net: '9173.35',
    ...over,
  }) as ProcessedPayslipViewRow;

async function renderExpanded(row: ProcessedPayslipViewRow) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HistoryTable rows={[row]} hrdfRegisteredCompanyIds={[row.companyId]} />
    </NextIntlClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /show/i }));
}

/**
 * The money drawn BESIDE `label`, read out of the rendered DOM the way a reader reads it.
 *
 * Both a `Row` and the block's total are `<span>label</span><span>amount</span>`, so the amount is the
 * label span's next sibling — NOT "the first money anywhere in the enclosing div", which picks up the run
 * summary's own figures and quietly answered 11,000.00 for "Total deductions".
 *
 * A named absence line composes its label ("Unpaid leave · 2 days"), so the prefix form is accepted too.
 *
 * ⚠️ EPF / SOCSO / EIS are each drawn TWICE — once as a deduction, once as an employer contribution (r367's
 * own test pins that, and it is why the section heading has to carry the claim). The FIRST match is taken,
 * which is the deductions block: `history-table.tsx` renders it before the employer block.
 */
function amountBeside(label: string): number | null {
  const hit = Array.from(document.querySelectorAll('span')).find((el) => {
    const t = (el.textContent ?? '').trim();
    return t === label || t.startsWith(`${label} ·`);
  });
  if (!hit) return null;
  const m = /(-?[\d,]+\.\d{2})/.exec(hit.nextElementSibling?.textContent ?? '');
  if (!m) throw new Error(`the rendered row "${label}" carried no amount beside it`);
  return Number(m[1].replace(/,/g, ''));
}

/** Every deduction row the panel drew, in the order it draws them. */
const DEDUCTION_LABELS = [
  SLIP.epf, SLIP.socso, SLIP.skbbk, SLIP.eis, SLIP.pcb, SLIP.cp38, SLIP.zakat,
  SLIP.unpaidLeaveLine, SLIP.absentLine, SLIP.otherDeductions,
] as const;

/**
 * ⚠️ EPF / SOCSO / EIS are drawn TWICE — once as a deduction, once as an employer contribution (r367's own
 * test pins that, and it is why the section heading carries the claim). So the deduction side is taken as
 * the FIRST occurrence of each label, which is the order `history-table.tsx` renders the two blocks in.
 */
function deductionRows(): { label: string; amount: number }[] {
  return DEDUCTION_LABELS.map((l) => ({ label: l, amount: amountBeside(l) }))
    .filter((r): r is { label: string; amount: number } => r.amount != null);
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));

describe('970e4143 — the rendered History breakdown panel reconciles', () => {
  it('THE FIXTURE ITSELF obeys the kernel invariant, or nothing below means anything', () => {
    const row = slip({}, { cp38: 450, cp38Applied: 450 });
    const st = row.statutory as Record<string, number>;
    // total_deductions = (statutory legs) + other_deductions, and the APPLIED CP38 is INSIDE
    // other_deductions (core/payroll.ts `slipExtraDeduct`). This is the model the old payslip-pdf fixtures
    // had backwards, which is how the double count survived a drawn-page arithmetic assertion.
    expect(sum([st.epfEmployee, st.socsoEmployee, st.socsoSkbbk, st.eisEmployee, st.pcb, Number(row.otherDeductions)]))
      .toBe(Number(row.totalDeductions));
    // NON-VACUITY, the same three guards the kernel-fed file applies: a zero CP38, a zero
    // other_deductions, or a residual EQUAL to the instalment all reconcile however the panel behaves.
    expect(st.cp38).toBeGreaterThan(0);
    expect(Number(row.otherDeductions)).toBeGreaterThan(st.cp38);
    expect(r2(Number(row.otherDeductions) - st.cp38)).not.toBe(st.cp38);
  });

  it('draws a CP38 row AND an Other-deductions row, and they sum to the total it prints', async () => {
    await renderExpanded(slip({}, { cp38: 450, cp38Applied: 450 }));
    const rows = deductionRows();
    expect(rows.map((r) => r.label), 'the CP38 row is drawn').toContain(SLIP.cp38);
    expect(rows.map((r) => r.label), 'and the residual row, which this panel never had').toContain(
      SLIP.otherDeductions,
    );
    expect(rows.find((r) => r.label === SLIP.cp38)!.amount).toBe(450);
    expect(rows.find((r) => r.label === SLIP.otherDeductions)!.amount, '575.00 less the 450 instalment').toBe(125);
    expect(sum(rows.map((r) => r.amount)), 'the drawn rows sum to the drawn total').toBe(1826.65);
    expect(amountBeside(SLIP.totalDeductions), 'and that IS the total the panel prints').toBe(1826.65);
  });

  it('a CLAMPED instalment: the row says what was TAKEN, and the panel still adds up', async () => {
    // The measured clamped run: 99,999 demanded against 11,000 of pay, 9,623.35 recovered.
    await renderExpanded(
      slip({ otherDeductions: '9748.35', totalDeductions: '11000.00', net: '0.00' }, { cp38: 99999, cp38Applied: 9623.35 }),
    );
    const rows = deductionRows();
    expect(rows.find((r) => r.label === SLIP.cp38)!.amount).toBe(9623.35);
    expect(document.body.textContent, 'the DEMANDED figure must reach no reader').not.toContain('99,999');
    expect(sum(rows.map((r) => r.amount))).toBe(11000);
    expect(amountBeside(SLIP.totalDeductions)).toBe(11000);
  });

  it('a LEGACY CLAMPED slip degrades to one lumped row rather than contradicting its own total', async () => {
    // No `cp38Applied` — every payslip issued before this round. All the slip knows is the demand, and the
    // demand does not fit inside its own other-deductions column, so the CP38 row is withheld.
    await renderExpanded(
      slip({ otherDeductions: '9748.35', totalDeductions: '11000.00', net: '0.00' }, { cp38: 99999 }),
    );
    const rows = deductionRows();
    expect(rows.map((r) => r.label), 'no CP38 row on a slip that cannot say what was taken').not.toContain(
      SLIP.cp38,
    );
    expect(rows.find((r) => r.label === SLIP.otherDeductions)!.amount, 'the money stays in one honest figure')
      .toBe(9748.35);
    expect(document.body.textContent).not.toContain('99,999');
    expect(sum(rows.map((r) => r.amount))).toBe(11000);
  });

  it('the named absence halves come OUT of the residual, beside the instalment', async () => {
    // Three claims on one column: 575 = 200 unpaid leave + 450 CP38 would not fit, so the measured shape is
    // widened — other_deductions 775 = 200 unpaid + 450 CP38 + 125 residual, total up by the same 200.
    await renderExpanded(
      slip(
        { otherDeductions: '775.00', totalDeductions: '2026.65', net: '8973.35' },
        { cp38: 450, cp38Applied: 450 },
        { unpaidLeave: { days: 2, amount: 200 } },
      ),
    );
    const rows = deductionRows();
    expect(rows.find((r) => r.label === SLIP.unpaidLeaveLine)!.amount).toBe(200);
    expect(rows.find((r) => r.label === SLIP.cp38)!.amount).toBe(450);
    expect(rows.find((r) => r.label === SLIP.otherDeductions)!.amount).toBe(125);
    expect(sum(rows.map((r) => r.amount))).toBe(2026.65);
    expect(amountBeside(SLIP.totalDeductions)).toBe(2026.65);
  });
});
