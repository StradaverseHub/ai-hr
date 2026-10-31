import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { HistoryGrid } from '../app/(app)/payroll/transaction-view/history-grid';
import { filterGridRows, pivotHistoryGrid } from '../app/(app)/payroll/transaction-view/history-pivot';
import { historyGridDisplayGroup, historyGridDisplayRows, historyGridLabelKey } from '../app/(app)/payroll/transaction-view/history-grid-presentation';
import { EpfElection } from '../components/epf-election';
import { clientPackFor } from '../localization/registry.client';
import { mapEpfUiMode } from '../lib/epf-mode-map';
import { resolveEpfElection } from '../localization/my/epf-election';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';
import messages from '../messages/en.json';

const displayRate = clientPackFor('MY')!.payroll.epfRateToPercent!;
const wrap = (ui: React.ReactNode) => <NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>;

function payroll(overtime = '50.00', detail = true): ProcessedPayslipViewRow {
  return {
    id: 'slip', employmentId: 'employee', employeeName: 'Example employee', employeeCode: 'E001',
    companyId: 'company', company: 'Example company', payPeriod: '2026-08', runType: 'regular',
    runSeq: 1, batchStatus: 'processed', releasedAt: null, version: 1,
    basic: '3000.00', allowance: '0.00', overtime, bonus: '0.00', gross: String(3000 + Number(overtime)),
    statutory: { epfEmployee: 330, ...(detail ? { componentLines: [
      { code: 'OT1_5', name: 'Overtime 1.5', amount: Number(overtime), buckets: [{ bucket: 'ot', amount: Number(overtime) }] },
    ] } : {}) },
    otherDeductions: '0.00', totalDeductions: '330.00', net: String(2670 + Number(overtime)),
  };
}

function renderGrid(rows = [payroll()]) {
  const grid = pivotHistoryGrid({ rows, year: 2026, months: [8] });
  render(wrap(<HistoryGrid {...grid} monthLabels={['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']}
    cycleLabels={{regular:'Monthly',bonus:'Bonus'}} exportParams={{}} />));
  return grid;
}

it('d670e4d6: Personnel uses the same precision-safe projection as other EPF field consumers', () => {
  const page = readFileSync('app/(app)/admin/personnel/[employmentId]/page.tsx', 'utf8');
  expect(page).toContain('employeeRate={countryPack?.client.payroll.epfRateToPercent?.(statutory?.epfEmployeeRate) ?? null}');
  expect(page).toContain('employerRate={countryPack?.client.payroll.epfRateToPercent?.(statutory?.epfEmployerRate) ?? null}');
});

it.each(['14','11','14.5','14.01'])('d670e4d6: %s remains exact in both rendered manual fields across repeated save/reopen', value => {
  let saved = resolveEpfElection(mapEpfUiMode('manual_percentage', value, value));
  for (let round = 0; round < 3; round++) {
    const {unmount,container} = render(wrap(<EpfElection mode={saved.epfMode}
      employeeRate={displayRate(saved.epfEmployeeRate)} employerRate={displayRate(saved.epfEmployerRate)}
      employeeAmount={null} employerAmount={null} manualReason={null} />));
    const employee = container.querySelector<HTMLInputElement>('input[name="epfEmployeeRate"]')!;
    const employer = container.querySelector<HTMLInputElement>('input[name="epfEmployerRate"]')!;
    expect(employee.value).toBe(value); expect(employer.value).toBe(value);
    expect(employee.checkValidity()).toBe(true); expect(employer.checkValidity()).toBe(true);
    saved = resolveEpfElection(mapEpfUiMode('manual_percentage', employee.value, employer.value));
    expect(saved.epfEmployeeRate).toBe((Number(value)/100).toFixed(4));
    expect(saved.epfEmployerRate).toBe((Number(value)/100).toFixed(4));
    unmount();
  }
});

it('d670e4d6: Semi-Auto preserves employee precision and the statutory employer election', () => {
  const saved = resolveEpfElection(mapEpfUiMode('semi_auto','14.01',null));
  const {container} = render(wrap(<EpfElection mode={saved.epfMode} employeeRate={displayRate(saved.epfEmployeeRate)}
    employerRate={displayRate(saved.epfEmployerRate)} employeeAmount={null} employerAmount={null} manualReason={null}/>));
  expect(container.querySelector<HTMLInputElement>('input[name="epfEmployeeRate"]')!.value).toBe('14.01');
  expect(container.querySelector('input[name="epfEmployerRate"]')).toBeNull();
  expect(saved.epfEmployerRate).toBeNull();
});

