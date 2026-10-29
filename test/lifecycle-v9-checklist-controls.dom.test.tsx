import { useState } from 'react';
import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChecklistEditor } from '../app/lifecycle/v9/workspace';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
function Editor() {
  const [config, setConfig] = useState(() => { const value = v9Defaults(); value.checklists = [{ ...value.checklists.find(checklist => checklist.module === 'onb')!, id: 'fixture', name: 'Fixture checklist', tasks: [{ id: 'fixture-task', name: 'Fictional task', by: 'group', group: value.groups[0]?.id ?? null, mode: 'rr', opens: null, due: 1, required: false, documentTemplate: null, documentAction: 'signed' }] }]; return value; });
  return <><ChecklistEditor config={config} module="onb" selected="fixture" select={() => {}} editable edit={change => setConfig(old => { const next = structuredClone(old); change(next); return next; })}/><output data-testid="config">{JSON.stringify(config)}</output></>;
}
it('persists manual assignment and required flags while locking assignment mode for a joiner-owned task', () => {
  render(<Editor/>);
  fireEvent.change(screen.getByRole('combobox', { name: 'Assignment for Fictional task' }), { target: { value: 'manual' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Required: Fictional task' }));
  expect(JSON.parse(screen.getByTestId('config').textContent!).checklists[0].tasks[0]).toMatchObject({ id: 'fixture-task', mode: 'manual', required: true });
  fireEvent.change(screen.getByRole('combobox', { name: 'Completed by' }), { target: { value: 'employee' } });
  expect(screen.getByRole('combobox', { name: 'Assignment for Fictional task' })).toBeDisabled();
});
