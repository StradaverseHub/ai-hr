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
  const [config, setConfig] = useState(v9Defaults), [selected, select] = useState(''), [module, setModule] = useState<'off' | 'onb'>('off');
  return <><WorkflowEditor config={config} selected={selected} select={select} module={module} setModule={setModule} editable={editable} edit={change => setConfig(value => { const next = structuredClone(value); change(next); return next; })} cases={[]} users={[]} actor={{ id: 'hr', name: 'HR' }} labels={{ caseType: { Resignation: 'Resignation' } }}/><output data-testid="definition">{JSON.stringify(config)}</output></>;
}
it('edits ordered steps and conditions into a definition accepted by the service validator', () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit workflow' });
  fireEvent.change(within(drawer).getByLabelText('Workflow name'), { target: { value: 'Resignation review' } });
  fireEvent.click(within(drawer).getByRole('button', { name: 'Add condition' }));
  fireEvent.change(within(drawer).getByLabelText('Condition 1 value'), { target: { value: 'Resignation' } });
  fireEvent.click(within(drawer).getByRole('button', { name: 'Add step' }));
  fireEvent.change(within(drawer).getByLabelText('Step 1'), { target: { value: 'notify' } });
  fireEvent.click(within(within(drawer).getByRole('group', { name: 'To for step 1' })).getByRole('checkbox', { name: 'Employee' }));
  fireEvent.click(within(drawer).getByRole('button', { name: 'Add step' }));
  fireEvent.click(within(drawer).getByRole('button', { name: 'Move step 2 up' }));
  const config: Config = JSON.parse(screen.getByTestId('definition').textContent!);
  const created = config.workflows.at(-1)!;
  expect(created.name).toBe('Resignation review');
  expect(created.conditions).toEqual([{ field: 'caseType', op: 'is', value: 'Resignation' }]);
  expect(created.steps.map(s => s.type)).toEqual(['doc', 'notify']);
  expect(created.steps[1]).toMatchObject({ to: ['taskOwners', 'employee'] });
  expect(() => parseV9Config(config)).not.toThrow();
  fireEvent.click(within(drawer).getByRole('tab', { name: 'Test' }));
  expect(within(drawer).getByRole('button', { name: 'Dry run' })).toBeDisabled();
});
it('keeps configuration controls read-only for a viewer', () => {
  render(<Harness editable={false}/>);
  expect(screen.getByRole('button', { name: 'New workflow' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare the resignation acceptance letter' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit workflow' });
  expect(within(drawer).getByLabelText('Workflow name')).toBeDisabled();
  expect(within(drawer).getByRole('button', { name: 'Add step' })).toBeDisabled();
  expect(within(drawer).getByRole('button', { name: 'Add condition' })).toBeDisabled();
});
