import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const { list, session } = vi.hoisted(() => ({ list: vi.fn(), session: { personId: 'viewer' } }));
vi.mock('../lib/scope', () => ({ scopedSession: async () => ({ s: session, scopeIds: ['company'] }) }));
vi.mock('../lib/authz', () => ({ requireModule: vi.fn() }));
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getTranslations: async () => createTranslator({ locale: 'en', messages: en, namespace: 'attendanceHistory', onError: error => { throw error; } }) }));
vi.mock('../packs/attendance/service', () => ({ listAttendanceCorrections: list, resolveApprovedOt: () => 0 }));
vi.mock('../app/attendance/actions', () => ({ decideCorrectionAction: vi.fn() }));
vi.mock('../components/attendance-workflow-progress', () => ({ AttendanceWorkflowProgress: () => <p>Saved request workflow</p> }));
vi.mock('../components/pager', () => ({ Pager: () => null }));
import Page from '../app/attendance/application-history/visible/page';
beforeEach(() => vi.clearAllMocks()); afterEach(cleanup);
it('uses the former Overview reader unchanged and keeps noncurrent rows visible without action forms', async () => {
  list.mockResolvedValue([
    { id: 'current', employee: 'Fictional current request', personId: 'other', employeeCode: '0007', attendanceDate: '2026-10-20', status: 'pending', requestKind: 'absent', hasAttachment: true, canDecide: true, workflow: { currentStage: 0, currentParticipantSlot: '0:0' } },
    { id: 'future', employee: 'Fictional future request', personId: 'other', employeeCode: '0008', attendanceDate: '2026-10-20', status: 'pending', requestKind: 'absent', hasAttachment: true, canDecide: false },
    { id: 'own', employee: 'Fictional own request', personId: 'viewer', employeeCode: '0009', attendanceDate: '2026-10-20', status: 'pending', requestKind: 'absent', canDecide: true },
  ]);
  render(<NextIntlClientProvider locale="en" messages={en}>{await Page({ searchParams: Promise.resolve({}) })}</NextIntlClientProvider>);
  expect(list).toHaveBeenCalledWith(session, { companyIds: ['company'], status: 'pending' });
  const current = screen.getByText('Fictional current request').closest('tr')!;
  expect(within(current).getByRole('button', { name: en.attendanceHistory.approve })).toBeVisible();
  expect(within(current).getByRole('link', { name: en.attendanceHistory.attachment })).toHaveAttribute('href', '/attendance/requests/attachment/current');
  const form = current.querySelector('form')!;
  expect(new FormData(form).get('correctionId')).toBe('current');
  expect(new FormData(form).get('workflowParticipant')).toBe('0:0');
  expect(new FormData(form).get('returnTo')).toBe('/attendance/application-history/visible');
  for (const name of ['Fictional future request', 'Fictional own request']) {
    const row = screen.getByText(name).closest('tr')!;
    expect(row.querySelector('form')).toBeNull();
    expect(within(row).getByText(en.attendanceHistory.notWaitingForYou)).toBeVisible();
    if (name === 'Fictional future request') expect(within(row).getByRole('link', { name: en.attendanceHistory.attachment })).toHaveAttribute('href', '/attendance/requests/attachment/future');
  }
});
