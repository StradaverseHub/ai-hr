import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import type { OnboardingTask } from '../packs/lifecycle/service';
import { todayInKualaLumpur } from '../lib/hr-date';
const mocks = vi.hoisted(() => ({ change: vi.fn(), load: vi.fn(), note: vi.fn(), seen: vi.fn(), refresh: vi.fn(), config: vi.fn(), tasks: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock('../app/lifecycle/onboarding/v31-actions', () => ({ changeOnboarding: mocks.change, loadOnboardingTask: mocks.load, writeOnboardingNote: mocks.note, markOnboardingSeen: mocks.seen, saveOnboardingConfig: mocks.config, saveOnboardingChecklistTasks: mocks.tasks }));
const { OnboardingSettings } = await import('../app/admin/lifecycle/onboarding/settings');
const { defaultConfig } = await import('../lib/onboarding-model');
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
    it('autosaves only checklist tasks, retains staged policy edits and sequences revisions', async () => {
        const config = defaultConfig('owner');
        config.checklists[0]!.tasks = [{id:'welcome',name:'Welcome',by:'group',group:'people-gbs',method:'manual',opens:null,due:1,gate:false}];
        let resolveFirst!: (value: {error:null;revision:number}) => void;
        mocks.tasks.mockImplementationOnce(() => new Promise(resolve => {resolveFirst = resolve;})).mockResolvedValue({error:null,revision:3});
        mocks.config.mockResolvedValue({error:null,revision:4});
        const context = {config,revision:1,actor:{id:'owner',module:true,master:false},directory:[{id:'owner',name:'Owner'}],checklistCounts:{},loads:{},availability:{},matchCounts:{},totalJoiners:0};
        const options = {businessGroup:[],company:[],department:[],title:[],grade:[],employmentType:[]};
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingSettings context={context as never} options={options as never}/></NextIntlClientProvider>);
        const count = screen.getByRole('checkbox', {name:'Count equipment and access in onboarding progress'});
        const initial = count.hasAttribute('checked');
        fireEvent.click(count);
        fireEvent.click(screen.getByRole('button',{name:'Checklist Management'}));
        const taskName = screen.getByRole('textbox',{name:'Task name'});
        fireEvent.change(taskName,{target:{value:'First change'}}); fireEvent.blur(taskName);
        await waitFor(() => expect(mocks.tasks).toHaveBeenCalledTimes(1));
        fireEvent.change(taskName,{target:{value:'Second change'}}); fireEvent.blur(taskName);
        expect(mocks.tasks).toHaveBeenCalledTimes(1);
        resolveFirst({error:null,revision:2});
        await waitFor(() => expect(mocks.tasks).toHaveBeenCalledTimes(2));
        expect(mocks.tasks.mock.calls[1]).toEqual([2,config.checklists[0]!.id,[{...config.checklists[0]!.tasks[0],name:'Second change'}]]);
        expect(mocks.config).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button',{name:'Onboarding settings'}));
        expect(screen.getByRole('checkbox',{name:'Count equipment and access in onboarding progress'})).toHaveProperty('checked',!initial);
        fireEvent.click(screen.getByRole('button',{name:'Save configuration'}));
        await waitFor(() => expect(mocks.config).toHaveBeenCalledWith(3,expect.objectContaining({countEquipment:!initial}),{},false));
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
