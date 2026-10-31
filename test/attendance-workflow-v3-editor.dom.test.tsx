import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { AttendanceStageEditorV3, emptyAttendanceV3Level } from '../app/(app)/admin/attendance/approval-workflow/stage-editor-v3';
import type { AttendanceLevelProblem, AttendanceV3Level } from '../lib/attendance-workflow-v3';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
const employees = [{ id: 'employee-a', employeeCode: 'EMP-A', name: 'Fictional Arjun' }, { id: 'employee-b', employeeCode: 'EMP-B', name: 'Fictional Daniel' }];
function Harness({ initial = [emptyAttendanceV3Level(0), emptyAttendanceV3Level(1)], problems = [] }: { initial?: AttendanceV3Level[]; problems?: AttendanceLevelProblem[] }) {
    const [stages, setStages] = useState(initial);
    return <><AttendanceStageEditorV3 id="attendance-v3-test" stages={stages} employees={employees} onChange={setStages} problems={problems}/><output data-testid="route">{JSON.stringify(stages)}</output></>;
}
const show = (initial?: AttendanceV3Level[], problems?: AttendanceLevelProblem[]) => render(<NextIntlClientProvider locale="en" messages={en}><Harness initial={initial} problems={problems}/></NextIntlClientProvider>);
const levels = () => Array.from(document.querySelectorAll<HTMLElement>('[id^="attendance-v3-test-level-"]'));
const saved = (): AttendanceV3Level[] => JSON.parse(screen.getByTestId('route').textContent!);
afterEach(cleanup);
describe('prepared per-level Attendance v3 editor (live conversion remains disabled)', () => {
    it('changes one mode without changing another radio group', () => {
        show();
        fireEvent.click(within(levels()[0]).getByRole('radio', { name: /Any One Approver/ }));
        expect(saved().map(level => level.mode)).toEqual(['any_one', 'sequential']);
        expect(within(levels()[0]).getByRole('radio', { name: /Any One Approver/ })).toBeChecked();
        expect(within(levels()[1]).getByRole('radio', { name: /Sequential Approval/ })).toBeChecked();
    });
    it('retains an independent fifth-superior depth after a named first level', () => {
        show();
        fireEvent.change(within(levels()[0]).getByLabelText('Approver source'), { target: { value: 'specific_employee' } });
        fireEvent.change(within(levels()[0]).getByLabelText('Add employee'), { target: { value: 'employee-a' } });
        fireEvent.change(within(levels()[1]).getByLabelText('Superior depth'), { target: { value: '5' } });
        expect(saved()[0].source).toEqual({ kind: 'specific_employee', employmentIds: ['employee-a'] });
        expect(saved()[1].source).toEqual({ kind: 'direct_manager', depth: 5 });
    });
    it('shows employee codes and names and preserves the explicitly edited order', () => {
        show();
        fireEvent.change(within(levels()[0]).getByLabelText('Approver source'), { target: { value: 'specific_employee' } });
        const chooser = within(levels()[0]).getByLabelText('Add employee');
        fireEvent.change(chooser, { target: { value: 'employee-a' } });
        fireEvent.change(chooser, { target: { value: 'employee-b' } });
        expect(within(levels()[0]).getByText('1. EMP-A · Fictional Arjun')).toBeVisible();
        fireEvent.click(within(levels()[0]).getByRole('button', { name: 'Move EMP-B · Fictional Daniel up' }));
        expect(saved()[0].source).toEqual({ kind: 'specific_employee', employmentIds: ['employee-b', 'employee-a'] });
        fireEvent.click(within(levels()[0]).getByRole('button', { name: 'Remove EMP-A · Fictional Arjun' }));
        expect(saved()[0].source).toEqual({ kind: 'specific_employee', employmentIds: ['employee-b'] });
    });
    it('retains draft values on refusal and offers a focused summary linked to the affected level', () => {
        const initial = [emptyAttendanceV3Level(0), { ...emptyAttendanceV3Level(1), source: { kind: 'specific_employee' as const, employmentIds: [] } }];
        show(initial, [{ code: 'selection_required', levelIndex: 1 }]);
        expect(screen.getByRole('alert')).toHaveFocus();
        fireEvent.click(screen.getByRole('link', { name: /Level 2: Select at least one employee/ }));
        expect(levels()[1]).toHaveFocus();
        expect(saved()).toEqual(initial);
        expect(within(levels()[1]).getByText('Select at least one employee for this level.')).toBeVisible();
    });
    it('keeps unavailable selected IDs visible for correction rather than deleting them', () => {
        show([{ ...emptyAttendanceV3Level(0), source: { kind: 'specific_employee', employmentIds: ['departed'] } }]);
        expect(within(levels()[0]).getByText(/departed/)).toBeVisible();
        expect(saved()[0].source).toEqual({ kind: 'specific_employee', employmentIds: ['departed'] });
    });
    it('explicitly refuses an HR alternative combined with a required selected group', () => {
        show([{ ...emptyAttendanceV3Level(0), hrAlternative: true, source: { kind: 'specific_employee', employmentIds: ['employee-a'] } }]);
        expect(screen.getByRole('alert')).toHaveTextContent(en.attendanceWorkflow.v3.groupHrRefused);
        expect(saved()[0].hrAlternative).toBe(true);
    });
    it.each([['en', en], ['ms', ms], ['zh', zh], ['ta', ta], ['th', th], ['vi', vi]] as const)('uses the complete %s level-copy catalogue', (locale, messages) => {
        render(<NextIntlClientProvider locale={locale} messages={messages}><Harness/></NextIntlClientProvider>);
        expect(screen.getAllByRole('radio', { name: new RegExp(messages.attendanceWorkflow.v3.sequential) })).toHaveLength(2);
        expect(screen.getByText(messages.attendanceWorkflow.v3.limits)).toBeVisible();
    });
});
