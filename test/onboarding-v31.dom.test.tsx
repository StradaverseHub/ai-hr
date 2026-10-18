import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import type { OnboardingTask } from '../packs/lifecycle/service';
import { todayInKualaLumpur } from '../lib/hr-date';
const mocks = vi.hoisted(() => ({ change: vi.fn(), load: vi.fn(), note: vi.fn(), seen: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock('../app/lifecycle/onboarding/v31-actions', () => ({ changeOnboarding: mocks.change, loadOnboardingTask: mocks.load, writeOnboardingNote: mocks.note, markOnboardingSeen: mocks.seen }));
const { TasksView } = await import('../app/tasks/tasks-view');
const { OnboardingDateInput } = await import('../components/onboarding-date-input');
const messages = (locale: string) => JSON.parse(readFileSync(new URL('../messages/' + locale + '.json', import.meta.url), 'utf8'));
const translation = (locale: string, text: string) => { const key = Object.entries(messages('en').onboardingV31.copy).find(([, value]) => value === text)?.[0]; if (!key)
    throw Error('Unregistered text: ' + text); return messages(locale).onboardingV31.copy[key]; };
const task: OnboardingTask = { id: 'case:checklist:welcome', caseId: 'case', revision: 7, kind: 'checklist', taskId: 'welcome', title: 'Prepare fictional welcome pack', joiner: 'Fictional Haziq', businessGroup: 'Manufacturing', joinDate: todayInKualaLumpur(), due: todayInKualaLumpur(), overdue: false, assigned: true, tagged: false, team: false, status: 'todo' };
beforeEach(() => { vi.clearAllMocks(); mocks.change.mockResolvedValue({ error: null, revision: 8, fields: [] }); mocks.seen.mockResolvedValue(undefined); });
describe('V3.1 localized task controls', () => {
    it.each(['en', 'ms', 'zh', 'ta', 'th', 'vi'])('renders translated controls while sending canonical status in %s', async (locale) => {
        render(<NextIntlClientProvider locale={locale} messages={messages(locale)} timeZone="Asia/Kuala_Lumpur"><TasksView items={[task]} existing={[]}/></NextIntlClientProvider>);
        const select = screen.getByRole('combobox', { name: translation(locale, 'Status') });
        expect(screen.getByRole('option', { name: translation(locale, 'Done') })).toHaveValue('done');
        fireEvent.change(select, { target: { value: 'done' } });
        await waitFor(() => expect(mocks.change).toHaveBeenCalledWith('case', 7, { type: 'task', taskId: 'welcome', status: 'done' }));
        expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
    it('keeps a future task visible with its status control locked', () => {
        render(<NextIntlClientProvider locale="en" messages={messages('en')} timeZone="Asia/Kuala_Lumpur"><TasksView items={[{ ...task, locked: true, lockReason: 'After Day 1 handover' }]} existing={[]}/></NextIntlClientProvider>);
        expect(screen.getByRole('combobox', { name: translation('en', 'Status') })).toBeDisabled();
        expect(screen.getByText(/After Day 1 handover/)).toBeVisible();
    });
    it('accepts partial date typing, auto slashes and reports an invalid date after blur', () => {
        const onChange = vi.fn();
        const view = render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingDateInput value="" label="Joining date" onChange={onChange}/></NextIntlClientProvider>);
        fireEvent.change(screen.getByRole('textbox', { name: 'Joining date' }), { target: { value: '32132026' } });
        expect(onChange).toHaveBeenCalledWith('32/13/2026');
        view.rerender(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingDateInput value="32/13/2026" label="Joining date" onChange={onChange}/></NextIntlClientProvider>);
        fireEvent.blur(screen.getByRole('textbox', { name: 'Joining date' }));
        expect(screen.getByRole('alert')).toBeVisible();
    });
});
