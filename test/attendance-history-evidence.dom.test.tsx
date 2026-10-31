import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
const { service } = vi.hoisted(() => ({ service: { attendanceApplicationDetail: vi.fn() } }));
// Server page markup is rendered outside Next's router; keep real anchor semantics.
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }));
vi.mock('../lib/scope', () => ({ scopedAdmin: async () => ({ s: {}, scopeIds: ['company'] }) }));
vi.mock('../packs/attendance/service', () => service);
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getTranslations: async () => createTranslator({ locale: 'en', messages: { attendanceHistory: en.attendanceHistory }, namespace: 'attendanceHistory', onError: error => { throw error; } }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('../app/(app)/attendance/application-history/actions', () => ({ attendanceHistoryAction: vi.fn() }));
vi.mock('../components/attendance-workflow-progress', () => ({ AttendanceWorkflowProgress: () => <p>Recorded progress</p> }));
import Page from '../app/(app)/attendance/application-history/[id]/page';
beforeEach(() => vi.clearAllMocks()); afterEach(cleanup);
function detail(kind: string, review: unknown) {
  return { application: { id: '00000000-0000-0000-0000-000000000002', status: 'pending', attendanceDate: '2026-10-20', createdAt: new Date('2026-10-20T02:00:00Z'), reason: 'Fictional employee explanation', requestKind: kind },
    employee: 'Fictional applicant', employeeCode: '0007', company: 'Fictional company', applicationType: 'irregularity', workflow: null, hasAttachment: false,
    canDecide: false, canReassign: false, canCancel: false, events: [], review };
}
async function show(value: unknown) {
  service.attendanceApplicationDetail.mockResolvedValue(value);
  render(await Page({ params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000002' }), searchParams: Promise.resolve({ returnTo: '/attendance/application-history?status=pending&query=0007' }) }));
}
it('presents recorded required work, qualifying work and shortfall without recalculating them', async () => {
  await show(detail('short_hours', { record: { checkInAt: '08:00:00', checkOutAt: '16:00:00', status: 'present', workedMinutes: 420, underMinutes: 60 },
    schedule: { startAbs: 480, endAbs: 1020, scheduledMinutes: 480, normalMinutesOverride: null, dayType: 'workday' }, currentShiftName: 'Fictional day shift', organisation: null }));
  for (const value of ['480 minutes', '420 minutes', '60 minutes', '08:00 → 17:00']) expect(screen.getByText(value)).toBeVisible();
  expect(screen.getByText(en.attendanceHistory.originalUnavailable)).toBeVisible();
  expect(screen.getByRole('link', { name: `← ${en.attendanceHistory.back}` })).toHaveAttribute('href', '/attendance/application-history?status=pending&query=0007');
});
it('identifies the recorded missing clock direction for Incomplete Entry', async () => {
  await show(detail('incomplete_entry', { record: { checkInAt: null, checkOutAt: '17:00:00', status: 'present', workedMinutes: 0, underMinutes: null }, schedule: null, organisation: null }));
  expect(screen.getByText(en.attendanceHistory.clockInMissing)).toBeVisible();
  expect(screen.queryByText(en.attendanceHistory.shortfallDuration)).toBeNull();
});
it('keeps the original recorded attendance result distinct from the corrected current result', async () => {
  await show({ ...detail('absent', { record: { checkInAt: '08:00:00', checkOutAt: '17:00:00', status: 'present' }, schedule: null, organisation: null }),
    events: [{ id: 'recorded-effect', eventType: 'attendance-correction.effect.recorded', occurredAt: new Date('2026-10-20T03:00:00Z'), actorName: 'Fictional HR', actorType: 'user',
      payload: { before: { status: 'absent', checkInAt: null, checkOutAt: null } } }] });
  const original = screen.getByRole('heading', { name: en.attendanceHistory.originalAttendance }).closest('section')!;
  const current = screen.getByRole('heading', { name: en.attendanceHistory.currentAttendance }).closest('section')!;
  expect(within(original).getByText(en.attendanceHistory.attendanceStates.absent)).toBeVisible();
  expect(within(original).queryByText(en.attendanceHistory.attendanceStates.present)).toBeNull();
  expect(within(current).getByText(en.attendanceHistory.attendanceStates.present)).toBeVisible();
});
it('keeps unavailable absence evidence distinct from a recorded zero or a newly created attendance row', async () => {
  await show(detail('absent', { record: null, schedule: null, organisation: null }));
  expect(screen.getByText(en.attendanceHistory.attendanceUnavailable)).toBeVisible();
  expect(screen.getByText(en.attendanceHistory.scheduleUnavailable)).toBeVisible();
  expect(screen.queryByText('0 minutes')).toBeNull();
});