describe('08f3b57c: overtime placement', () => {
  it('renders one stored total under Summary while keeping rate detail in Earnings and values unchanged', () => {
    const grid = renderGrid();
    const bodyRows = Array.from(document.querySelectorAll('tbody tr'));
    const summary = screen.getByText('Summary').closest('tr')!;
    const total = screen.getByText('Total Overtime').closest('tr')!;
    const detail = screen.getByText('Overtime 1.5').closest('tr')!;
    expect(bodyRows.indexOf(detail)).toBeLessThan(bodyRows.indexOf(summary));
    expect(bodyRows.indexOf(total)).toBeGreaterThan(bodyRows.indexOf(summary));
    expect(screen.getAllByText('Total Overtime')).toHaveLength(1);
    expect(within(total).getAllByText('50.00')).toHaveLength(2);
    expect(within(detail).getAllByText('50.00')).toHaveLength(2);
    expect(screen.getByText('Already included in gross pay')).toBeVisible();
    expect(grid.rows.filter(r=>r.group==='earning'&&r.reconciling).reduce((n,r)=>n+r.months[7],0)).toBe(3050);
    const stored=grid.rows.find(r=>r.labelKey==='overtime')!;
    expect(stored.group).toBe('earning'); expect(stored.reconciling).toBe(true);
    const exported=historyGridDisplayRows(filterGridRows(grid.rows,{hideZero:true,hideSystem:false}));
    expect(exported.find(r=>historyGridLabelKey(r)==='totalOvertime')).toBe(stored);
    expect(historyGridDisplayGroup(stored)).toBe('summary');
    expect(exported.indexOf(stored)).toBeGreaterThan(exported.findIndex(r=>r.code==='OT1_5'));
  });
  it('retains both rate details when they total RM50 and hides a zero total under the existing zero filter', () => {
    const row=payroll();
    row.statutory={epfEmployee:330,componentLines:[
      {code:'OT1_5',name:'Overtime 1.5',amount:20,buckets:[{bucket:'ot',amount:20}]},
      {code:'OT2_0',name:'Overtime 2.0',amount:30,buckets:[{bucket:'ot',amount:30}]},
    ]};
    renderGrid([row]);
    expect(within(screen.getByText('Overtime 1.5').closest('tr')!).getAllByText('20.00')).toHaveLength(2);
    expect(within(screen.getByText('Overtime 2.0').closest('tr')!).getAllByText('30.00')).toHaveLength(2);
    expect(within(screen.getByText('Total Overtime').closest('tr')!).getAllByText('50.00')).toHaveLength(2);
    const zero=pivotHistoryGrid({rows:[payroll('0.00',false)],year:2026,months:[8]});
    expect(filterGridRows(zero.rows,{hideZero:true,hideSystem:false}).some(r=>r.labelKey==='overtime')).toBe(false);
  });
  it('keeps the stored monthly values and annual overtime total through display sorting', () => {
    const grid=pivotHistoryGrid({rows:[payroll(),{...payroll('25.00'),id:'september',payPeriod:'2026-09'}],year:2026,months:[8,9]});
    const row=historyGridDisplayRows(filterGridRows(grid.rows,{hideZero:true,hideSystem:false})).find(r=>historyGridLabelKey(r)==='totalOvertime')!;
    expect(row.months.slice(7,9)).toEqual([50,25]);expect(row.total).toBe(75);
  });
  it('keeps legacy totals without item detail and respects hide-system', async () => {
    renderGrid([payroll('50.00',false)]);
    expect(screen.getByText('Total Overtime')).toBeVisible();
    await userEvent.click(screen.getByLabelText(/hide system codes/i));
    expect(screen.queryByText('Total Overtime')).toBeNull();
  });
  it('retains distinct employers and cycles, and preserves original row values and ordering input', () => {
    const grid=pivotHistoryGrid({rows:[payroll(),{...payroll('25.00'),id:'second',companyId:'other',company:'Other company',runType:'bonus'}],year:2026,months:[8]});
    const before=JSON.stringify(grid.rows);
    const displayed=historyGridDisplayRows(grid.rows);
    expect(JSON.stringify(grid.rows)).toBe(before);
    const totals=displayed.filter(r=>historyGridLabelKey(r)==='totalOvertime');
    expect(totals).toHaveLength(2);
    expect(totals.map(r=>r.total).sort((a,b)=>a-b)).toEqual([25,50]);
    expect(totals.map(r=>r.companyId).sort()).toEqual(['company','other']);
    expect(totals.map(r=>r.runType).sort()).toEqual(['bonus','regular']);
  });
});
