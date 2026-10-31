import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import { PERSONNEL_FIELDS } from '../lib/personnel-field-registry';
import { defaultMasterColumn, runEmployeeMasterProjection, type EmployeeMasterSpec } from '../lib/employee-master-report';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { MasterTemplate } from '../core/employee-master-reports';

const { preview, save, router, language } = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), router: { push: vi.fn(), refresh: vi.fn() }, language: { current: 'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi' } }));
const catalogues = { en, ms, zh, ta, th, vi: viMessages };
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: language.current, messages: catalogues[language.current], namespace: namespace as never, onError: error => { throw error; } }) }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('../app/(app)/reports/employee-master/actions', () => ({ previewEmployeeMaster: preview, saveEmployeeMaster: save }));
vi.mock('../app/(app)/reports/employee-master/MasterReportActions', () => ({ MasterReportActions: () => null }));
import { EmployeeMasterBuilder } from '../app/(app)/reports/employee-master/EmployeeMasterBuilder';
import { MasterReportList } from '../app/(app)/reports/employee-master/MasterReportList';

const code = PERSONNEL_FIELDS.find(field => field.owner === 'employment' && field.ownerField === 'employeeCode')!;
const hire = PERSONNEL_FIELDS.find(field => field.owner === 'employment' && field.ownerField === 'hiredOn')!;
const salary = PERSONNEL_FIELDS.find(field => field.owner === 'compensation' && field.ownerField === 'basicSalary')!;
const fields = [code, hire, salary], today = todayInKualaLumpur(), company = '00000000-0000-4000-8000-000000000001';
const initial: EmployeeMasterSpec = { v: 2, asAt: today, companyIds: [company], includeDrafts: false, columns: fields.map(defaultMasterColumn), expression: { id: 'root', type: 'group', logic: 'and', children: [] }, sorts: [], groups: [], pdf: { paper: 'A4', orientation: 'landscape', margins: 'normal', logo: false, pageBreakGroups: false } };
function builder(locale: keyof typeof catalogues, reportId: string|null = null, version: number|null = null) {
 return render(<NextIntlClientProvider locale={locale} timeZone="Asia/Kuala_Lumpur" messages={catalogues[locale]} onError={error => { throw error; }}><EmployeeMasterBuilder initial={initial} fields={fields} companies={[{ value: company, label: 'Fictional company' }]} options={{}} roles={[]} reportId={reportId} version={version} today={today}/></NextIntlClientProvider>);
}
beforeEach(() => {
 vi.useFakeTimers(); language.current = 'en';
 save.mockResolvedValue({ ok: true, id: '00000000-0000-4000-8000-000000000009', version: 2 });
 preview.mockImplementation(async (spec: EmployeeMasterSpec) => ({ ok: true, snapshotToken: 'fictional-preview-token', result: runEmployeeMasterProjection(spec, fields, [{ id: 'employment', kind: 'employment', personId: 'person', companyId: company, owners: { employment: [{ id: 'employment', values: { employeeCode: { value: '000007' }, hiredOn: { value: '2024-01-02' } } }], compensation: [{ id: 'salary', currency: 'MYR', values: { basicSalary: { value: '4321.25', currency: 'MYR' } } }] } }], today) }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('Employee Master display and optional PDF controls', () => {
 it('uses selected decimals for actual preview cells, subtotal and grand total while Text remains raw', async () => {
  builder('en'); fireEvent.click(screen.getByRole('button', { name: /^3.*Basic salary/ }));
  fireEvent.change(screen.getByLabelText(en.employeeMasterReports.decimals), { target: { value: '3' } });
  fireEvent.click(screen.getByLabelText(en.employeeMasterReports.sum));
  fireEvent.change(screen.getByLabelText('Group 1'), { target: { value: code.id } });
  await act(async () => { await vi.advanceTimersByTimeAsync(550); });
  expect(screen.getByRole('cell', { name: '4321.250' })).toBeVisible();
  expect(screen.getAllByText(/MYR 4321\.250$/)).toHaveLength(2);
  fireEvent.change(screen.getByLabelText(en.employeeMasterReports.format), { target: { value: 'text' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(550); });
  expect(screen.getByRole('cell', { name: '4321.25' })).toBeVisible();
 });
 it.each([[null,null],['00000000-0000-4000-8000-000000000009',1]] as const)('returns a successful new or updated report to its Master card (%s)', async (id, version) => {
  builder('en', id, version);
  fireEvent.change(screen.getByLabelText(en.employeeMasterReports.name), { target: { value: 'Fictional saved result' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.employeeMasterReports.save })); });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: id??undefined, version: version??undefined, name: 'Fictional saved result' }));
  expect(router.push).toHaveBeenCalledWith('/reports?cat=master&saved=00000000-0000-4000-8000-000000000009');
  expect(router.refresh).toHaveBeenCalledTimes(1);
 });
 it('keeps a rejected save in the builder without a misleading success destination', async () => {
  save.mockResolvedValue({ ok: false, error: 'The saved version changed. Reopen the report.' }); builder('en');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.employeeMasterReports.save })); });
  expect(screen.getByRole('alert')).toHaveTextContent('The saved version changed. Reopen the report.'); expect(router.push).not.toHaveBeenCalled();
 });
 it.each(['en','ms','zh','ta','th','vi'] as const)('keeps PDF settings collapsed until its native disclosure is opened in %s', locale => {
  builder(locale); const copy = catalogues[locale].employeeMasterReports;
  const summary = screen.getByText(copy.pdfSettings), disclosure = summary.closest('details');
  expect(summary.tagName).toBe('SUMMARY'); expect(disclosure).not.toBeNull(); expect(disclosure).not.toHaveAttribute('open');
  const paper = screen.getByLabelText(copy.paper); expect(paper).not.toBeVisible();
  fireEvent.click(summary); expect(disclosure).toHaveAttribute('open'); expect(paper).toBeVisible();
  fireEvent.change(paper, { target: { value: 'A3' } }); fireEvent.click(summary); expect(disclosure).not.toHaveAttribute('open');
  fireEvent.click(summary); expect(paper).toHaveValue('A3'); // Hiding options must not reset a chosen setting.
 });
 it('shows full dates as DD/MM/YYYY in the actual preview and honours explicit Text without changing the owner value', async () => {
  builder('en'); await act(async () => { await vi.advanceTimersByTimeAsync(550); });
  expect(screen.getByRole('cell', { name: '02/01/2024' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /^2.*Group Join Date/ }));
  fireEvent.change(screen.getByLabelText(en.employeeMasterReports.format), { target: { value: 'text' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(550); });
  expect(screen.getByRole('cell', { name: '2024-01-02' })).toBeVisible();
  expect(screen.getByRole('cell', { name: '000007' })).toBeVisible();
 });
 it('keeps a long saved description on one line while retaining its full text', async () => {
  const description = 'Fictional report description with enough detail to exceed a narrow card without hiding the full saved explanation.';
  const report: MasterTemplate = { id: '00000000-0000-4000-8000-000000000002', name: 'Fictional saved report', description, ownerUserId: null, ownerName: 'Fictional owner', shared: false, sharedRoleIds: [], version: 1, lastRunAt: null, scheduleEnabled: false, updatedAt: new Date().toISOString(), spec: initial, canEdit: true };
  render(await MasterReportList({ reports: [report] }));
  const text = screen.getByText(description); expect(text).toHaveClass('truncate'); expect(text).toHaveAttribute('title', description);
 });
});
