import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const { list, options, cookie } = vi.hoisted(() => ({ list: vi.fn(), options: vi.fn(), cookie: vi.fn() }));
// Server page markup is rendered outside Next's router; keep real anchor semantics.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('../lib/scope', () => ({ scopedAdmin: async () => ({ s: {}, scopeIds: ['company'] }) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookie }) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => createTranslator({ locale: 'en', messages: { attendanceHistory: en.attendanceHistory }, namespace: 'attendanceHistory', onError: error => { throw error; } }) }));
vi.mock('../packs/attendance/service', () => ({ listAttendanceApplicationHistory: list, attendanceApplicationFilterOptions: options }));
vi.mock('../components/attendance-history-table', () => ({ AttendanceHistoryTable: ({ returnTo }: { returnTo: string }) => <a href={`/detail?returnTo=${encodeURIComponent(returnTo)}`}>Saved context</a> }));
// The Offline punches tab (draft 0647) reads the database; without the draft it is absent, which this suite pins.
// Its own rendering is covered by test/offline-claims-review.dom.test.tsx.
const offline = vi.hoisted(() => ({ count: null as number | null }));
vi.mock('../app/(app)/attendance/application-history/offline-data', () => ({ offlineReviewTabCount: async () => offline.count, loadOfflineReview: vi.fn() }));
vi.mock('../app/(app)/attendance/application-history/offline-review', () => ({ OfflineClaimsReview: () => null }));
import Page from '../app/(app)/attendance/application-history/page';
beforeEach(() => {
  vi.clearAllMocks(); cookie.mockReturnValue(undefined); offline.count = null;
  list.mockResolvedValue({ rows: [], total: 3, page: 1, pageSize: 25, counts: { pending: 3, approved: 5, rejected: 2, cancelled: 1, withdrawn: 2, cancelledWithdrawn: 3, all: 13 } });
  options.mockResolvedValue({ employees: [{ id: 'employee', name: 'Fictional worker', employeeCode: '0007', companyId: 'company', company: 'Fictional company', departmentId: null, department: null, businessUnitId: null, businessUnit: null, terminatedOn: null }], companies: [], departments: [], businessUnits: [], grades: [], divisions: [] });
});
afterEach(cleanup);
async function show(query: Record<string, string> = {}) { render(<NextIntlClientProvider locale="en" messages={en}>{await Page({ searchParams: Promise.resolve(query) })}</NextIntlClientProvider>); }
it('defaults to Pending and All Employees, with extra filters hidden and counts on every requested tab', async () => {
  await show();
  expect(list).toHaveBeenCalledWith({}, ['company'], expect.objectContaining({ status: 'pending' }));
  expect(screen.getByRole('button', { name: /All employees/i })).toHaveAttribute('aria-current', 'true');
  expect(screen.queryByRole('combobox', { name: en.attendanceHistory.selectEmployeeLabel })).toBeNull();
  expect(screen.getByRole('link', { name: 'Pending 3' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Approved 5' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'Cancelled / Withdrawn 3' })).toBeVisible();
  expect(screen.queryByRole('textbox', { name: en.attendanceHistory.search })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: en.attendanceHistory.showFilters }));
  expect(screen.getByRole('textbox', { name: en.attendanceHistory.search })).toBeVisible();
});
it('collapsed filters remain in the submitted form, tabs and detail return context', async () => {
  await show({ employmentId: 'employee', query: 'needle', departmentId: 'department', status: 'approved', submittedFrom: '2024-01-01', pageSize: '100' });
  const form = document.querySelector('form')!;
  expect(new FormData(form).get('query')).toBe('needle');
  expect(new FormData(form).get('status')).toBe('approved');
  const next = new URL(screen.getByRole('link', { name: 'Rejected 2' }).getAttribute('href')!, 'http://localhost');
  expect(next.searchParams.get('employmentId')).toBe('employee'); expect(next.searchParams.get('query')).toBe('needle');
  expect(next.searchParams.get('submittedFrom')).toBe('2024-01-01'); expect(next.searchParams.get('pageSize')).toBe('100');
  expect(next.searchParams.get('page')).toBe('1');
  const detail = new URL(screen.getByRole('link', { name: 'Saved context' }).getAttribute('href')!, 'http://localhost');
  expect(detail.searchParams.get('returnTo')).toContain('status=approved');
  expect(detail.searchParams.get('returnTo')).toContain('query=needle');
});

it('hides the employee list independently while retaining picker and unsaved application filters', async () => {
  await show({ employmentId: 'employee', page: '2' });
  fireEvent.click(screen.getByRole('button', { name: en.attendanceHistory.showFilters }));
  const query = screen.getByRole('textbox', { name: en.attendanceHistory.search });
  fireEvent.change(query, { target: { value: 'unsaved request search' } });
  const picker = screen.getByRole('searchbox');
  fireEvent.change(picker, { target: { value: 'Fictional' } });
  // Both responsive controls operate the same mounted picker. Its state survives each toggle.
  fireEvent.click(screen.getAllByRole('button', { name: en.employeePanel.hideEmployees })[0]);
  expect(query).toBeVisible();
  expect(new FormData(document.querySelector('form')!).get('employmentId')).toBe('employee');
  fireEvent.click(screen.getAllByRole('button', { name: en.employeePanel.showEmployees })[0]);
  expect(screen.getByRole('searchbox')).toHaveValue('Fictional');
  expect(query).toHaveValue('unsaved request search');
});

it('shows no Offline punches tab without draft 0647, and the tab with its count when it is installed', async () => {
  await show();
  expect(screen.queryByRole('link', { name: /Offline punches/ })).toBeNull();
  cleanup(); offline.count = 4;
  await show({ status: 'approved' });
  const tab = screen.getByRole('link', { name: en.attendanceHistory.offline.tab.replace('{count}', '4') });
  expect(tab).toHaveAttribute('href', '/attendance/application-history?view=offline');
  expect(tab).not.toHaveAttribute('aria-current');
  // The status tabs never carry the offline view's own keys.
  expect(new URL(screen.getByRole('link', { name: 'Pending 3' }).getAttribute('href')!, 'http://localhost').searchParams.get('view')).toBeNull();
});
