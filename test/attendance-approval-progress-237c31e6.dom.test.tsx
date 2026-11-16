// Board 237c31e6: Attendance Irregularity and Self Overtime show every approval level, each level's live status and a
// one-line progress message, before Submit and on every screen that shows a sent request. People and codes are
// fictional; the codes follow the reporter's EMP-0004 then EMP-0002 example.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';
const catalogues = { en, ms, ta, th, vi: vi_, zh } as const;
const language = vi.hoisted(() => ({ current: 'en' as 'en' | 'ms' | 'ta' | 'th' | 'vi' | 'zh' }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => language.current,
  getTranslations: async (namespace: string) => createTranslator({ locale: language.current, messages: catalogues[language.current], namespace: namespace as 'attendanceHistory', onError: error => { throw error; } }),
}));
import { AttendanceWorkflowProgress } from '../components/attendance-workflow-progress';
import { AttendanceSubmissionRouteProgress } from '../components/attendance-route-progress';
import { attendanceLevelStatuses, attendanceProgressMessage, attendanceRouteLevelStatuses } from '../lib/attendance-progress';
afterEach(() => { cleanup(); language.current = 'en'; });

const FIRST = '00000000-0000-4000-8000-000000000004', SECOND = '00000000-0000-4000-8000-000000000002', THIRD = '00000000-0000-4000-8000-000000000003';
const first = { kind: 'direct_manager' as const, slot: '0:0', employmentId: FIRST, name: 'Fictional First Approver', hierarchyDepth: 1 };
const second = { kind: 'specific_employee' as const, slot: '1:0', employmentId: SECOND, name: 'Fictional Second Approver' };
const codes = { [FIRST]: 'EMP-0004', [SECOND]: 'EMP-0002', [THIRD]: 'EMP-0003' };
const decided = (stageIndex: number, decision: 'approved' | 'rejected' = 'approved') => ({ stageIndex, decision, actualActorName: 'Fictional actor', actualEmploymentId: null, actingMode: 'assigned', decidedAt: new Date('2026-11-10T07:10:00Z'), remarks: null });
const participant = (stageIndex: number, slot: string, name: string, decision: 'approved' | 'rejected' = 'approved') => ({ ...decided(stageIndex, decision), participantSlot: slot, assigned: { kind: 'specific_employee', name } });
const base = { templateCode: 'WF-ATT-01', templateName: 'Fictional attendance approvals', templateVersion: 1, routingVersion: 4, createdAt: new Date('2026-11-10T01:02:00Z'), approverCodes: codes };
const twoLevels = [{ name: 'Level 1', mode: 'any_one' as const, approvers: [first] }, { name: 'Level 2', mode: 'any_one' as const, approvers: [second] }];
const headings = () => screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);
const headline = () => document.querySelector('[data-approval-headline]')?.textContent;

describe('the reporter\'s example: Level 1 EMP-0004, then Level 2 EMP-0002', () => {
  it('stage 1 — submitted: both levels are visible, Level 1 pending, Level 2 waiting', async () => {
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 0, stages: twoLevels, decisions: [] } }));
    expect(headings()).toEqual(['Level 1 · Pending Approval', 'Level 2 · Waiting for Previous Level Approval']);
    expect(headline()).toBe('Waiting for first-level approval.');
    expect(screen.getByText('Assigned approver: Fictional First Approver · EMP-0004')).toBeVisible();
    expect(screen.getByText('Assigned approver: Fictional Second Approver · EMP-0002')).toBeVisible();
  });
  it('stage 2 — the first-level approver approves', async () => {
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 1, stages: twoLevels, decisions: [decided(0)], participantDecisions: [participant(0, '0:0', first.name)] } }));
    expect(headings()).toEqual(['Level 1 · Approved', 'Level 2 · Pending Approval']);
    expect(headline()).toBe('First-level approval completed. Waiting for second-level approval.');
    expect(screen.getByText(/Approved/, { selector: 'p.font-medium' })).toHaveTextContent('Fictional First Approver · Approved');
    // The decision keeps its date and time.
    expect(screen.getAllByText(/Assigned approver · /).length).toBeGreaterThan(0);
  });
  it('stage 3 — the second-level approver approves', async () => {
    render(await AttendanceWorkflowProgress({ status: 'approved', workflow: { ...base, currentStage: 2, stages: twoLevels, decisions: [decided(0), decided(1)], participantDecisions: [participant(0, '0:0', first.name), participant(1, '1:0', second.name)] } }));
    expect(headings()).toEqual(['Level 1 · Approved', 'Level 2 · Approved']);
    expect(headline()).toBe('Overall request status: Approved.');
  });
});

