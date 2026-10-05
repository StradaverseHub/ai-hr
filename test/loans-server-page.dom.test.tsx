import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';
import { LoanList } from '../components/loan-list';
import { AppliedInPayrollList } from '../components/applied-in-payroll-list';
import { EmployeeScopePanel } from '../components/collapsible-employee-panel';
import { pageState, parsePageQuery } from '../lib/pagination';
import type { LoanRow } from '../core/loans';
const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), query: 'page=1&aPage=1&employmentId=selected' }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams(nav.query) }));
const view = (child: ReactNode) => <NextIntlClientProvider locale="en" messages={messages}>{child}</NextIntlClientProvider>;
const wrap = (child: ReactNode) => render(view(child));
const state = pageState(parsePageQuery({ page: '1' }), 31, 6);
const row = (n: number): LoanRow => ({ id: `loan-${n}`, employmentId: `emp-${n}`, employeeName: `Worker ${n}`, employeeCode: `E${n}`, loanType: 'personal', principal: n, interestRate: 0, interestMethod: 'none', durationMonths: 1, startDate: '2026-01-01', monthlyInstalment: n, totalRepayable: n, outstandingBalance: n, instalmentsPaid: 0, status: 'active', notes: null, createdAt: '2026-01-01T00:00:00Z' });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('Loans server table controls', () => {
  it('renders the second server page without slicing it again, preserving full counts and links', () => {
    wrap(<LoanList loans={Array.from({ length: 6 }, (_, i) => row(i + 26))} serverPage={{ state, query: '', sort: 'employee', dir: 'asc' }} />);
    expect(screen.getByText('Worker 26')).toBeTruthy(); expect(screen.getByText('Worker 31')).toBeTruthy();
    expect(screen.getByText(/26–31 of 31/)).toBeTruthy();
    expect(screen.getAllByRole('link')[0].getAttribute('href')).toBe('/admin/loans/loan-26?employmentId=emp-26');
  });
  it('sends search and sort to the server, resets only its page and retains employee/other table scope', async () => {
    vi.useFakeTimers();
    wrap(<LoanList loans={[row(26)]} serverPage={{ state, query: '', sort: 'employee', dir: 'asc' }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Worker 30' } });
    await act(async () => { vi.advanceTimersByTime(350); });
    const searched = new URLSearchParams(nav.replace.mock.calls[0][0].slice(1));
    expect(searched.get('q')).toBe('Worker 30'); expect(searched.has('page')).toBe(false);
    expect(searched.get('aPage')).toBe('1'); expect(searched.get('employmentId')).toBe('selected');
    fireEvent.click(screen.getByRole('button', { name: messages.loans.colPrincipal }));
    const sorted = new URLSearchParams(nav.replace.mock.calls.at(-1)![0].slice(1));
    expect(sorted.get('sort')).toBe('principal'); expect(sorted.get('dir')).toBe('desc'); expect(sorted.get('q')).toBe('Worker 30');
  });
  it('retains a newer draft when an older search response arrives, while clean history navigation still works', async () => {
    vi.useFakeTimers();
    const table = (query: string) => <LoanList loans={[row(26)]} serverPage={{ state, query, sort: 'employee', dir: 'asc' }} />;
    const rendered = wrap(table(''));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Ali' } });
    await act(async () => { vi.advanceTimersByTime(350); });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Alice' } });
    rendered.rerender(view(table('Ali'))); // previous response finishes after the new edit
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Alice');
    await act(async () => { vi.advanceTimersByTime(350); });
    expect(new URLSearchParams(nav.replace.mock.calls.at(-1)![0].slice(1)).get('q')).toBe('Alice');
    rendered.rerender(view(table('Alice')));
    rendered.rerender(view(table('Ali'))); // Back after the latest response, with no unsent edit
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Ali');
  });
  it('applied history also renders an intact second page and navigates only its own pagination', () => {
    wrap(<AppliedInPayrollList rows={[{ id: 'applied-26', payPeriod: '2026-05', cycleLabel: 'Monthly', employeeName: 'Applied Worker', employeeCode: 'E26', company: 'Acme', amount: '40.00', statusLabel: 'Processed', createdOn: '2026-05-25 00:00:00' }]} emptyLabel="Empty" paramNames={{ page: 'aPage', size: 'aSize' }} serverPage={{ state: { ...state, to: 26 }, query: '', sort: 'payPeriod', dir: 'desc' }} />);
    expect(screen.getByText('Applied Worker')).toBeTruthy(); expect(screen.getByText('RM 40.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: messages.appliedInPayroll.colAmount }));
    const sorted = new URLSearchParams(nav.replace.mock.calls.at(-1)![0].slice(1));
    expect(sorted.get('aSort')).toBe('amount'); expect(sorted.has('aPage')).toBe(false); expect(sorted.get('page')).toBe('1');
  });
  it('distinguishes a server search with no matches from an empty applied history', () => {
    wrap(<AppliedInPayrollList rows={[]} emptyLabel="No applied history" serverPage={{ state: pageState(parsePageQuery(), 0, 0), query: 'unmatched', sort: 'payPeriod', dir: 'desc' }} />);
    expect(screen.getByText(messages.appliedInPayroll.noMatches)).toBeTruthy();
    expect(screen.queryByText('No applied history')).toBeNull();
  });
  it('employee search navigates rather than filtering only the initial result page', async () => {
    vi.useFakeTimers(); window.history.replaceState({}, '', '/admin/loans?page=1');
    const panel = (query: string) => <EmployeeScopePanel employees={[{ employmentId: 'emp-1', name: 'First Worker', employeeCode: 'E1', company: 'Acme', companyId: 'c1', department: null, departmentId: null, businessUnit: null, businessUnitId: null, status: 'active' }]} selectedId={null} basePath="/admin/loans" serverResults={{ query, companyId: '', departmentId: '', businessUnitId: '', status: '', total: 31, companies: [{ id: 'c1', name: 'Acme' }], departments: [], businessUnits: [] }} />;
    const rendered = wrap(panel(''));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Worker 3' } });
    await act(async () => { vi.advanceTimersByTime(350); });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Worker 30' } });
    rendered.rerender(view(panel('Worker 3')));
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Worker 30');
    // Current authorized page remains until the server returns the new matching page.
    expect(screen.getByText('First Worker')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(350); });
    const url = new URL(nav.replace.mock.calls.at(-1)![0], 'http://localhost');
    expect(url.pathname).toBe('/admin/loans'); expect(url.searchParams.get('pickerQ')).toBe('Worker 30');
  });
});
