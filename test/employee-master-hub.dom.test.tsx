import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const { list, scope, language } = vi.hoisted(() => ({ list: vi.fn(), scope: vi.fn(), language: { current: 'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi' } }));
const catalogues = { en, ms, zh, ta, th, vi: viMessages };
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: language.current, messages: catalogues[language.current], namespace: namespace as never, onError: error => { throw error; } }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('../core/employee-master-reports', () => ({ listEmployeeMasterReports: list }));
vi.mock('../core/custom-reports', () => ({ listCustomReports: async () => [] }));
vi.mock('../core/report-registry', () => ({ REPORT_CATEGORIES: ['master'], datasetsForCategory: () => [] }));
vi.mock('../app/(app)/reports/employee-master/MasterReportList', () => ({ MasterReportList: ({ reports }: { reports: { id: string; name: string }[] }) => <div>{reports.map(report => <div key={report.id} data-testid="visible-master-report">{report.name}</div>)}</div> }));
vi.mock('../app/(app)/reports/ReportRowActions', () => ({ ReportRowActions: () => null }));
vi.mock('../components/ui', () => ({ Card: ({ children }: React.PropsWithChildren) => <section>{children}</section>, PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>, ErrorBanner: () => null }));
import Page from '../app/(app)/reports/page';
const principal = { actor: 'Fictional scoped HR' }, companies = ['00000000-0000-4000-8000-000000000001'];
beforeEach(() => { vi.clearAllMocks(); scope.mockResolvedValue({ s: principal, scopeIds: companies }); });

// The owner boundary supplies only visible definitions. This tests real hub rendering/counting,
// not database privacy; canonical Employee Master service/RLS regressions cover that authority.
describe.each(['en','ms','zh','ta','th','vi'] as const)('Employee Master visible report count in %s', locale => {
 it.each([true,false])('acknowledges a visible saved report outside the first five without changing recent order (canEdit=%s)', async canEdit => {
  language.current = locale;
  const visible = Array.from({ length: 7 }, (_, index) => ({ id: '00000000-0000-4000-8000-'+String(index+1).padStart(12,'0'), name: 'Visible fictional report '+index, canEdit }));
  list.mockResolvedValue(visible); const saved = visible[6];
  render(await Page({ searchParams: Promise.resolve({ cat: 'master', saved: saved.id, savedName: 'Forged query title must be ignored' }) }));
  const t = createTranslator({ locale, messages: catalogues[locale], namespace: 'employeeMasterReports', onError: error => { throw error; } });
  const status = screen.getByRole('status'); expect(status).toHaveTextContent(t('savedReport', { name: saved.name }));
  expect(status).not.toHaveTextContent('Forged query title must be ignored');
  expect(within(status).getByRole('link', { name: t('runSavedReport') })).toHaveAttribute('href', '/reports/employee-master/'+saved.id);
  const edit = within(status).queryByRole('link', { name: t('editSavedReport') });
  if (canEdit) expect(edit).toHaveAttribute('href', '/reports/employee-master/'+saved.id); else expect(edit).not.toBeInTheDocument();
  expect(within(status).getByRole('link', { name: t('viewAll') })).toHaveAttribute('href', '/reports/employee-master');
  expect(screen.getAllByTestId('visible-master-report').map(row => row.textContent)).toEqual(visible.slice(0,5).map(report => report.name));
  expect(list).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledWith(principal, companies, { all: true });
 });
 it.each([0,1,7])('shows the authorised total %i while keeping only the five recent rows on the card', async count => {
  language.current = locale;
  const visible = Array.from({ length: count }, (_, index) => ({ id: 'report-'+index, name: 'Visible fictional report '+index }));
  list.mockImplementation(async (_actor, _scope, options?: { all?: boolean }) => options?.all ? visible : visible.slice(0, 5));
  render(await Page({ searchParams: Promise.resolve({ cat: 'master' }) }));
  const t = createTranslator({ locale, messages: catalogues[locale], namespace: 'employeeMasterReports', onError: error => { throw error; } });
  const link = screen.getByRole('link', { name: t('viewAllCountLabel', { count }) });
  expect(link).toHaveAttribute('href', '/reports/employee-master');
  expect(link).toHaveTextContent(t('viewAllCount', { count }));
  expect(screen.queryAllByTestId('visible-master-report')).toHaveLength(Math.min(5, count));
  if (count > 5) expect(screen.queryByText(visible[5].name)).not.toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledWith(principal, companies, { all: true });
 });
});
it.each([undefined,'unknown-private-report','foreign-report'])('does not acknowledge an unverified saved id (%s) or reflect a supplied name', async saved => {
 language.current = 'en'; list.mockResolvedValue([]);
 render(await Page({ searchParams: Promise.resolve({ cat: 'master', saved, savedName: 'Untrusted confidential report title' }) }));
 expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(screen.queryByText(/Untrusted confidential report title/)).not.toBeInTheDocument();
});
