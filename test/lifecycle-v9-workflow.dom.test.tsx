import { useState } from 'react';
import { beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WorkflowEditor } from '../app/lifecycle/v9/workflow-editor';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import type { Config } from '../lib/lifecycle-v9-model';
import { parseV9Config } from '../lib/lifecycle-v9-validation';

vi.mock('../components/onboarding-date-input', () => ({ OnboardingDateInput: ({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) => <input aria-label={label} value={value} onChange={e => onChange(e.target.value)}/> }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
function Harness({ editable = true }: { editable?: boolean }) {
  const [config, setConfig] = useState(() => { const config = v9Defaults(); config.groups.push({ id: 'fixture-reviewers', name: 'Fictional review group', members: ['11111111-1111-4111-8111-111111111111'], limit: 0 }); return config; }), [selected, select] = useState(''), [module, setModule] = useState<'off' | 'onb'>('off');
  return <><WorkflowEditor config={config} selected={selected} select={select} module={module} setModule={setModule} editable={editable} edit={change => setConfig(value => { const next = structuredClone(value); change(next); return next; })} cases={[]} users={[{ id: '11111111-1111-4111-8111-111111111111', name: 'Fictional reviewer' }]} actor={{ id: 'hr', name: 'HR' }} labels={{ caseType: { Resignation: 'Resignation' } }}/><output data-testid="definition">{JSON.stringify(config)}</output></>;
}
it('edits ordered steps and conditions into a definition accepted by the service validator', () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
  fireEvent.click(screen.getByRole('button', { name: 'For Offboarding' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit workflow' });
  fireEvent.change(within(drawer).getByLabelText('Workflow name'), { target: { value: 'Resignation review' } });
  fireEvent.click(within(drawer).getByRole('button', { name: 'Add condition' }));
  fireEvent.change(within(drawer).getByLabelText('Condition 1 value'), { target: { value: 'Resignation' } });
  fireEvent.click(within(drawer).getByRole('button', { name: 'Add a step' }));
  fireEvent.click(within(drawer).getByRole('button', { name: 'Notify someone' }));
  fireEvent.change(within(drawer).getByLabelText('Subject for step 1'), { target: { value: 'Review handover' } });
  fireEvent.click(within(drawer).getByRole('button', { name: 'To for step 1' }));
  fireEvent.click(within(within(drawer).getByRole('group', { name: 'To for step 1' })).getByRole('checkbox', { name: 'Employee' }));
  fireEvent.click(within(drawer).getByRole('button', { name: 'Add a step' }));
  fireEvent.click(within(drawer).getByRole('button', { name: 'Generate a document' }));
  expect(within(drawer).getByRole('button', { name: 'Make it live' })).toBeDisabled();
  fireEvent.change(within(drawer).getByLabelText('Document template for step 2'), { target: { value: 'txl' } });
  fireEvent.click(within(drawer).getByRole('button', { name: 'Move step 2 up' }));
  const config: Config = JSON.parse(screen.getByTestId('definition').textContent!);
  const created = config.workflows.at(-1)!;
  expect(created.name).toBe('Resignation review');
  expect(created.conditions).toEqual([{ field: 'caseType', op: 'is', value: 'Resignation' }]);
  expect(created.steps.map(s => s.type)).toEqual(['doc', 'notify']);
  expect(created.steps[1]).toMatchObject({ to: ['employee'] });
  expect(() => parseV9Config(config)).not.toThrow();
  expect(within(drawer).getByRole('region', { name: 'Dry run' })).toBeInTheDocument();
  fireEvent.click(within(drawer).getByRole('tab', { name: 'Run history (0)' }));
  expect(within(drawer).getByText('No runs yet.')).toBeInTheDocument();
});
it('keeps configuration controls read-only for a viewer', () => {
  render(<Harness editable={false}/>);
  expect(screen.getByRole('button', { name: 'New workflow' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare the resignation acceptance letter' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit workflow' });
  expect(within(drawer).getByLabelText('Workflow name')).toBeDisabled();
  expect(within(drawer).getByRole('button', { name: 'Add a step' })).toBeDisabled();
  expect(within(drawer).getByRole('button', { name: 'Add condition' })).toBeDisabled();
});
it('offers the source signature/manual/post-exit events with date controls only for date triggers',()=>{
  render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'New workflow'}));fireEvent.click(screen.getByRole('button',{name:'For Offboarding'}));
  const drawer=screen.getByRole('dialog',{name:'Edit workflow'}),trigger=within(drawer).getByLabelText('What starts it');
  fireEvent.change(trigger,{target:{value:'hrSigned'}});expect(within(drawer).queryByLabelText('Days')).not.toBeInTheDocument();
  fireEvent.change(trigger,{target:{value:'manual'}});expect(within(drawer).queryByLabelText('Days')).not.toBeInTheDocument();
  fireEvent.change(trigger,{target:{value:'afterLWD'}});expect(within(drawer).getByLabelText('Days')).toBeVisible();expect(within(drawer).queryByLabelText('Repeat every morning until the anchor date')).not.toBeInTheDocument();
  const config:Config=JSON.parse(screen.getByTestId('definition').textContent!);expect(config.workflows.at(-1)?.trigger).toMatchObject({event:'afterLWD',repeat:false});expect(()=>parseV9Config(config)).not.toThrow();
});

it('offers actual signatory and starter roles in To and CC selections',()=>{
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'New workflow'}));fireEvent.click(screen.getByRole('button',{name:'For Offboarding'}));const drawer=screen.getByRole('dialog',{name:'Edit workflow'});
 fireEvent.click(within(drawer).getByRole('button',{name:'Add a step'}));fireEvent.click(within(drawer).getByRole('button',{name:'Notify someone'}));fireEvent.click(within(drawer).getByRole('button',{name:'To for step 1'}));fireEvent.click(within(within(drawer).getByRole('group',{name:'To for step 1'})).getByRole('checkbox',{name:'Whoever started it'}));
 fireEvent.click(within(drawer).getByRole('button',{name:'CC for step 1'}));fireEvent.click(within(within(drawer).getByRole('group',{name:'CC for step 1'})).getByRole('checkbox',{name:'HR signatory'}));
 const config:Config=JSON.parse(screen.getByTestId('definition').textContent!);expect(config.workflows.at(-1)?.steps[0]).toMatchObject({to:['starter'],cc:['hrSignatory']});expect(()=>parseV9Config(config)).not.toThrow();
});