describe('outcomes and configured rules', () => {
  it('rejected at Level 1: Level 2 is Not Required', async () => {
    render(await AttendanceWorkflowProgress({ status: 'rejected', workflow: { ...base, currentStage: 0, stages: twoLevels, decisions: [decided(0, 'rejected')], participantDecisions: [participant(0, '0:0', first.name, 'rejected')] } }));
    expect(headings()).toEqual(['Level 1 · Rejected', 'Level 2 · Not Required']);
    expect(headline()).toBe('Overall request status: Rejected.');
  });
  it('withdrawn before any decision: every level is Not Required', async () => {
    render(await AttendanceWorkflowProgress({ status: 'withdrawn', workflow: { ...base, currentStage: 0, stages: twoLevels, decisions: [] } }));
    expect(headings()).toEqual(['Level 1 · Not Required', 'Level 2 · Not Required']);
    expect(headline()).toBe('Overall request status: Withdrawn.');
  });
  it('a level skipped at submission (5124) keeps its number and reads Skipped / Not Required', async () => {
    const third = { ...second, slot: '1:0', employmentId: THIRD, name: 'Fictional Third Approver' };
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 1, stages: [twoLevels[0], { name: 'Level 3', mode: 'any_one', approvers: [third] }], decisions: [decided(0)],
      skippedLevels: [{ configuredLevel: 2, sources: [{ kind: 'direct_manager', depth: 2 }], reason: 'no_further_superior', levelSkipped: true }] } }));
    expect(headings()).toEqual(['Level 1 · Approved', 'Level 2 · Skipped / Not Required', 'Level 3 · Pending Approval']);
    expect(headline()).toBe('First-level approval completed. Waiting for third-level approval.');
    expect(screen.getByText('Assigned approver: Fictional Third Approver · EMP-0003')).toBeVisible();
  });
  it('an escalated level (5141) keeps its Escalated label; the next level is pending', async () => {
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 1, stages: twoLevels, decisions: [],
      escalations: [{ id: 'e1', stageIndex: 0, nextStageIndex: 1, escalateAfterDays: 3, escalatedAt: new Date('2026-11-13T00:00:00Z'), fromParticipants: [{ kind: 'direct_manager', name: first.name }] }] } }));
    expect(headings()).toEqual(['Level 1 · Escalated', 'Level 2 · Pending Approval']);
    expect(headline()).toBe('Waiting for second-level approval.');
    expect(screen.getByText('No approval or rejection within 3 day(s). Moved automatically to Level 2.')).toBeVisible();
  });
  it('Everyone must approve: one of two has approved, the other is still to act', async () => {
    const a = { kind: 'specific_employee' as const, slot: '0:0', employmentId: FIRST, name: 'Fictional Everyone A' }, b = { kind: 'specific_employee' as const, slot: '0:1', employmentId: SECOND, name: 'Fictional Everyone B' };
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 0, stages: [{ name: 'Level 1', mode: 'all_required', approvers: [a, b] }], decisions: [], participantDecisions: [participant(0, '0:0', a.name)] } }));
    expect(headings()).toEqual(['Level 1 · Pending Approval']);
    const lines = [...document.querySelectorAll('[data-approval-participant]')].map(line => line.querySelector('p')?.textContent);
    expect(lines).toEqual(['Fictional Everyone A · EMP-0004 · Approved', 'Fictional Everyone B · EMP-0002 · Pending Approval']);
    expect(screen.getByText('Everyone needs to approve')).toBeVisible();
  });
  it('sequential: the first outstanding person acts, the next waits', async () => {
    const people = [FIRST, SECOND, THIRD].map((employmentId, i) => ({ kind: 'specific_employee' as const, slot: `0:${i}`, employmentId, name: `Fictional sequential ${i + 1}` }));
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 0, stages: [{ name: 'Level 1', mode: 'sequential', approvers: people }], decisions: [], participantDecisions: [participant(0, '0:0', people[0].name)] } }));
    expect([...document.querySelectorAll('[data-approval-participant]')].map(line => line.getAttribute('data-approval-status'))).toEqual(['approved', 'pending_approval', 'waiting_previous']);
    expect(screen.getByText('Sequential approval — the first outstanding person acts next.')).toBeVisible();
  });
  it('an HR alternative is its own line beside the Direct Superior', async () => {
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 0, stages: [{ name: 'Level 1', mode: 'any_one', approvers: [first], hrAlternative: true }], decisions: [] } }));
    const lines = [...document.querySelectorAll('[data-approval-participant]')].map(line => line.querySelector('p')?.textContent);
    expect(lines).toEqual(['Fictional First Approver · EMP-0004 · Pending Approval', 'HR administrators · Pending Approval']);
  });
  it('legacy routing: no saved workflow keeps the original-rules text; a version 1 route lists its levels', async () => {
    const { unmount } = render(await AttendanceWorkflowProgress({ status: 'pending', workflow: null }));
    expect(screen.getByText(en.attendanceHistory.legacyHelp)).toBeVisible();
    unmount();
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, routingVersion: 1, currentStage: 0, stages: [{ name: 'Level 1', approvers: [{ kind: 'direct_manager', employmentId: FIRST, name: 'Fictional v1 manager' }] }, { name: 'Level 2', approvers: [{ kind: 'hr_admin', employmentId: null, name: 'HR administrators' }] }], decisions: [] } }));
    expect(headings()).toEqual(['Level 1 · Pending Approval', 'Level 2 · Waiting for Previous Level Approval']);
    expect(screen.getByText('Assigned approver: Fictional v1 manager · EMP-0004')).toBeVisible();
  });
  it.each(['ms', 'ta', 'th', 'vi', 'zh'] as const)('renders the stage 2 panel in %s without missing messages', async locale => {
    language.current = locale;
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 1, stages: twoLevels, decisions: [decided(0)] } }));
    const copy = catalogues[locale].attendanceHistory;
    expect(headings()).toEqual([`${copy.levelNumber.replace('{level}', '1')} · ${copy.statuses.approved}`, `${copy.levelNumber.replace('{level}', '2')} · ${copy.pendingApproval}`]);
    expect(headline()).toContain(copy.levelOrdinal['2']);
  });
});

