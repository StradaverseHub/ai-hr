import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { AttendanceFormulaEditor } from '../app/admin/attendance/settings/formula-builder/editor';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';

const mocks = vi.hoisted(() => ({ push: vi.fn(), save: vi.fn(), test: vi.fn(), activate: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../app/admin/attendance/settings/formula-builder/actions', () => ({
  draftAttendanceFormulaAction: vi.fn(),
  saveAttendanceFormulaAction: mocks.save,
  testAttendanceFormulaAction: mocks.test,
  activateAttendanceFormulaAction: mocks.activate,
  statusAttendanceFormulaAction: vi.fn(),
  readAttendanceFormulaTestAction: vi.fn(),
  searchAttendanceFormulaEmployeesAction: vi.fn(),
}));
vi.mock('../app/admin/attendance-allowance/actions', () => ({
  searchAllowanceEmployees: vi.fn(),
  searchAllowanceEmployeeValues: vi.fn(),
}));

const catalogs = { en, ms, zh, ta, th, vi: viMessages };
const companyId = '10000000-0000-4000-8000-000000000001';
const payItemId = '20000000-0000-4000-8000-000000000001';
const options = {
  companies: [{ id: companyId, label: 'Fictional company', currency: 'MYR' }],
  payItems: [{ id: payItemId, code: 'OVERTIME', name: 'Overtime', kind: 'allowance' as const, companyIds: [companyId] }],
};
const t = en.attendanceFormula;
type Saved = React.ComponentProps<typeof AttendanceFormulaEditor>['initial'];
function mount(locale: keyof typeof catalogs = 'en', initial: Saved = null, referenceKey?: string) {
  const errors: unknown[] = [];
  render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]} onError={error => errors.push(error)}>
    <AttendanceFormulaEditor initial={initial} options={options} today="2026-11-09" referenceKey={referenceKey} />
  </NextIntlClientProvider>);
  return errors;
}

function copyNormalDay() {
  fireEvent.click(screen.getByRole('button', { name: t.references }));
  const details = screen.getByText('MY_NORMAL_DAY_OT_15').closest('details')!;
  details.open = true;
  expect(within(details).getByText(/21\.63/)).toBeTruthy();
  fireEvent.click(within(details).getByRole('button', { name: t.malaysiaReference.copy }));
}
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('renders statutory references and translations in %s', locale => {
  const errors = mount(locale);
  const labels = catalogs[locale].attendanceFormula;
  fireEvent.click(screen.getByRole('button', { name: labels.references }));
  expect(screen.getByRole('heading', { name: labels.malaysiaReference.title })).toBeTruthy();
  expect(screen.getByText('MY_PAID_HOLIDAY_PIECES')).toBeTruthy();
  expect(errors).toEqual([]);
});

it('copies the expression and named input slots into an unsaved draft, with no fictional Pay Item or test', () => {
  mount();
  copyNormalDay();
  expect(screen.getByLabelText(t.code)).toHaveValue('MY_NORMAL_DAY_OT_15');
  expect(screen.getByLabelText(t.payItem)).toHaveValue('');
  expect((screen.getByRole('textbox', { name: t.formulaExpression }) as HTMLTextAreaElement).value).toContain('MY_EXCESS_HOURS');
  expect(screen.getByRole('button', { name: t.save })).toBeDisabled();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.test).not.toHaveBeenCalled();
  expect(mocks.activate).not.toHaveBeenCalled();
});

it('opens a new draft from a saved formula and leaves its saved identity untouched', () => {
  const id = '30000000-0000-4000-8000-000000000001';
  const tenantId = '50000000-0000-4000-8000-000000000001';
  const createdBy = '60000000-0000-4000-8000-000000000001';
  const createdAt = new Date('2026-11-09T00:00:00Z');
  const initial: NonNullable<Saved> = {
    formula: { id, companyId, code: 'EXISTING', tenantId, createdBy, createdAt },
    latest: {
      id: '40000000-0000-4000-8000-000000000001',
      ordinal: 1, tenantId, companyId, formulaId: id, payComponentId: payItemId, createdBy, createdAt,
      registryVersion: 'test', evaluatorVersion: 'test', contentHash: 'fixture',
      readRequirements: { financial: false, workforce: false },
      definition: {
        code: 'EXISTING', description: 'Existing formula', companyId, payItemId, effectiveFrom: '2026-11-09',
        period: { method: 'daily' }, outputUnit: 'amount', purpose: 'earning',
        eligibility: { mode: 'all' }, posting: { kind: 'exclusive' },
        library: { formulas: [{ code: 'EXISTING', source: 'Return 1' }], conditions: [] },
      },
    },
    versions: [], tests: [], events: [], status: 'inactive', activeRevisionId: null, activeOrdinal: null,
  };
  mount('en', initial);
  copyNormalDay();
  expect(mocks.push).toHaveBeenCalledWith('/admin/attendance/settings/formula-builder/new?reference=MY_NORMAL_DAY_OT_15');
  expect(screen.getByLabelText(t.code)).toHaveValue('EXISTING');
  expect(mocks.save).not.toHaveBeenCalled();
  cleanup();
  mount('en', null, 'MY_NORMAL_DAY_OT_15');
  expect(screen.getByLabelText(t.code)).toHaveValue('MY_NORMAL_DAY_OT_15');
  expect(screen.getByRole('button', { name: t.save })).toBeDisabled();
});
