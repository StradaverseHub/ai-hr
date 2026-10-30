import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RequestRecords } from '../app/lifecycle/v9/request-records';
import { WorkAssignee } from '../app/lifecycle/v9/work-assignee';
import { ChecklistBulkAssignment } from '../app/lifecycle/v9/checklist-bulk-assignment';
import { TaskQueue } from '../app/lifecycle/v9/task-queue';
import { lifecycleQueueRows } from '../lib/lifecycle-v9-task-queue';
import { blankCase, defaultConfig, type Environment, type Task } from '../lib/onboarding-model';
import type { Case as V9Case, Task as V9Task } from '../lib/lifecycle-v9-model';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import type { NativeJoinersData } from '../app/lifecycle/v9/native-joiners';
const mocks = vi.hoisted(() => ({ native: vi.fn(), off: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('../app/lifecycle/onboarding/v31-actions', () => ({ changeOnboarding: mocks.native }));
vi.mock('../app/lifecycle/v9/actions', () => ({ commandV9: mocks.off }));
function fixture() {
  const nativeConfig = defaultConfig('hr'); nativeConfig.groups = [{ id: 'shared', name: 'Shared team', members: ['hr'], limit: 0 }];
  const nativeCase = blankCase('same-case-id', 'OB-1', 'draft', { fullName: 'Native person', joinDate: '2026-10-30', company: 'one' }, { now: '2026-10-30T00:00:00Z' } as Environment);
  nativeCase.state = 'submitted';
  const task: Task = { id: 'same-task-id', name: 'Native owned work', by: 'group', group: 'shared', method: 'manual', opens: null, due: 1, gate: false, opensOn: null, dueOn: '2026-10-30', assignee: 'hr', status: 'todo', failure: null, checklistId: 'checklist', checklistName: 'Checklist', assignedAt: null, completedAt: null, completedBy: null };
  nativeCase.tasks = [task, { ...task, id: 'team-work', name: 'Native team work', assignee: 'other' }, { ...task, id: 'done-work', name: 'Native completed work', status: 'done' }];
  const native = { config: nativeConfig, rows: [{ case: nativeCase, revision: 17 }], options: { company: [], department: [], businessGroup: [], grade: [], title: [], employmentType: [], supervisor: [] } } as unknown as NativeJoinersData;
  const config = v9Defaults(); config.groups = nativeConfig.groups;
  const offTask: V9Task = { id: 'same-task-id', name: 'Offboarding owned work', by: 'group', group: 'shared', mode: 'rr', opens: null, due: 0, required: true, documentTemplate: null, documentAction: 'signed', opensOn: null, dueOn: '2026-10-30', assignee: 'hr', status: 'todo', reason: '', assignmentFailure: null };
  const off = { id: 'same-case-id', number: 'OFB-0009', revision: 29, module: 'off', state: 'submitted', facts: { name: 'Offboarding person', businessGroup: '', company: 'two' }, tasks: [offTask], items: [] } as unknown as V9Case;
  return { native, config, cases: [off], actor: 'hr', users: [{ id: 'hr', name: 'HR' }, { id: 'other', name: 'Teammate' }], company: '', search: '', openCase: vi.fn() };
}
it('retains canonical IDs and revisions across both owners without mutating their snapshots', () => {
  const props = fixture(), before = JSON.stringify(props);
  const rows = lifecycleQueueRows(props.cases, props.config, props.native, 'hr', '2026-10-30');
  expect(rows).toHaveLength(4); expect(new Set(rows.map(row => row.id)).size).toBe(4);
  expect(rows.find(row => row.title === 'Native owned work')).toMatchObject({ owner: 'native', revision: 17, taskId: 'same-task-id', mine: true, team: true });
  expect(rows.find(row => row.title === 'Offboarding owned work')).toMatchObject({ owner: 'v9', revision: 29, taskId: 'same-task-id', mine: true });
  expect(JSON.stringify(props)).toBe(before);
});
it('combines Mine, My teams and Done and sends status to the correct owner and revision', async () => {
  mocks.native.mockResolvedValue({ error: null }); mocks.off.mockResolvedValue({ ok: true });
  render(<TaskQueue {...fixture()}/>);
  expect(screen.getByText('Native owned work')).toBeVisible(); expect(screen.getByText('Offboarding owned work')).toBeVisible();
  expect(screen.queryByText('Native team work')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Status for Native owned work · Native person' }), { target: { value: 'progress' } });
  await waitFor(() => expect(mocks.native).toHaveBeenCalledWith('same-case-id', 17, { type: 'task', taskId: 'same-task-id', status: 'progress' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Status for Offboarding owned work · Offboarding person' })).toBeEnabled());
  fireEvent.change(screen.getByRole('combobox', { name: 'Status for Offboarding owned work · Offboarding person' }), { target: { value: 'done' } });
  await waitFor(() => expect(mocks.off).toHaveBeenCalledWith('same-case-id', 29, { type: 'task', id: 'same-task-id', status: 'done', reason: '' }));
  fireEvent.click(screen.getByRole('tab', { name: /My teams/ })); expect(screen.getByText('Native team work')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Assignee for Native team work · Native person' })).toBeEnabled());
  fireEvent.change(screen.getByRole('combobox', { name: 'Assignee for Native team work · Native person' }), { target: { value: 'hr' } });
  await waitFor(() => expect(mocks.native).toHaveBeenCalledWith('same-case-id', 17, { type: 'assignTask', taskId: 'team-work', user: 'hr', roundRobin: false }));
  fireEvent.click(screen.getByRole('tab', { name: /Done/ })); expect(screen.getByText('Native completed work')).toBeVisible(); expect(screen.queryByText('Native owned work')).not.toBeInTheDocument();
});
it('keeps a rejected save visible and applies company filtering to both owners', async () => {
  const props = fixture(); mocks.off.mockResolvedValue({ ok: false, error: 'Case changed. Reload before saving.' });
  render(<TaskQueue {...props} company="two"/>);
  expect(screen.queryByText('Native owned work')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Status for Offboarding owned work · Offboarding person' }), { target: { value: 'done' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Case changed. Reload before saving.');
  expect(screen.getByRole('combobox', { name: 'Status for Offboarding owned work · Offboarding person' })).toHaveValue('todo');
});

it('combines the canonical REQ and RVK records and retains native request numbers and case links', () => {
  const props = fixture(), c = props.native.rows[0].case;
  c.requisitions.push({ id: 'request', number: 'IT-REQ-0042', createdAt: '2026-10-30T00:00:00Z', cancelledAt: null, handedAt: null, items: [], hrNote: '', noteVersion: 0, noteAcks: {} });
  render(<RequestRecords {...props} labels={{}}/>);
  expect(screen.getByRole('link', { name: 'IT-REQ-0042' })).toHaveAttribute('href', '/lifecycle/requisitions/onboarding/same-case-id');
  expect(screen.getByRole('button', { name: 'RVK-0009' })).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'Request type' }), { target: { value: 'off' } });
  expect(screen.queryByRole('link', { name: 'IT-REQ-0042' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'RVK-0009' })); expect(props.openCase).toHaveBeenCalledWith('same-case-id');
});

it('routes return/revoke ownership and progress to the item owner, preserving completed owners',async()=>{
  const props=fixture();props.cases[0].items=[{id:'return-device',name:'Fictional return',kind:'device',sourceId:null,group:'shared',assignee:'hr',dueOn:'2026-11-01',status:'todo',reason:''},{id:'closed-device',name:'Completed return',kind:'device',sourceId:null,group:'shared',assignee:'hr',dueOn:'2026-10-01',status:'done',reason:''}];
  mocks.off.mockResolvedValue({ok:true});render(<TaskQueue {...props}/>);
  fireEvent.change(screen.getByRole('combobox',{name:'Assignee for Fictional return · Offboarding person'}),{target:{value:'hr'}});
  await waitFor(()=>expect(mocks.off).toHaveBeenCalledWith('same-case-id',29,{type:'assignItem',id:'return-device',userId:'hr'}));
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'Status for Fictional return · Offboarding person'})).toBeEnabled());
  fireEvent.change(screen.getByRole('combobox',{name:'Status for Fictional return · Offboarding person'}),{target:{value:'progress'}});
  await waitFor(()=>expect(mocks.off).toHaveBeenCalledWith('same-case-id',29,{type:'item',id:'return-device',status:'progress',reason:''}));
  fireEvent.click(screen.getByRole('tab',{name:/Done/}));expect(screen.getByText('Completed return')).toBeVisible();
  expect(screen.queryByRole('combobox',{name:'Assignee for Completed return · Offboarding person'})).not.toBeInTheDocument();
});

it('requires an explicit bulk group-assignment selection before applying',()=>{
  const checklist=v9Defaults().checklists.find(checklist=>checklist.module==='off')!,change=vi.fn();
  render(<ChecklistBulkAssignment checklist={checklist} editable change={change}/>);
  fireEvent.click(screen.getByRole('button',{name:'Set assignment for all group tasks'}));
  expect(screen.getByRole('button',{name:'Apply to group tasks'})).toBeDisabled();
  fireEvent.click(screen.getByRole('radio',{name:/Manual for all group tasks/}));
  fireEvent.click(screen.getByRole('button',{name:'Apply to group tasks'}));expect(change).toHaveBeenCalledExactlyOnceWith('manual');
  expect(screen.getByRole('button',{name:'Set assignment for all group tasks'})).toHaveAttribute('aria-expanded','false');
});

it('offers only actual providing-group members and preserves an unavailable recorded owner',()=>{
  const config=v9Defaults();config.groups=[{id:'fulfilling',name:'Providing team',members:['eligible'],limit:4}];const change=vi.fn();
  const view=render(<WorkAssignee name="Fictional device" group="fulfilling" assignee="historical" config={config} users={[{id:'eligible',name:'Eligible member'},{id:'outsider',name:'Other team'},{id:'historical',name:'Historical owner'}]} busy={false} editable change={change}/>);
  const picker=screen.getByRole('combobox',{name:'Assignee for Fictional device'});expect(screen.queryByRole('option',{name:'Other team'})).not.toBeInTheDocument();expect(screen.getByRole('option',{name:'Historical owner'})).toBeDisabled();
  fireEvent.change(picker,{target:{value:'eligible'}});expect(change).toHaveBeenCalledExactlyOnceWith('eligible');
  view.rerender(<WorkAssignee name="Fictional device" group="fulfilling" assignee="historical" config={config} users={[]} busy={false} editable={false} change={change}/>);expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

it('exports exactly the currently filtered, authorized request rows and escapes spreadsheet formula text', () => {
  const props=fixture();props.cases[0].facts.name='=HYPERLINK("fictional")';
  render(<RequestRecords cases={props.cases} native={null} labels={{}} company="" search="" openCase={props.openCase}/>);
  fireEvent.click(screen.getByRole('button',{name:'Export (CSV)'}));
  expect((screen.getByRole('textbox',{name:'Request records CSV'}) as HTMLTextAreaElement).value).toContain("'=HYPERLINK");
  fireEvent.change(screen.getByRole('combobox',{name:'Request type'}),{target:{value:'onb'}});
  expect((screen.getByRole('textbox',{name:'Request records CSV'}) as HTMLTextAreaElement).value.trim().split('\r\n')).toHaveLength(1);
  expect((screen.getByRole('textbox',{name:'Request records CSV'}) as HTMLTextAreaElement).value).not.toContain('fictional');
});
it('exports the eleven reference columns with labels, real item names, not-returned markers and clearance time',()=>{
 const props=fixture(),c=props.cases[0];c.facts.title='position';c.facts.businessGroup='group';c.facts.lastDay='2026-10-30';c.state='cleared';c.closedAt='2026-10-30T10:00:00Z';c.items=[{name:'Fictional laptop',status:'notReturned'} as V9Case['items'][number]];
 render(<RequestRecords cases={props.cases} native={null} labels={{title:{position:'Site engineer'},businessGroup:{group:'Fictional group'}}} company="two" search="Offboarding person" openCase={props.openCase}/>);
 fireEvent.click(screen.getByRole('button',{name:'Export (CSV)'}));
 const csv=(screen.getByRole('textbox',{name:'Request records CSV'}) as HTMLTextAreaElement).value;
 expect(csv.split(/\r?\n/)[0]).toBe('Type,Request,Case,Person,Job title,Business Group,Join date / last working day,Status,Done,Items,Handed over / cleared');
 expect(csv).toContain('Site engineer,Fictional group,2026-10-30,Cleared,1/1,Fictional laptop (not returned),2026-10-30T10:00:00Z');
});
