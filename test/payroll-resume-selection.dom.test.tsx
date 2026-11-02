import React, { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ resume: vi.fn(), employees: vi.fn() }));
vi.mock('../app/payroll/process/actions', () => ({ resumeRunAction: calls.resume, fetchPayrollRunEmployees: calls.employees, runMultiCompanyAction: vi.fn(), savePayrollDraftsAction: vi.fn() }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('../components/ui', () => ({
 Button: ({ children, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props}>{children}</button>,
 Card: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
 Field: ({ children, label }: React.PropsWithChildren<{ label: string }>) => <label>{label}{children}</label>,
 EmployeeCode: ({ code }: { code: string | null }) => <span>{code}</span>, inputCls: '',
}));
vi.mock('../app/payroll/process/steps/step-validation', () => ({ StepValidation: ({ onStatusChange }: { onStatusChange: (status: { loading: boolean; hasBlockers: boolean }) => void }) => { useEffect(() => onStatusChange({ loading: false, hasBlockers: false }), [onStatusChange]); return <p>Validation ready</p>; } }));
import { Wizard } from '../app/payroll/process/wizard';
const props: React.ComponentProps<typeof Wizard> = {
 companies: [{ id: 'company-a', name: 'A' }], departments: [], businessUnits: [], positions: [], costCenters: [], jobGrades: [], payDayByCompany: {}, existingRuns: [], cyclesByCompany: {}, defaultCycleByCompany: {}, thisMonth: '2026-05', multiCycle: false,
 resumeBatch: { id: 'draft-a', companyId: 'company-a', payPeriod: '2026-05', cycle: 'regular', paymentDate: '2026-05-25', remarks: '', scope: null },
};
beforeEach(() => { calls.resume.mockReset(); calls.employees.mockResolvedValue([{ employmentId: 'own', name: 'Own employee', employeeCode: 'EMP-1', companyId: 'company-a', company: 'A', departmentId: null, businessUnitId: null, positionId: null, gradeId: null, costCenterId: null, employmentType: 'full_time', status: 'active', hiredOn: '2026-01-01', terminatedOn: null, hasCurrentCompensation: true, payrollPolicyName: null }]); });
afterEach(cleanup);
it('the real selection control blocks Continue after Clear All, and Select All restores a usable selection', async () => {
 render(<Wizard {...props} />);
 fireEvent.click(screen.getByText('continue'));
 await screen.findByText('Own employee');
 fireEvent.click(screen.getByText('clearAll'));
 expect(screen.getByText('continue')).toBeDisabled();
 fireEvent.click(screen.getByText('continue'));
 expect(calls.resume).not.toHaveBeenCalled();
 fireEvent.click(screen.getByText('selectAll'));
 expect(screen.getByText('continue')).not.toBeDisabled();
 fireEvent.click(screen.getByText('continue'));
 await screen.findByText('Validation ready');
 fireEvent.click(screen.getByText('processPayroll'));
 await waitFor(() => expect(calls.resume).toHaveBeenCalledTimes(1));
 const posted = calls.resume.mock.calls[0][0] as FormData;
 expect(posted.get('filtersTouched')).toBe('true');
 expect(posted.getAll('employmentIds')).toEqual(['own']);
});
