import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import type { OnboardingTask } from '../packs/lifecycle/service';
import { todayInKualaLumpur } from '../lib/hr-date';
const mocks = vi.hoisted(() => ({ change: vi.fn(), load: vi.fn(), note: vi.fn(), seen: vi.fn(), refresh: vi.fn(), config: vi.fn(), tasks: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock('../app/(app)/lifecycle/onboarding/v31-actions', () => ({ changeOnboarding: mocks.change, loadOnboardingTask: mocks.load, writeOnboardingNote: mocks.note, markOnboardingSeen: mocks.seen, saveOnboardingConfig: mocks.config, saveOnboardingChecklistTasks: mocks.tasks }));
const { OnboardingSettings } = await import('../app/(app)/admin/lifecycle/onboarding/settings');
const { Joiners } = await import('../app/(app)/lifecycle/onboarding/joiners');
const { OnboardingCaseView } = await import('../app/(app)/lifecycle/onboarding/case-view');
const { HistoricalOnboardingRequisition } = await import('../app/(app)/lifecycle/requisitions/onboarding/historical-view');
const { defaultConfig, blankCase, submitCase, handover, cancelCase, progress, dayDate, fulfil, reopenCase, currentReq, decide } = await import('../lib/onboarding-model');
const { TasksView } = await import('../app/(app)/tasks/tasks-view');
const { OnboardingDateInput } = await import('../components/onboarding-date-input');
const messages = (locale: string) => JSON.parse(readFileSync(new URL('../messages/' + locale + '.json', import.meta.url), 'utf8'));
const translation = (locale: string, text: string) => {
    const key = Object.entries(messages('en').onboardingV31.copy).find(([, value]) => value === text)?.[0];
    if (!key)
        throw Error('Unregistered text: ' + text);
    return messages(locale).onboardingV31.copy[key];
};
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
    it('autosaves checklist tasks without unrelated configuration writes and sequences revisions', async () => {
        const config = defaultConfig('owner');
        config.checklists[0]!.tasks = [{ id: 'welcome', name: 'Welcome', by: 'group', group: 'people-gbs', method: 'manual', opens: null, due: 1, gate: false }];
        let resolveFirst!: (value: {
            error: null;
            revision: number;
        }) => void;
        mocks.tasks.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockResolvedValue({ error: null, revision: 3 });
        mocks.config.mockResolvedValue({ error: null, revision: 4 });
        const context = { config, revision: 1, actor: { id: 'owner', module: true, master: false }, directory: [{ id: 'owner', name: 'Owner' }], checklistCounts: {}, loads: {}, availability: {}, matchCounts: {}, totalJoiners: 0 };
        const options = { businessGroup: [], company: [], department: [], title: [], grade: [], employmentType: [] };
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingSettings context={context as never} options={options as never} initialTab="checklists"/></NextIntlClientProvider>);
        const taskName = screen.getByRole('textbox', { name: 'Task name' });
        fireEvent.change(taskName, { target: { value: 'First change' } });
        fireEvent.blur(taskName);
        await waitFor(() => expect(mocks.tasks).toHaveBeenCalledTimes(1));
        fireEvent.change(taskName, { target: { value: 'Second change' } });
        fireEvent.blur(taskName);
        expect(mocks.tasks).toHaveBeenCalledTimes(1);
        resolveFirst({ error: null, revision: 2 });
        await waitFor(() => expect(mocks.tasks).toHaveBeenCalledTimes(2));
        expect(mocks.tasks.mock.calls[1]).toEqual([2, config.checklists[0]!.id, [{ ...config.checklists[0]!.tasks[0], name: 'Second change' }]]);
        expect(mocks.config).not.toHaveBeenCalled();

    });
    it('saves configuration as one revision after the administrator finishes the settings form',async()=>{
        const config=defaultConfig('owner');mocks.config.mockResolvedValue({error:null,revision:2});
        const context={config,revision:1,actor:{id:'owner',module:true,master:false},directory:[{id:'owner',name:'Owner'}],checklistCounts:{},loads:{},availability:{},matchCounts:{},totalJoiners:0};
        const options={businessGroup:[],company:[],department:[],title:[],grade:[],employmentType:[]};
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingSettings context={context as never} options={options as never}/></NextIntlClientProvider>);
        fireEvent.click(screen.getByRole('checkbox',{name:'Count equipment and access in onboarding progress'}));
        expect(mocks.config).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button',{name:'Save configuration'}));
        await waitFor(()=>expect(mocks.config).toHaveBeenCalledWith(1,expect.objectContaining({countEquipment:false}),{},false));
    });
    it('saves checklist metadata and creates a real definition before its queued task edits',async()=>{
        const config=defaultConfig('owner');let revision=1;
        mocks.config.mockImplementation(async()=>({error:null,revision:++revision}));
        const context={config,revision:1,actor:{id:'owner',module:true,master:false},directory:[{id:'owner',name:'Owner'}],checklistCounts:{},loads:{},availability:{},matchCounts:{},totalJoiners:0};
        const options={businessGroup:[],company:[],department:[],title:[],grade:[],employmentType:[]};
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingSettings context={context as never} options={options as never} initialTab="checklists"/></NextIntlClientProvider>);
        fireEvent.change(screen.getByRole('textbox',{name:'Checklist name'}),{target:{value:'Fictional operations checklist'}});
        fireEvent.blur(screen.getByRole('textbox',{name:'Checklist name'}));
        await waitFor(()=>expect(mocks.config).toHaveBeenCalledWith(1,expect.objectContaining({checklists:[expect.objectContaining({name:'Fictional operations checklist'})]}),{},false));
        await waitFor(()=>expect(screen.getByRole('button',{name:'New checklist'})).toBeEnabled());
        fireEvent.click(screen.getByRole('button',{name:'New checklist'}));
        await waitFor(()=>expect(mocks.config).toHaveBeenCalledTimes(2));
        fireEvent.click(screen.getByRole('button',{name:'Add task'}));
        await waitFor(()=>expect(mocks.config).toHaveBeenCalledTimes(3));
        expect(mocks.config.mock.calls.map(x=>x[0])).toEqual([1,2,3]);
        expect(mocks.config.mock.calls[2]![1].checklists[1].tasks).toHaveLength(1);
    });
    it('lets HR correct a task validation error and retry at the same settings revision', async () => {
        const config=defaultConfig('owner');config.checklists[0]!.tasks=[{id:'welcome',name:'Welcome',by:'group',group:'people-gbs',method:'manual',opens:null,due:1,gate:false}];
        mocks.tasks.mockReset().mockResolvedValueOnce({error:'Day 0 is invalid.',revision:null,code:'invalid'}).mockResolvedValueOnce({error:null,revision:2});
        const context={config,revision:1,actor:{id:'owner',module:true,master:false},directory:[{id:'owner',name:'Owner'}],checklistCounts:{},loads:{},availability:{},matchCounts:{},totalJoiners:0};
        const options={businessGroup:[],company:[],department:[],title:[],grade:[],employmentType:[]};
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingSettings context={context as never} options={options as never} initialTab="checklists"/></NextIntlClientProvider>);
        const due=screen.getByRole('spinbutton',{name:'Due by day Welcome'});
        fireEvent.change(due,{target:{value:'0'}});fireEvent.blur(due);
        expect(await screen.findByRole('alert')).toHaveTextContent('Day 0 is invalid.');
        fireEvent.change(due,{target:{value:'1'}});fireEvent.blur(due);
        await waitFor(()=>expect(mocks.tasks).toHaveBeenCalledTimes(2));
        expect(mocks.tasks.mock.calls.map(call=>call[0])).toEqual([1,1]);
        expect(await screen.findByRole('status')).toHaveTextContent('Changes saved');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    it('keeps a saved pending case open so HR can submit without reloading', async () => {
        const today = todayInKualaLumpur(), env = { today, now: today + 'T02:00:00.000Z', id: () => 'history', nextNumber: () => '', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: ['owner'] };
        const c = blankCase('case', 'OB-1', 'draft', { fullName: 'Fictional Hire', confirmationDate: '2027-01-01' }, env);
        const detail = { case: c, config: defaultConfig('owner'), revision: 7, actor: { id: 'owner', name: 'HR', module: true, hr: true, master: false }, directory: [], labels: {}, notes: [], availability: {}, today, canOpenRequisition: false };
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingCaseView detail={detail}/></NextIntlClientProvider>);
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await screen.findByText('Case details saved.');
        const local = mocks.change.mock.calls[0]![2].patch.local;
        for (const key of ['confirmationDate', 'finalConfirmationDate', 'probationEndDate', 'provisionalEndOn']) expect(local).not.toHaveProperty(key);
        expect(screen.getByRole('button', { name: 'Submit case and confirm checklist' })).toBeVisible();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    });
    it('updates required hiring fields immediately before a save',()=>{
        const today=todayInKualaLumpur(), env={today,now:new Date().toISOString(),id:()=> 'history',nextNumber:()=> '',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['owner']};
        const c=blankCase('case','OB-current','draft',{fullName:'Fictional Hire',joinDate:today,title:'title',department:'department',company:'company',supervisor:'owner'},env);
        const detail={case:c,config:defaultConfig('owner'),revision:7,actor:{id:'owner',name:'HR',module:true,hr:true,master:false},directory:[],labels:{},notes:[],availability:{},today,canOpenRequisition:false};
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingCaseView detail={detail}/></NextIntlClientProvider>);
        expect(screen.getByText('1 required fields missing')).toBeVisible();
        fireEvent.change(screen.getByRole('combobox',{name:'New hire or replacement*'}),{target:{value:'new_hire'}});
        expect(screen.getByText('All required fields complete')).toBeVisible();
        fireEvent.change(screen.getByRole('combobox',{name:'New hire or replacement*'}),{target:{value:'replacement'}});
        expect(screen.getByText('1 required fields missing')).toBeVisible();
        fireEvent.change(screen.getByRole('textbox',{name:'Employee being replaced*'}),{target:{value:'Fictional Former Employee'}});
        expect(screen.getByText('All required fields complete')).toBeVisible();
        expect(mocks.change).not.toHaveBeenCalled();
    });
    it('keeps checklist selection available on a submitted case and confirms through the history-preserving command',async()=>{
        const today=todayInKualaLumpur();let id=0;
        const env={today,now:new Date().toISOString(),id:()=>String(++id),nextNumber:()=> 'IT-'+(++id),leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['owner']};
        const config=defaultConfig('owner'),actor={id:'owner',name:'HR',module:true,hr:true,master:false};
        const c=blankCase('case','OB-current','draft',{fullName:'Fictional Hire',joinDate:dayDate(today,5),title:'position',company:'company',department:'department',supervisor:'owner'},env);c.hiring='new_hire';submitCase(config,c,actor,env);
        config.checklists.push({id:'alternative',name:'Alternative checklist',owner:'owner',createdAt:new Date().toISOString(),rules:{},tasks:[]});
        const detail={case:c,config,revision:7,actor,directory:[{id:'owner',name:'HR'}],labels:{},notes:[],availability:{},today,canOpenRequisition:true};
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingCaseView detail={detail}/></NextIntlClientProvider>);
        expect(screen.getByRole('button',{name:'Edit details'})).toBeVisible();
        fireEvent.change(screen.getByRole('combobox',{name:'Checklist choice'}),{target:{value:'alternative'}});
        fireEvent.click(screen.getByRole('button',{name:'Confirm selection'}));
        await waitFor(()=>expect(mocks.change).toHaveBeenCalledWith('case',7,{type:'saveSubmit',patch:expect.objectContaining({checklistOverride:'alternative'})}));
    });
    it('retains older unfinished equipment and pending preparation while recent filtering excludes old cancelled or completed work', () => {
        const today=todayInKualaLumpur(), join=dayDate(today,-40), actor={id:'owner',name:'HR',module:true,hr:true,master:false};
        let id=0;
        const env={today,now:today+'T02:00:00.000Z',id:()=>String(++id),nextNumber:()=> 'IT-'+(++id),leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['owner']};
        const config=defaultConfig('owner');config.groups.find(g=>g.id==='group-tech')!.members=['owner'];
        config.catalogue=[{id:'laptop',name:'Laptop',type:'device',active:true,rules:{},workflow:null,team:'group-tech',card:false}];
        const working=blankCase('working','OB-1','draft',{fullName:'Older equipment work',joinDate:join,company:'company',department:'dept',title:'job',supervisor:'manager'},env);
        working.personnelStatus='Active';working.hiring='new_hire';working.selected=['laptop'];submitCase(config,working,actor,env);
        const cancelled=structuredClone(working);cancelled.id='cancelled';cancelled.source.fullName='Old cancelled case';cancelCase(cancelled,'Test',actor,env);
        const complete=structuredClone(working);complete.id='complete';complete.source.fullName='Old completed case';complete.requisitions[0]!.items[0]!.state='ready';handover(config,complete,actor,env);
        const pending=blankCase('pending','OB-4','draft-4',{fullName:'Older pending preparation',joinDate:join},env);pending.personnelStatus='Active';
        const rows=[working,cancelled,complete,pending].map(c=>({case:c,revision:1,isNew:false,progress:progress(config,c)}));
        const options={businessGroup:[],company:[],department:[],title:[],grade:[],employmentType:[],supervisor:[]};
        render(<NextIntlClientProvider locale="en" messages={messages('en')}><Joiners rows={rows as never} config={config} options={options}/></NextIntlClientProvider>);
        expect(screen.getByRole('link',{name:'Older equipment work'})).toBeVisible();
        expect(screen.getByRole('link',{name:'Older pending preparation'})).toBeVisible();
        expect(screen.queryByRole('link',{name:'Old cancelled case'})).not.toBeInTheDocument();
        expect(screen.queryByRole('link',{name:'Old completed case'})).not.toBeInTheDocument();
        expect(screen.getByRole('button',{name:/Progress 0%.*Older pending preparation/})).toHaveTextContent('Pending submission');
        expect(screen.getByText('Due '+new Intl.DateTimeFormat('en',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(dayDate(join,-7)+'T00:00:00Z')))).toBeInTheDocument();
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


describe('prototype group editing and retained requisitions',()=>{
 it('searches within the chosen group and persists add/remove without changing other groups',async()=>{
  const config=defaultConfig('owner');config.groups[0]!.members=['owner'];let revision=1;
  mocks.config.mockImplementation(async()=>({error:null,revision:++revision}));
  const context={config,revision:1,actor:{id:'owner',module:true,master:false},directory:[{id:'owner',name:'Fictional HR'},{id:'colleague',name:'Fictional Colleague'}],checklistCounts:{},loads:{owner:2},availability:{},matchCounts:{},totalJoiners:0};
  const options={businessGroup:[],company:[],department:[],title:[],grade:[],employmentType:[]};
  render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingSettings context={context as never} options={options as never} initialTab="groups"/></NextIntlClientProvider>);
  const group=screen.getByRole('region',{name:'People GBS'});
  fireEvent.change(within(group).getByRole('searchbox',{name:'Search people to add to People GBS'}),{target:{value:'Colleague'}});
  fireEvent.click(within(group).getByRole('option',{name:'Fictional Colleague · Add'}));
  expect(within(group).getByRole('button',{name:'Remove from group Fictional Colleague · People GBS'})).toBeVisible();
  expect(within(group).queryByRole('listbox',{name:'Matching people'})).toBeNull();expect(mocks.config).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Save configuration'}));
  await waitFor(()=>expect(mocks.config).toHaveBeenCalledTimes(1));
  expect(mocks.config.mock.calls[0]![1].groups[0].members).toEqual(['owner','colleague']);
  expect(mocks.config.mock.calls[0]![1].groups.slice(1)).toEqual(config.groups.slice(1));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save configuration'})).toBeEnabled());
  fireEvent.click(within(group).getByRole('button',{name:'Remove from group Fictional Colleague · People GBS'}));
  fireEvent.click(screen.getByRole('button',{name:'Save configuration'}));
  await waitFor(()=>expect(mocks.config).toHaveBeenCalledTimes(2));
  expect(mocks.config.mock.calls[1]![0]).toBe(2);expect(mocks.config.mock.calls[1]![1].groups[0].members).toEqual(['owner']);
 });
 it('shows original approval mode and handed items read-only after cancellation and a new generation',()=>{
  const today=todayInKualaLumpur();let n=0;const env={today,now:new Date().toISOString(),id:()=> 'record-'+(++n),nextNumber:()=> 'IT-'+(++n),leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['owner','reviewer'],userNames:{owner:'Recorded Actor',reviewer:'Recorded Reviewer'}};
  const actor={id:'owner',name:'Recorded Actor',module:true,hr:true,master:false},config=defaultConfig('owner');
  config.groups.find(g=>g.id==='group-tech')!.members=['owner'];config.checklists[0]!.tasks=[];
  config.workflows=[{id:'fixture-approval',name:'Saved sequential policy',mode:'seq',steps:[{id:'step',label:'Recorded review',type:'person',target:'reviewer',method:'manual'}]}];
  config.catalogue=[{id:'system',name:'Fictional system',type:'system',active:true,rules:{},workflow:'fixture-approval',team:'group-tech',card:false}];
  const c=blankCase('case','OB-current','draft',{fullName:'Fictional Hire',joinDate:today,title:'title',department:'department',company:'company',supervisor:'owner'},env);c.hiring='new_hire';c.selected=['system'];submitCase(config,c,actor,env);
  const old=currentReq(c)!;decide(config,c,[old.items[0]!.id],'approve',{...actor,id:'reviewer',name:'Recorded Reviewer'},env);fulfil(config,c,old.items[0]!.id,'done',actor,env);handover(config,c,actor,env);cancelCase(c,'Other',actor,env);reopenCase(c,actor,env);config.workflows[0]!.mode='par';config.workflows[0]!.name='Current parallel policy';submitCase(config,c,actor,env);
  const detail={case:c,config,revision:3,actor,directory:[{id:'owner',name:'Recorded Actor'}],labels:{},notes:[],availability:{},today,canOpenRequisition:true};
  render(<NextIntlClientProvider locale="en" messages={messages('en')}><HistoricalOnboardingRequisition detail={detail as never} generation={old.id}/></NextIntlClientProvider>);
  expect(screen.getByText('Handed over')).toBeVisible();expect(screen.getByText('In sequence · Saved sequential policy')).toBeVisible();expect(screen.getByText(/Recorded review · Approved · Recorded Reviewer/)).toBeVisible();
  expect(screen.queryByText(/Current parallel policy/)).toBeNull();expect(screen.queryByRole('button')).toBeNull();expect(screen.queryByRole('combobox')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();
 });
});

it('shows an unlimited group as available without a zero-maximum workload meter', () => {
  const config = defaultConfig('owner'); config.groups[0]!.limit = 0;
  const context = { config, revision: 1, actor: { id: 'owner', module: true, master: false }, directory: [{ id: 'owner', name: 'Fictional HR' }], checklistCounts: {}, loads: { owner: 1500 }, availability: {}, matchCounts: {}, totalJoiners: 0 };
  const options = { businessGroup: [], company: [], department: [], title: [], grade: [], employmentType: [] };
  render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingSettings context={context as never} options={options as never} initialTab="groups"/></NextIntlClientProvider>);
  const group = within(screen.getByRole('region', { name: 'People GBS' }));
  expect(group.getByText('Available')).toBeVisible(); expect(group.queryByText('At limit')).not.toBeInTheDocument();
  expect(group.getByText(/No task limit/)).toBeVisible(); expect(group.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(group.getByRole('spinbutton', { name: 'Open onboarding task limit per person' })).toHaveAttribute('min', '0');
});
it('renders a group viewer with read-only case/checklist controls and no case-action buttons',async()=>{
 const {JOINER_SECTION_PRESETS}=await import('../lib/onboarding-page-access');const {defaultV9CaseFields}=await import('../lib/lifecycle-v9-case-form');
 const today=todayInKualaLumpur(),env={today,now:today+'T02:00:00Z',id:()=> 'fictional-id',nextNumber:()=> 'IT-1',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['owner','viewer']};
 const config=defaultConfig('owner');config.v9CaseFields=defaultV9CaseFields('onb');config.v9ChecklistRevision=1;
 const c=blankCase('case','OB-view','draft',{fullName:'Fictional read-only joiner',company:'company',department:'department',title:'position',joinDate:today,supervisor:'fictional-supervisor-employment'},env);
 const detail={case:c,config,revision:1,actor:{id:'viewer',name:'Fictional viewer',module:false,page:true,caseActions:false,sections:JOINER_SECTION_PRESETS.coord,hr:false,master:false},directory:[],labels:{supervisor:'Fictional named manager'},notes:[],availability:{},today,canOpenRequisition:false};
 render(<NextIntlClientProvider locale="en" messages={messages('en')}><OnboardingCaseView detail={detail} registerHref="/lifecycle/v9" options={{supervisor:[],company:[],department:[],businessGroup:[],title:[],grade:[],employmentType:[]}}/></NextIntlClientProvider>);
 expect(screen.getByText('Fictional named manager')).toBeInTheDocument();expect(screen.queryByText('fictional-supervisor-employment')).not.toBeInTheDocument();
 expect(screen.getByRole('heading',{name:'Fictional read-only joiner'})).toBeVisible();
 expect(screen.queryByRole('button',{name:'Cancel onboarding case'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Submit case and confirm checklist'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Save'})).not.toBeInTheDocument();
 expect(screen.getByRole('combobox',{name:'Checklist choice'})).toBeDisabled();expect(mocks.change).not.toHaveBeenCalled();
});
