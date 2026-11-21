import {formatDmy} from '../lib/date-display';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { MovementNewEvent, type MovementCurrentValues } from '../app/admin/personnel/[employmentId]/movement-new-event';
import { EmploymentPeriodField } from '../components/employment-period-fields';
import { MOVEMENT_EMPLOYMENT_PERIODS } from '../lib/movement-employment-periods';
import { MOVEMENT_FORM_IDS } from '../lib/movement-form-contract';
import { personnelFormChoices, personnelFormLabel } from '../lib/personnel-form-contract';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import { todayInKualaLumpur } from '../lib/hr-date';
const actions = vi.hoisted(() => ({ createMovementEventAction: vi.fn(async (_data: FormData) => {}), editMovementEventAction: vi.fn(async (_data: FormData) => {}) }));
vi.mock('../app/admin/personnel/[employmentId]/actions', () => actions);
vi.mock('../components/derived-organisation-fields', () => ({ useDerivedOrganisation: () => ({ data: { status: 'legacy' }, loading: false, failed: false }), DerivedOrganisationFields: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const current: MovementCurrentValues = { companyId: 'fictional-company', companyName: 'Fictional Company', departmentId: 'fictional-department', positionId: null, businessUnitId: null, locationId: null, employmentType: 'full_time', gradeId: null, managerEmploymentId: null, basicSalary: '3000.00', currency: 'MYR', payMode: 'monthly', paymentTerm: 'monthly', orgDivision: null, employmentCategory: null, orgRegion: null, orgBranch: null, orgTeam: null, orgSection: null, orgLine: null, orgBase: null, probationValue: '3', probationUnit: 'month', noticeBeforeConfirmationValue: '1', noticeBeforeConfirmationUnit: 'month' };
const profileOptions = Object.fromEntries(PERSONNEL_FIELDS.filter(field => field.allowedValuesOwner?.startsWith('profile_option:')).map(field => [field.allowedValuesOwner!.slice(15), []]));
const base = { employmentId: 'fictional-employment', today: todayInKualaLumpur(), isBlacklisted: false, current, departments: [{ id: 'fictional-department', name: 'Fictional Department' }], positions: [], businessUnits: [], grades: [], locations: [], managers: [], employmentTypes: [{ value: 'full_time', label: 'Full time' }], profileOptions, terminationReasons: [], cancelHref: '/fictional-history', types: [{ code: 'promotion', label: null, behaviourKind: 'promotion' }] };
const provider = (child: React.ReactNode) => <NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>{child}</NextIntlClientProvider>;
const resolve = (key: string, fallback: string) => key.split('.').reduce<unknown>((value, segment) => (value as Record<string, unknown>)?.[segment], messages) as string || fallback;

describe('shared Employment and Movement period controls', () => {
  it('uses the Employment scalar limits and the same canonical unit choices for all four periods', () => {
    const { container } = render(provider(<MovementNewEvent {...base} />));
    for (const period of MOVEMENT_EMPLOYMENT_PERIODS) {
      const value = container.querySelector(`input[name="${period.value}"]`)!;
      const unit = container.querySelector(`select[name="${period.unit}"]`)!;
      expect(value).toHaveAttribute('min', '0');
      expect(value).toHaveAttribute('step', '1');
      expect(value).toHaveAttribute('data-personnel-field', MOVEMENT_FORM_IDS[period.value]);
      expect(Array.from(unit.querySelectorAll('option')).map(option => option.value)).toEqual(['', ...personnelFormChoices(MOVEMENT_FORM_IDS[period.unit]).map(option => option.value)]);
    }
    expect(container.querySelector('input[name="probationValue"]')).toHaveValue(3);
    expect(container.querySelector('select[name="probationUnit"]')).toHaveValue('month');
    expect(container.querySelector('select[name="extendedProbationUnit"]')).toHaveValue('');
    const label = personnelFormLabel(MOVEMENT_FORM_IDS.probationValue, resolve);
    expect(screen.getByRole('spinbutton', { name: label })).toBeInTheDocument();
  });

  it('shows Confirmation Date as the selected Effective Date on Confirmation itself', () => {
    const { container } = render(provider(<MovementNewEvent {...base} types={[{ code: 'confirmation', label: null, behaviourKind: 'confirmation' }]} />));
    expect(container.querySelector('[data-field="confirmationDate"]')).toHaveTextContent(formatDmy(todayInKualaLumpur()));
    expect(container.querySelector('[name="confirmationDate"]')).toBeNull();
    const effective = container.querySelector('input[name="effectiveDate"]')!;
    fireEvent.change(effective, { target: { value: '2026-01-01' } });
    expect(container.querySelector('[data-field="confirmationDate"]')).toHaveTextContent(formatDmy('2026-01-01'));
  });

  it('retains saved period inputs for a pending edit and omits untouched unrecorded defaults', async () => {
    const { container } = render(provider(<MovementNewEvent {...base} edit={{ movementId: 'fictional-pending', kind: 'promotion', effectiveDate: todayInKualaLumpur(), endDate: null, remarks: null, allowedKinds: ['promotion'], payrollWarning: false, pendingInput: { probationValue: '6', probationUnit: 'week' } }} />));
    expect(container.querySelector('input[name="probationValue"]')).toHaveValue(6);
    expect(container.querySelector('select[name="probationUnit"]')).toHaveValue('week');
    fireEvent.change(container.querySelector('input[name="reason"]')!, { target: { value: 'Correct fictional period record' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(actions.editMovementEventAction).toHaveBeenCalledOnce());
    const data = actions.editMovementEventAction.mock.calls[0][0];
    expect(data.get('probationValue')).toBe('6');
    expect(data.get('probationUnit')).toBe('week');
    expect(data.has('noticeBeforeConfirmationValue')).toBe(false);
    expect(data.has('extendedProbationUnit')).toBe(false);
  });

  it('keeps excluded or read-only period fields out of submissions', () => {
    const { container } = render(provider(<MovementNewEvent {...base} types={[{ ...base.types[0], rules: [
      { field: 'probationValue', included: false, editable: false, mustChange: false, document: 'none' },
      { field: 'probationUnit', included: true, editable: false, mustChange: false, document: 'none' },
    ] }]} />));
    expect(container.querySelector('[name="probationValue"]')).toBeNull();
    expect(container.querySelector('[name="probationUnit"]')).toBeNull();
    expect(screen.getByTestId('readonly-probationUnit')).toBeInTheDocument();
  });

  it('preserves the Employment form names, controlled draft transport and visible legacy defaults', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(provider(<EmploymentPeriodField mode="form" labelKey="probationPeriod" value={3} unit={null} valueName="probationValue" unitName="probationUnit" />));
    expect(container.querySelector('input[name="probationValue"]')).toHaveValue(3);
    expect(container.querySelector('select[name="probationUnit"]')).toHaveValue('month');
    rerender(provider(<EmploymentPeriodField mode="controlled" labelKey="probationPeriod" value="3" unit="month" onChange={onChange} />));
    expect(container.querySelector('[name]')).toBeNull();
    fireEvent.change(container.querySelector('select')!, { target: { value: 'week' } });
    expect(onChange).toHaveBeenCalledWith({ unit: 'week' });
  });
});
