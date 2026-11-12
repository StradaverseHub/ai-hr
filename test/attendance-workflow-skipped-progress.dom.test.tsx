// Board 4452ba3c: the approval history shows levels decided "Not required" at submission, with the
// configured level numbers, and the final outcome after the last real approver.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as 'attendanceHistory', onError: error => { throw error; } }) }));
import { AttendanceWorkflowProgress } from '../components/attendance-workflow-progress';
afterEach(cleanup);
const approver = { kind: 'direct_manager' as const, slot: '0:0', employmentId: '00000000-0000-0000-0000-0000000000b0', name: 'Fictional Employee B', hierarchyDepth: 1 };
const named = { kind: 'specific_employee' as const, slot: '1:0', employmentId: '00000000-0000-0000-0000-0000000000c0', name: 'Fictional named approver' };
const decision = (stageIndex: number) => ({ stageIndex, decision: 'approved', actualActorName: 'Fictional actor', actualEmploymentId: null, actingMode: 'assigned', decidedAt: new Date('2026-11-10T07:10:00Z'), remarks: null });
const base = { templateCode: 'WF-DESIGN-01', templateName: 'Fictional design approvals', templateVersion: 4, routingVersion: 4, createdAt: new Date('2026-11-10T01:02:00Z') };
describe('approval history with skipped Direct Superior levels', () => {
  it('lists Level 2 and Level 3 as not required after the approved Level 1', async () => {
    render(await AttendanceWorkflowProgress({ status: 'approved', workflow: { ...base, currentStage: 1, stages: [{ name: 'Level 1', mode: 'any_one', approvers: [approver] }], decisions: [decision(0)],
      skippedLevels: [{ configuredLevel: 2, sources: [{ kind: 'direct_manager', depth: 2 }], reason: 'no_further_superior', levelSkipped: true }, { configuredLevel: 3, sources: [{ kind: 'direct_manager', depth: 3 }], reason: 'no_further_superior', levelSkipped: true }] } }));
    const items = screen.getAllByRole('listitem').filter(item => /^Level \d/.test(item.querySelector('h3')?.textContent ?? ''));
    expect(items.map(item => item.querySelector('h3')!.textContent)).toEqual(['Level 1 · Approved', 'Level 2 · Not required', 'Level 3 · Not required']);
    expect(within(items[1]).getByText('Skipped automatically - No further Direct Superior available (Second-Level Direct Superior)')).toBeVisible();
    expect(within(items[2]).getByText(/Third-Level Direct Superior/)).toBeVisible();
    expect(within(items[2]).getByText(/^Decided when the application was submitted, /)).toBeVisible();
    expect(screen.getByText('Final outcome: Approved')).toBeVisible();
  });
  it('keeps the configured level name when a middle level was skipped and the request is pending', async () => {
    render(await AttendanceWorkflowProgress({ status: 'pending', workflow: { ...base, currentStage: 1, stages: [{ name: 'Level 1', mode: 'any_one', approvers: [approver] }, { name: 'Level 3', mode: 'any_one', approvers: [named] }], decisions: [decision(0)],
      skippedLevels: [{ configuredLevel: 2, sources: [{ kind: 'direct_manager', depth: 2 }], reason: 'no_further_superior', levelSkipped: true }] } }));
    const headings = screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);
    expect(headings).toEqual(['Level 1 · Approved', 'Level 2 · Not required', 'Level 3 · Waiting for decision']);
    expect(screen.getByText('Current level: 3')).toBeVisible();
  });
});
