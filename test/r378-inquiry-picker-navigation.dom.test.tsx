import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { EmployeeScopePanel } from '../components/collapsible-employee-panel';
import { InquiryTabLink } from '../components/leave/inquiry-tab-link';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({push}),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

function Surface() {
  return <NextIntlClientProvider locale="en" messages={messages}>
    <EmployeeScopePanel basePath="/leave/employee-balances" selectedId="employment-selected" selectParam="emp" preservePicker preserve={{q:'ANNUAL',pickerQ:'old'}} employees={[
      {employmentId:'employment-selected',name:'Fixture employee',employeeCode:'FX',company:'Fixture company',companyId:'company',department:'Fixture department',departmentId:'department',businessUnit:'Fixture unit',businessUnitId:'unit',status:'active'},
    ]} />
    <InquiryTabLink href="/leave/employee-records?emp=employment-selected&q=ANNUAL&type=leave-type&pickerQ=old">Records</InquiryTabLink>
  </NextIntlClientProvider>;
}

describe('inquiry picker navigation without reselecting', () => {
  beforeEach(() => {
    push.mockClear();
    window.history.replaceState(null,'','/leave/employee-balances?emp=employment-selected&q=ANNUAL&type=leave-type&pickerQ=old');
  });
  it('carries current controls to the other tab while preserving selected employee and leave filters', () => {
    const view=render(<Surface />);
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'current search'}});
    fireEvent.change(screen.getByRole('combobox',{name:messages.employeePanel.filterCompany}),{target:{value:'company'}});
    fireEvent.change(screen.getByRole('combobox',{name:messages.employeePanel.filterBusinessUnit}),{target:{value:'unit'}});
    fireEvent.change(screen.getByRole('combobox',{name:messages.employeePanel.filterDepartment}),{target:{value:'department'}});
    fireEvent.change(screen.getByRole('combobox',{name:messages.employeePanel.filterStatus}),{target:{value:'active'}});
    // Next's replaceState integration rerenders useSearchParams consumers; reproduce that update in jsdom.
    view.rerender(<Surface />);
    const url=new URL(screen.getByRole('link',{name:'Records'}).getAttribute('href')!,window.location.origin);
    expect(url.pathname).toBe('/leave/employee-records');
    expect(Object.fromEntries(url.searchParams)).toEqual({emp:'employment-selected',q:'ANNUAL',type:'leave-type',pickerQ:'current search',pickerCompany:'company',pickerBusinessUnit:'unit',pickerDepartment:'department',pickerStatus:'active'});
    expect(push).not.toHaveBeenCalled();
    view.unmount();
    render(<Surface />);
    expect(screen.getByRole('searchbox')).toHaveValue('current search');
    expect(screen.getByRole('combobox',{name:messages.employeePanel.filterCompany})).toHaveValue('company');
  });
  it('reset clears current picker keys on the tab link instead of resurrecting server props', () => {
    const view=render(<Surface />);
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'current search'}});
    fireEvent.click(screen.getByRole('button',{name:messages.employeePanel.reset}));
    view.rerender(<Surface />);
    expect(screen.getByRole('link',{name:'Records'})).toHaveAttribute('href','/leave/employee-records?emp=employment-selected&q=ANNUAL&type=leave-type');
    expect(push).not.toHaveBeenCalled();
  });
});
