import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { AccountTargetFields } from '../app/(app)/admin/users/account-target-fields';
afterEach(cleanup);
function show() {
  return render(<NextIntlClientProvider locale="en" messages={en}><form><AccountTargetFields idPrefix="manual" people={[{ id: 'person-a', name: 'Existing employee' }]} companies={[{ id: 'company-a', name: 'Acme' }]} roles={[{ value: 'employee', label: 'Employee' }, { value: 'hr_admin', label: 'HR admin' }]} /></form></NextIntlClientProvider>);
}
describe('explicit account target and role choice', () => {
  it('switches to named standalone creation with no employee selector or silently assigned role', () => {
    show(); expect(screen.getByRole('combobox', { name: 'Role' })).toHaveValue('employee');
    fireEvent.click(screen.getByRole('radio', { name: 'New user without an employee record' }));
    expect(screen.queryByRole('combobox', { name: 'Person' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Full name' })).toBeRequired();
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Role' })).toBeRequired();
    expect(screen.getByRole('combobox', { name: 'Company scope' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Company scope' })).toBeRequired();
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), { target: { value: 'External consultant' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), { target: { value: 'hr_admin' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Company scope' }), { target: { value: 'company-a' } });
    const submitted = new FormData(document.querySelector('form')!);
    expect(Object.fromEntries(submitted)).toMatchObject({ accountType: 'standalone', fullName: 'External consultant', role: 'hr_admin', companyId: 'company-a' });
    expect(submitted.has('personId')).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Existing person' }));
    expect(screen.queryByRole('textbox', { name: 'Full name' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Person' })).toBeRequired();
  });
});
