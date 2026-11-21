// Board daa76ed4: the per-level Escalation Approval controls of the v4 level editor, in all six locales.
import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { AttendanceStageEditorV4, emptyAttendanceV4Level } from '../app/admin/attendance/approval-workflow/stage-editor-v4';
import type { AttendanceV4Level } from '../lib/attendance-workflow-v4';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';

const locales = { en, ms, zh, ta, th, vi } as const;
function Harness({ initial }: { initial: AttendanceV4Level[] }) {
    const [stages, setStages] = useState(initial);
    return <><AttendanceStageEditorV4 stages={stages} employees={[]} problems={[]} onChange={setStages}/><output data-testid="route">{JSON.stringify(stages)}</output></>;
}
const two = () => [emptyAttendanceV4Level(0), emptyAttendanceV4Level(1)];
const show = (initial: AttendanceV4Level[] = two(), locale: keyof typeof locales = 'en') => render(<NextIntlClientProvider locale={locale} messages={locales[locale]}><Harness initial={initial}/></NextIntlClientProvider>);
const saved = (): AttendanceV4Level[] => JSON.parse(screen.getByTestId('route').textContent!);
const t = en.attendanceWorkflow.v4;
afterEach(cleanup);

describe('Escalation Approval level controls', () => {
    it('offers the setting on every level except the last, which states it never escalates', () => {
        show();
        expect(screen.getAllByText(t.escalationLegend)).toHaveLength(1);
        expect(screen.getAllByRole('checkbox', { name: t.escalationEnable })).toHaveLength(1);
        expect(screen.getByText(t.escalationFinal)).toBeVisible();
    });
    it('enables the days field only when ticked and saves whole days', () => {
        show();
        const days = screen.getByLabelText(t.escalationDays) as HTMLInputElement;
        expect(days).toBeDisabled();
        expect(saved()[0]).not.toHaveProperty('escalateAfterDays');
        fireEvent.click(screen.getByRole('checkbox', { name: t.escalationEnable }));
        expect(days).toBeEnabled();
        expect(saved()[0].escalateAfterDays).toBe(3);
        fireEvent.change(days, { target: { value: '5' } });
        expect(saved()[0].escalateAfterDays).toBe(5);
        expect(saved()[1]).not.toHaveProperty('escalateAfterDays');
        fireEvent.click(screen.getByRole('checkbox', { name: t.escalationEnable }));
        expect(saved()[0]).not.toHaveProperty('escalateAfterDays');
        expect(days).toBeDisabled();
    });
    it('marks an invalid value instead of silently saving a different one', () => {
        show();
        fireEvent.click(screen.getByRole('checkbox', { name: t.escalationEnable }));
        const days = screen.getByLabelText(t.escalationDays);
        fireEvent.change(days, { target: { value: '0' } });
        expect(days).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByText(t.escalationInvalid)).toBeVisible();
        expect(saved()[0].escalateAfterDays).toBe(0);
    });
    it('drops the setting from a level that becomes the last one', () => {
        show([{ ...emptyAttendanceV4Level(0), escalateAfterDays: 4 }, emptyAttendanceV4Level(1)]);
        fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`${en.attendanceWorkflow.remove} ${en.attendanceWorkflow.stageNumber.replace('{number}', '2')}`) })[0]);
        expect(saved()).toHaveLength(1);
        expect(saved()[0]).not.toHaveProperty('escalateAfterDays');
        expect(screen.getByText(t.escalationFinal)).toBeVisible();
    });
    it.each(Object.keys(locales) as (keyof typeof locales)[])('renders translated controls in %s', locale => {
        show(two(), locale);
        const v4 = locales[locale].attendanceWorkflow.v4;
        for (const key of ['escalationLegend', 'escalationEnable', 'escalationDays', 'escalationHelp', 'escalationInvalid', 'escalationFinal'] as const) expect(v4[key]?.trim()).toBeTruthy();
        expect(screen.getByText(v4.escalationLegend)).toBeVisible();
        expect(screen.getByText(v4.escalationFinal)).toBeVisible();
        if (locale !== 'en') expect(v4.escalationLegend).not.toBe(en.attendanceWorkflow.v4.escalationLegend);
    });
});
