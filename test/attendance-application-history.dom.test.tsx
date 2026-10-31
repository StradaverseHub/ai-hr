import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';

const { service, scope, language } = vi.hoisted(() => ({
  service: { attendanceApplicationDetail: vi.fn() },
  scope: vi.fn(),
  language: { current: 'en' as 'en' | 'ms' | 'zh' | 'ta' | 'th' | 'vi' },
}));
const catalogues = { en, ms, zh, ta, th, vi: viMessages };
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('../packs/attendance/service', () => service);
vi.mock('next-intl/server', () => ({
  getLocale: async () => language.current,
  getTranslations: async (namespace: string) => createTranslator({
    locale: language.current,
    messages: {
      attendanceHistory: catalogues[language.current].attendanceHistory,
      attendanceWorkflow: { v3: catalogues[language.current].attendanceWorkflow.v3 },
    },
    namespace: namespace as 'attendanceHistory',
    onError: error => { throw error; },
  }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('../app/(app)/attendance/application-history/actions', () => ({ attendanceHistoryAction: vi.fn() }));
// The existing workflow tests cover progress. This regression renders the actual history page/list.
vi.mock('../components/attendance-workflow-progress', () => ({ AttendanceWorkflowProgress: () => <div /> }));
import Page from '../app/(app)/attendance/application-history/[id]/page';

const companyId = '00000000-0000-0000-0000-000000000001';
const applicationId = '00000000-0000-0000-0000-000000000002';
const attendanceId = '00000000-0000-0000-0000-000000000003';
const actorId = '00000000-0000-0000-0000-000000000004';
const occurredAt = new Date('2024-01-02T02:00:00Z');
const event = (id: string, eventType: string, payload: Record<string, unknown>) => ({
  id, eventType, payload, occurredAt, actorId, actorType: 'user', actorName: 'Fictional final approver',
});

beforeEach(() => {
  vi.clearAllMocks();
  language.current = 'en';
  scope.mockResolvedValue({ s: { actor: 'scoped HR' }, scopeIds: [companyId] });
  service.attendanceApplicationDetail.mockResolvedValue({
    application: {
      id: applicationId, status: 'approved', attendanceDate: '2024-01-02', createdAt: occurredAt,
      reason: 'Fictional corrected clock pair', proposedCheckIn: '09:00:00', proposedCheckOut: '18:00:00',
    },
    employee: 'Fictional applicant', employeeCode: 'HISTORY-001', company: 'Company A',
    applicationType: 'irregularity', workflow: null, hasAttachment: false,
    canDecide: false, canReassign: false, canCancel: false,
    // Four distinct legitimate events share an actor/time: two punches and two audit facts.
    events: [
      event('00000000-0000-0000-0000-000000000101', 'attendance.punch.added', { correctionId: applicationId, after: { direction: 'in', punchAt: '09:00:00' } }),
      event('00000000-0000-0000-0000-000000000102', 'attendance.punch.added', { correctionId: applicationId, after: { direction: 'out', punchAt: '18:00:00' } }),
      event('00000000-0000-0000-0000-000000000103', 'attendance-correction.effect.recorded', { attendanceId, before: null, after: { checkInAt: '09:00:00', checkOutAt: '18:00:00' } }),
      event('00000000-0000-0000-0000-000000000104', 'attendance.amended', { correctionId: applicationId, before: null, after: { checkInAt: '09:00:00', checkOutAt: '18:00:00' } }),
    ],
  });
});
afterEach(cleanup);

describe('Attendance Application History audit captions', () => {
  it.each([
    ['en', 'Application result recorded'],
    ['ms', 'Hasil permohonan direkodkan'],
    ['zh', '申请结果已记录'],
    ['ta', 'விண்ணப்ப முடிவு பதிவு செய்யப்பட்டது'],
    ['th', 'บันทึกผลคำขอแล้ว'],
    ['vi', 'Đã ghi nhận kết quả đơn'],
  ] as const)('distinguishes the application audit from the applied attendance result in %s without dropping punches', async (locale, recordedCaption) => {
    language.current = locale;
    render(await Page({ params: Promise.resolve({ id: applicationId }), searchParams: Promise.resolve({}) }));
    const copy = catalogues[locale].attendanceHistory;
    const history = screen.getByRole('heading', { name: copy.actionHistory }).parentElement;
    expect(history).not.toBeNull();
    const rows = within(history!).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.querySelector('p')?.textContent)).toEqual([
      copy.events.clockAdded, copy.events.clockAdded, recordedCaption, copy.events.resultApplied,
    ]);
    expect(within(history!).getAllByText(copy.events.clockAdded)).toHaveLength(2);
    expect(within(history!).getAllByText(recordedCaption)).toHaveLength(1);
    expect(within(history!).getAllByText(copy.events.resultApplied)).toHaveLength(1);
    for (const row of rows) expect(row).toHaveTextContent('Fictional final approver');
    expect(service.attendanceApplicationDetail).toHaveBeenCalledWith(expect.anything(), [companyId], applicationId);
  });
});