describe('before Submit', () => {
  it('lists every level with name and Employee ID: Level 1 Pending Approval, Level 2 Waiting', async () => {
    render(await AttendanceSubmissionRouteProgress({ route: { available: true, stages: twoLevels, skippedLevels: [], approverCodes: codes } }));
    const levels = [...document.querySelectorAll('li[data-approval-level]')];
    expect(levels.map(level => level.querySelector('p')?.textContent)).toEqual(['Level 1 · Pending Approval', 'Level 2 · Waiting for Previous Level Approval']);
    expect(within(levels[0] as HTMLElement).getByText('Fictional First Approver · EMP-0004')).toBeVisible();
    expect(within(levels[1] as HTMLElement).getByText('Fictional Second Approver · EMP-0002')).toBeVisible();
  });
  it('an unresolved level shows a configuration warning on that level, never a wrong person, and the refusal stays', async () => {
    render(await AttendanceSubmissionRouteProgress({ route: { available: false, reason: 'unresolved', problem: { code: 'missing_superior', levelIndex: 1 }, levelCount: 3 } }));
    expect(screen.getByRole('status')).toHaveTextContent(en.attendanceWorkflow.submissionRefusals.unresolved);
    const levels = [...document.querySelectorAll('li[data-approval-level]')] as HTMLElement[];
    expect(levels.map(level => level.querySelector('p')?.textContent)).toEqual(['Level 1', 'Level 2', 'Level 3']);
    expect(within(levels[1]).getByRole('alert')).toHaveTextContent(en.attendanceHistory.configurationWarning);
    expect(within(levels[1]).getByRole('alert')).toHaveTextContent(en.attendanceWorkflow.v3.superiorUnavailable);
    expect(within(levels[0]).queryByRole('alert')).toBeNull();
    expect(within(levels[2]).queryByRole('alert')).toBeNull();
  });
  it('a refusal with no known level keeps only the refusal', async () => {
    render(await AttendanceSubmissionRouteProgress({ route: { available: false, reason: 'noMatch' } }));
    expect(screen.getByRole('status')).toHaveTextContent(en.attendanceWorkflow.submissionRefusals.noMatch);
    expect(document.querySelectorAll('li[data-approval-level]')).toHaveLength(0);
  });
});

describe('the pure mapping', () => {
  it('derives statuses only from the frozen request', () => {
    const flow = { routingVersion: 4, currentStage: 1, stages: twoLevels, decisions: [decided(0)] };
    expect(attendanceLevelStatuses(flow, 'pending').map(level => level.status)).toEqual(['approved', 'pending_approval']);
    expect(attendanceLevelStatuses(flow, 'cancelled').map(level => level.status)).toEqual(['approved', 'not_required']);
    expect(attendanceProgressMessage(flow, 'pending')).toEqual({ kind: 'completed', completed: 1, waiting: 2 });
    expect(attendanceRouteLevelStatuses(twoLevels).map(level => level.status)).toEqual(['pending_approval', 'waiting_previous']);
  });
});
