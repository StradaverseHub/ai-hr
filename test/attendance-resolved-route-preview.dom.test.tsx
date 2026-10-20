import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { AttendanceResolvedRoutePreview } from '../components/attendance-resolved-route-preview';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import { createTranslator } from 'next-intl';
afterEach(cleanup);
describe('resolved Attendance route presentation', () => {
    it.each([['en', en], ['ms', ms], ['zh', zh], ['ta', ta], ['th', th], ['vi', vi]] as const)('renders resolved people and explicit HR alternatives in %s', (locale, messages) => {
        const t = createTranslator({ locale, messages, namespace: 'attendanceWorkflow' });
        render(<AttendanceResolvedRoutePreview stages={[
            { name: 'Level 1', approvers: [{ kind: 'direct_manager', employmentId: 'frozen-manager', name: 'Fictional supervisor' }, { kind: 'hr_admin', employmentId: null, name: 'HR administrators' }] },
            { name: 'Level 2', approvers: [{ kind: 'direct_manager', employmentId: 'frozen-superior', name: 'Fictional superior' }] },
        ]} routingVersion={2} levelName={number => t('stageNumber', { number })} hrLabel={t('hr')} alternativeLabel={t('or')}/>);
        const levels = screen.getAllByRole('listitem');
        expect(levels).toHaveLength(2);
        expect(within(levels[0]).getByText(t('stageNumber', { number: 1 }))).toBeVisible();
        expect(levels[0]).toHaveTextContent(`Fictional supervisor ${t('or')} ${t('hr')}`);
        expect(levels[1]).toHaveTextContent('Fictional superior');
        expect(screen.queryByText('frozen-manager')).toBeNull();
    });
    it('retains the historic custom level name for a legacy route', () => {
        render(<AttendanceResolvedRoutePreview stages={[{ name: 'Original payroll review', approvers: [{ kind: 'hr_admin', employmentId: null, name: 'HR administrators' }] }]} routingVersion={1} levelName={number => `Level ${number}`} hrLabel="HR" alternativeLabel="or"/>);
        expect(screen.getByText('Original payroll review')).toBeVisible();
    });
    it('does not fabricate a resolved route for empty or refused preview rows', () => {
        const { container } = render(<AttendanceResolvedRoutePreview stages={[]} routingVersion={2} levelName={number => `Level ${number}`} hrLabel="HR" alternativeLabel="or"/>);
        expect(container).toBeEmptyDOMElement();
    });
});
