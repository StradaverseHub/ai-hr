/** @vitest-environment jsdom */
/** AI v2 Phase 2 P2-1 — an AI Centre loop's own attendance correction names the loop, under a mandate, with the sponsor
 * who answers for it; never the sponsor alone. The database stamps every event of the loop's transaction with
 * `agentAttribution` (migration 0963; covered by test/teras-loop-autonomy.test.ts); here the screens that show who
 * requested and decided read it:
 *  - the attendance application history (who made each step, and a "Made and approved by" line), in every locale;
 *  - an undo, which says who asked (the employee or HR) and that the loop carried it out;
 *  - the approvals history (shapeApprovalHistoryItems) and the parser, which ignores anything that is not a loop's own
 *    attribution. A person-made correction is shown exactly as before. Fictional fixtures only. */
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
import { withAiCentre } from './helpers/ai-centre-messages';
import { loopActorOf, loopAttribution, loopAttributionLabel } from '../lib/ai-centre/loop-attribution';
import { shapeApprovalHistoryItems } from '../lib/approval-history';

type Locale = 'en' | 'ms' | 'zh' | 'ta' | 'th' | 'vi';
const { service, scope, language } = vi.hoisted(() => ({
  service: { attendanceApplicationDetail: vi.fn() },
  scope: vi.fn(),
  language: { current: 'en' as Locale },
}));
const catalogues = { en, ms, zh, ta, th, vi: viMessages };
const merged = (locale: Locale) => withAiCentre(locale, catalogues[locale] as Record<string, unknown>) as typeof en & { aiCentre: Record<string, any> };
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('../packs/attendance/service', () => service);
vi.mock('next-intl/server', () => ({
  getLocale: async () => language.current,
  getTranslations: async (namespace: string) => {
    const all = merged(language.current);
    return createTranslator({
      locale: language.current,
      messages: { attendanceHistory: all.attendanceHistory, attendanceWorkflow: { v3: all.attendanceWorkflow.v3 }, aiCentre: { autonomy: { attribution: all.aiCentre.autonomy.attribution } } } as never,
      namespace: namespace as never,
      onError: error => { throw error; },
    });
  },
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('../app/attendance/application-history/actions', () => ({ attendanceHistoryAction: vi.fn() }));
vi.mock('../components/attendance-workflow-progress', () => ({ AttendanceWorkflowProgress: () => <div /> }));
import Page from '../app/attendance/application-history/[id]/page';

const companyId = '00000000-0000-4000-8000-0000000000c1';
const applicationId = '00000000-0000-4000-8000-0000000000a1';
const principalId = '00000000-0000-4000-8000-0000000000f1';
const sponsorUserId = '00000000-0000-4000-8000-0000000000d1';
const employeeUserId = '00000000-0000-4000-8000-0000000000e1';
const occurredAt = new Date('2026-11-03T15:04:00Z');
const attribution = (extra: Partial<Parameters<typeof loopAttribution>[0]> = {}) => loopAttribution({
  workerId: 'loop_missed_clock_outs', principalId, actionId: '00000000-0000-4000-8000-0000000000b1', employmentId: '00000000-0000-4000-8000-0000000000e2',
  sponsorUserId, sponsorName: 'Daniel Fictional', askedBy: null, askedByUserId: null, askedByName: null, ...extra,
});
// The agent principal has no person name: the event's actor is the agent, its stored name null.
const event = (id: string, eventType: string, payload: Record<string, unknown>, actor: { actorType: string; actorId: string; actorName: string | null }) => ({
  id, eventType, payload, occurredAt, ...actor,
});
const AGENT = { actorType: 'agent', actorId: principalId, actorName: null };
const PERSON = { actorType: 'user', actorId: sponsorUserId, actorName: 'Daniel Fictional' };
const detail = (events: ReturnType<typeof event>[]) => ({
  application: { id: applicationId, status: 'approved', attendanceDate: '2026-11-02', createdAt: occurredAt,
    reason: 'Missed clock-out: set to the roster end (AI Centre loop)', proposedCheckIn: '09:02:00', proposedCheckOut: '18:00:00' },
  employee: 'Siti Fictional', employeeCode: 'LOOP-001', company: 'Fictional A Sdn Bhd',
  applicationType: 'irregularity', workflow: null, hasAttachment: false, canDecide: false, canReassign: false, canCancel: false, events,
});
const loopEvents = (payload: Record<string, unknown>) => [
  event('00000000-0000-4000-8000-000000000101', 'attendance-correction.requested', payload, AGENT),
  event('00000000-0000-4000-8000-000000000102', 'attendance.punch.added', { ...payload, correctionId: applicationId, after: { direction: 'out', punchAt: '18:00:00' } }, AGENT),
  event('00000000-0000-4000-8000-000000000103', 'attendance.amended', { ...payload, correctionId: applicationId, before: null, after: { checkOutAt: '18:00:00' } }, AGENT),
];
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const history = (locale: Locale) => screen.getByRole('heading', { name: catalogues[locale].attendanceHistory.actionHistory }).parentElement!;
const actors = (locale: Locale) => within(history(locale)).getAllByRole('listitem').map(row => text(row.querySelector('[data-history-actor]')).replace(/^.* · /, ''));

beforeEach(() => {
  vi.clearAllMocks();
  language.current = 'en';
  scope.mockResolvedValue({ s: { actor: 'scoped HR' }, scopeIds: [companyId] });
});
afterEach(cleanup);
const renderPage = async () => render(await Page({ params: Promise.resolve({ id: applicationId }), searchParams: Promise.resolve({}) }));

describe('the attendance application history names the loop and its sponsor',() => {
  it('every step of the loop\'s correction says it was the AI Centre loop, sponsored by its sponsor, never the sponsor alone', async () => {
    service.attendanceApplicationDetail.mockResolvedValue(detail(loopEvents({ reason: 'Missed clock-out', agentAttribution: attribution() })));
    const view = await renderPage();
    expect(actors('en')).toEqual(Array(3).fill('AI Centre loop (missed clock-outs), sponsored by Daniel Fictional'));
    expect(text(view.container.querySelector('[data-history-made-by]'))).toBe('Made and approved by the AI Centre loop (missed clock-outs), sponsored by Daniel Fictional.');
    for (const row of within(history('en')).getAllByRole('listitem')) expect(text(row.querySelector('[data-history-actor]'))).not.toMatch(/· Daniel Fictional$/);
    expect(view.container.textContent).not.toMatch(/Noveri/);
  });

  it('an undo says who asked for it and that the loop carried it out', async () => {
    service.attendanceApplicationDetail.mockResolvedValue(detail(loopEvents({ reason: 'Undo of an AI Centre fix',
      agentAttribution: attribution({ askedBy: 'employee', askedByUserId: employeeUserId, askedByName: 'Siti Fictional' }) })));
    const view = await renderPage();
    expect(actors('en')).toEqual(Array(3).fill('AI Centre loop (missed clock-outs), at the request of Siti Fictional (the employee), sponsored by Daniel Fictional'));
    expect(text(view.container.querySelector('[data-history-made-by]'))).toBe(
      'Made and approved by the AI Centre loop (missed clock-outs), at the request of Siti Fictional (the employee), sponsored by Daniel Fictional.');
    cleanup();
    service.attendanceApplicationDetail.mockResolvedValue(detail(loopEvents({ agentAttribution: attribution({ askedBy: 'hr', askedByUserId: sponsorUserId, askedByName: null }) })));
    await renderPage();
    expect(actors('en')[0]).toBe('AI Centre loop (missed clock-outs), at HR’s request, sponsored by Daniel Fictional');
  });

  it.each(['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const)('renders the loop and sponsor in %s with no missing message', async locale => {
    language.current = locale;
    service.attendanceApplicationDetail.mockResolvedValue(detail(loopEvents({ agentAttribution: attribution() })));
    const view = await renderPage();
    const copy = merged(locale).aiCentre.autonomy.attribution;
    const expected = createTranslator({ locale, messages: { a: copy } as never, namespace: 'a' as never })('byLoop' as never, { loop: copy.loops.loop_missed_clock_outs, sponsor: 'Daniel Fictional' } as never);
    expect(actors(locale)).toEqual(Array(3).fill(expected));
    expect(text(view.container.querySelector('[data-history-made-by]'))).toContain('Daniel Fictional');
    expect(view.container.textContent).not.toMatch(/Noveri/);
  });

  it('a correction a person made is shown as before, with no loop line', async () => {
    service.attendanceApplicationDetail.mockResolvedValue(detail([
      event('00000000-0000-4000-8000-000000000201', 'attendance-correction.requested', { reason: 'Forgot to clock out' }, PERSON),
      // A forged attribution on a person's event, without the loop's shape, is ignored.
      event('00000000-0000-4000-8000-000000000202', 'attendance.amended', { agentAttribution: { workerId: 'payroll', label: 'AI Centre loop (x)' } }, PERSON),
    ]));
    const view = await renderPage();
    expect(actors('en')).toEqual(['Daniel Fictional', 'Daniel Fictional']);
    expect(view.container.querySelector('[data-history-made-by]')).toBeNull();
  });
});

describe('the approvals history and the attribution parser', () => {
  const row = (payload: unknown, deciderName: string | null) => ({ id: 'r1', aggregateType: 'attendance-correction', eventType: 'attendance-correction.decided',
    occurredAt, subjectName: 'Siti Fictional', deciderName, isAuto: false, onBehalfOfName: null, payload });
  it('names the loop and its sponsor as the decider of a loop-made correction, and leaves a person\'s decision alone', () => {
    const [loop, person] = shapeApprovalHistoryItems([row({ decision: 'approved', agentAttribution: attribution() }, null), row({ decision: 'approved' }, 'Aisyah Fictional')]);
    expect(loop.deciderName).toBe('AI Centre loop (missed clock-outs), sponsored by Daniel Fictional');
    expect(person.deciderName).toBe('Aisyah Fictional');
  });
  it('stores a plain label that always names the loop, and parses only a loop\'s own attribution', () => {
    expect(loopAttributionLabel({ workerId: 'loop_missing_employee_data', sponsorName: null, askedBy: null, askedByName: null }))
      .toBe('AI Centre loop (missing employee data), sponsored by its sponsor');
    expect(loopAttributionLabel({ workerId: 'loop_missed_clock_outs', sponsorName: 'Daniel Fictional', askedBy: 'employee', askedByName: null }))
      .toBe('AI Centre loop (missed clock-outs), at the employee\'s request, sponsored by Daniel Fictional');
    expect(loopAttributionLabel({ workerId: 'loop_missed_clock_outs', sponsorName: 'Daniel Fictional', askedBy: 'hr', askedByName: 'Aisyah Fictional' }))
      .toBe('AI Centre loop (missed clock-outs), at the request of Aisyah Fictional (HR), sponsored by Daniel Fictional');
    expect(loopActorOf({ agentAttribution: attribution() })).toMatchObject({ workerId: 'loop_missed_clock_outs', sponsorName: 'Daniel Fictional', askedBy: null });
    for (const payload of [null, 'x', [], {}, { agentAttribution: [] }, { agentAttribution: { workerId: 'payroll_agent', label: 'x' } },
      { agentAttribution: { workerId: 'loop_missed_clock_outs' } }, { agentAttribution: { workerId: "loop_x'; drop", label: 'x' } }])
      expect(loopActorOf(payload), JSON.stringify(payload)).toBeNull();
    expect(loopActorOf({ agentAttribution: { ...attribution(), askedBy: 'manager', askedByName: 'Someone' } })).toMatchObject({ askedBy: null, askedByName: null });
  });
});
