import { useState } from 'react';
import { beforeAll, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { WorkflowEditor } from '../app/lifecycle/v9/workflow-editor';
import type { WorkflowRemovalActions } from '../app/lifecycle/v9/workflow-removal';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import type { Config, Workflow } from '../lib/lifecycle-v9-model';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
const messages = JSON.parse(readFileSync('messages/en.json', 'utf8'));
const flow = (id: string, name: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name, module: 'off', status: 'draft', description: '', trigger: { event: 'submitted', days: 0, workdays: false, repeat: false, skipIf: '' }, conditions: [], steps: [{ id: 'notify', type: 'notify', subject: 'Fictional', body: '', to: ['employee'], cc: [] }], ...extra });
function fixture(): Config {
  const config = v9Defaults();
  config.workflows = [
    flow('unused', 'Fictional test workflow'),
    flow('used', 'Fictional welcome workflow', { status: 'published' }),
    flow('old', 'Fictional welcome workflow', { status: 'retired', retired: { at: '2026-11-02T03:00:00.000Z', by: { id: 'hr', name: 'Fictional HR' }, cases: 3, automatic: true } }),
  ];
  return config;
}
function actions(overrides: Partial<WorkflowRemovalActions> = {}): WorkflowRemovalActions {
  return { saved: true, preview: vi.fn(), remove: vi.fn(), restore: vi.fn(), changed: vi.fn(), ...overrides };
}
function Harness({ editable = true, removal }: { editable?: boolean; removal: WorkflowRemovalActions }) {
  const [config] = useState(fixture), [selected, select] = useState(''), [module, setModule] = useState<'off' | 'onb'>('off');
  return <NextIntlClientProvider locale="en" messages={messages}><WorkflowEditor config={config} selected={selected} select={select} module={module} setModule={setModule} editable={editable} edit={() => {}} cases={[]} users={[]} actor={{ id: 'hr', name: 'HR' }} labels={{}} removal={removal}/></NextIntlClientProvider>;
}
const preview = (extra: object) => ({ revision: 1, workflowId: 'unused', name: 'Fictional test workflow', module: 'off' as const, mode: 'delete' as const, cases: 0, automatic: false, when: 'Offboarding case is submitted', ...extra });

it('permanently deletes an unused workflow only after a confirmation that says it cannot be undone', async () => {
  const removal = actions({ preview: vi.fn().mockResolvedValue({ ok: true, preview: preview({}) }), remove: vi.fn().mockResolvedValue({ ok: true, result: { done: true, mode: 'delete', revision: 2 } }) });
  render(<Harness removal={removal}/>);
  const list = screen.getByRole('region', { name: 'Workflows' });
  expect(within(list).queryByText('Fictional welcome workflow', { selector: 'button' })).toBeInTheDocument();
  expect(within(list).getAllByRole('button', { name: /^Delete / })).toHaveLength(2);
  fireEvent.click(within(list).getByRole('button', { name: 'Delete Fictional test workflow' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Fictional test workflow?' });
  expect(await within(dialog).findByText('This workflow has never been used in a case. Deleting it is permanent and cannot be undone.')).toBeVisible();
  expect(removal.preview).toHaveBeenCalledWith('unused');
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete workflow' })); });
  expect(removal.remove).toHaveBeenCalledWith({ revision: 1, workflowId: 'unused', expected: { mode: 'delete', cases: 0, automatic: false } });
  expect(removal.changed).toHaveBeenCalledWith('Fictional test workflow was deleted.');
  expect(screen.queryByRole('dialog', { name: 'Delete Fictional test workflow?' })).toBeNull();
});

it('retires a used workflow, warns about its automatic start and re-confirms when usage changed', async () => {
  const first = preview({ workflowId: 'used', name: 'Fictional welcome workflow', mode: 'retire', cases: 3, automatic: true }), fresh = { ...first, revision: 2, cases: 4 };
  const remove = vi.fn().mockResolvedValueOnce({ ok: true, result: { done: false, preview: fresh } }).mockResolvedValueOnce({ ok: true, result: { done: true, mode: 'retire', revision: 3 } });
  const removal = actions({ preview: vi.fn().mockResolvedValue({ ok: true, preview: first }), remove });
  render(<Harness removal={removal}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Fictional welcome workflow' }));
  const dialog = await screen.findByRole('dialog', { name: 'Retire Fictional welcome workflow?' });
  expect(await within(dialog).findByText(/^3 cases have used this workflow, so it cannot be deleted\. It will be moved to Retired instead\./)).toBeVisible();
  expect(within(dialog).getByText('This workflow starts automatically when offboarding case is submitted. After it is removed, no workflow will start this way for new cases until another one is set up.')).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: 'Delete workflow' })).toBeNull();
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Retired' })); });
  expect(within(dialog).getByText('Something changed since you opened this. Review the updated details before confirming.')).toBeVisible();
  expect(within(dialog).getByText(/^4 cases have used this workflow/)).toBeVisible();
  expect(removal.changed).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Retired' })); });
  expect(remove).toHaveBeenLastCalledWith({ revision: 2, workflowId: 'used', expected: { mode: 'retire', cases: 4, automatic: true } });
  expect(removal.changed).toHaveBeenCalledWith('Fictional welcome workflow was moved to Retired.');
});

it('waits for unsaved settings before deleting and shows a refused action as an error', async () => {
  const removal = actions({ saved: false, preview: vi.fn().mockResolvedValue({ ok: false, error: 'You do not have permission to change this lifecycle record.' }) });
  render(<Harness removal={removal}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Fictional test workflow' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Fictional test workflow?' });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('You do not have permission to change this lifecycle record.');
  expect(within(dialog).getByText('Wait until your latest changes are saved, then try again.')).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: 'Delete workflow' })).toBeNull();
  expect(removal.remove).not.toHaveBeenCalled();
});