it('selects existing assignment groups and named people using stable references', () => {
  render(<Harness/>); fireEvent.click(screen.getByRole('button', { name: 'New workflow' })); fireEvent.click(screen.getByRole('button', { name: 'For Offboarding' }));
  const drawer = within(screen.getByRole('dialog', { name: 'Edit workflow' }));
  fireEvent.click(drawer.getByRole('button', { name: 'Add a step' })); fireEvent.click(drawer.getByRole('button', { name: 'Notify someone' }));
  fireEvent.click(drawer.getByRole('button', { name: 'To for step 1' }));
  fireEvent.change(drawer.getByRole('combobox', { name: 'Assignment group for To for step 1' }), { target: { value: 'fixture-reviewers' } });
  fireEvent.click(drawer.getByRole('button', { name: 'CC for step 1' }));
  fireEvent.change(drawer.getByRole('combobox', { name: 'Named person for CC for step 1' }), { target: { value: '11111111-1111-4111-8111-111111111111' } });
  const config: Config = JSON.parse(screen.getByTestId('definition').textContent!);
  expect(config.workflows.at(-1)!.steps[0]).toMatchObject({ to: ['group:fixture-reviewers'], cc: ['person:11111111-1111-4111-8111-111111111111'] });
  expect(parseV9Config(config).workflows.at(-1)!.steps[0]).toMatchObject({ to: ['group:fixture-reviewers'] });
  config.groups = config.groups.filter(group => group.id !== 'fixture-reviewers'); expect(() => parseV9Config(config)).toThrow('existing assignment group');
});

it('saves the supplied source-action triggers without exposing date-only controls', () => {
  render(<Harness/>); fireEvent.click(screen.getByRole('button', { name: 'New workflow' })); fireEvent.click(screen.getByRole('button', { name: 'For Onboarding' }));
  const drawer = within(screen.getByRole('dialog', { name: 'Edit workflow' }));
  for (const event of ['docSigned', 'taskDone', 'fileUploaded']) {
    fireEvent.change(drawer.getByLabelText('What starts it'), { target: { value: event } });
    expect(drawer.queryByLabelText('Days')).not.toBeInTheDocument();
    const config: Config = JSON.parse(screen.getByTestId('definition').textContent!);
    expect(parseV9Config(config).workflows.at(-1)!.trigger.event).toBe(event);
  }
});

it('adds a validated email address as a destination rather than a named person', () => {
  render(<Harness/>); fireEvent.click(screen.getByRole('button', { name: 'New workflow' })); fireEvent.click(screen.getByRole('button', { name: 'For Offboarding' }));
  const drawer = within(screen.getByRole('dialog', { name: 'Edit workflow' }));
  fireEvent.click(drawer.getByRole('button', { name: 'Add a step' })); fireEvent.click(drawer.getByRole('button', { name: 'Notify someone' })); fireEvent.click(drawer.getByRole('button', { name: 'To for step 1' }));
  const picker = within(drawer.getByRole('group', { name: 'To for step 1' }));
  expect(picker.getByRole('button', { name: 'Add email address' })).toBeDisabled();
  fireEvent.change(picker.getByRole('textbox', { name: 'Email address for To for step 1' }), { target: { value: 'team@fictional.invalid' } });
  fireEvent.click(picker.getByRole('button', { name: 'Add email address' }));
  const config: Config = JSON.parse(screen.getByTestId('definition').textContent!);
  expect(parseV9Config(config).workflows.at(-1)!.steps[0]).toMatchObject({ to: ['address:team@fictional.invalid'] });
});