it('lists retired workflows separately and restores one as a draft after resolving a duplicate name', async () => {
  const removal = actions({ restore: vi.fn().mockResolvedValue({ ok: true, result: { revision: 2 } }) });
  render(<Harness removal={removal}/>);
  expect(within(screen.getByRole('region', { name: 'Workflows' })).getAllByText('Fictional welcome workflow')).toHaveLength(1);
  fireEvent.click(screen.getByRole('tab', { name: 'Retired (1)' }));
  const retired = screen.getByRole('region', { name: 'Retired' });
  expect(within(retired).getByText('Retired on 02/11/2026 by Fictional HR · used by 3 cases')).toBeVisible();
  expect(within(retired).getByText(/Restored workflows return as drafts\. Turn on automatic start separately when ready\./)).toBeVisible();
  fireEvent.click(within(retired).getByRole('button', { name: 'Restore Fictional welcome workflow' }));
  const dialog = screen.getByRole('dialog', { name: 'Restore Fictional welcome workflow?' });
  expect(within(dialog).getByText(/^It started automatically before it was retired, but it does not get that back\./)).toBeVisible();
  expect(within(dialog).getByText(/^An active workflow is already called Fictional welcome workflow\. Rename one of them/)).toBeVisible();
  const confirm = within(dialog).getByRole('button', { name: 'Restore workflow' });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText('Name for the restored workflow'), { target: { value: 'Fictional welcome workflow (2025)' } });
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Restore workflow' })); });
  expect(removal.restore).toHaveBeenCalledWith({ revision: fixture().revision, workflowId: 'old', name: 'Fictional welcome workflow (2025)' });
  expect(removal.changed).toHaveBeenCalledWith('Fictional welcome workflow (2025) was restored as a draft.');
});

it('opens a retired workflow read-only without a dry run or go-live control', () => {
  render(<Harness removal={actions()}/>);
  fireEvent.click(screen.getByRole('tab', { name: 'Retired (1)' }));
  fireEvent.click(within(screen.getByRole('region', { name: 'Retired' })).getByRole('button', { name: 'View' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit workflow' });
  expect(within(drawer).getByLabelText('Workflow name')).toBeDisabled();
  expect(within(drawer).getByText('This workflow is retired. It cannot start for new cases. Restore it to change it or use it again.')).toBeVisible();
  expect(within(drawer).queryByRole('region', { name: 'Dry run' })).toBeNull();
  expect(within(drawer).queryByRole('button', { name: 'Make it live' })).toBeNull();
});

it('hides Delete and Restore from people who cannot edit workflows', () => {
  render(<Harness editable={false} removal={actions()}/>);
  expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Retired (1)' }));
  expect(within(screen.getByRole('region', { name: 'Retired' })).getByText('Fictional welcome workflow')).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Restore / })).toBeNull();
});
