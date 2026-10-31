import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TemplateVersionHistory } from '../app/(app)/lifecycle/v9/template-version-history';
import type { Template } from '../lib/lifecycle-v9-model';
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeAll(() => Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } }));
afterAll(() => { if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); });
const template: Template = { id: 'template', name: 'Fictional versioned form', module: 'onb', type: 'Form', rules: {}, hrStep: 'none', employeeAck: false, retired: false, currentVersion: 2, versions: [1,2,3].map(version => ({ version, state: 'published', at: '29/10/2026', by: 'Fictional HR', blocks: [{ id: 'body', type: 'text', text: `Saved version ${version} content`, section: 'main' }], fields: [] })) };
it('keeps current and used versions while confirming deletion of an unused saved version', () => {
  const remove = vi.fn(), useVersion = vi.fn();
  render(<TemplateVersionHistory template={template} usage={[{ templateId: template.id, version: 1, documents: 2 }]} editable saved useVersion={useVersion} remove={remove}/>);
  expect(screen.getByRole('button', { name: 'Delete version 1' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete version 2' })).toBeDisabled();
  expect(screen.getByText('Used by 2 documents, so it is kept.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete version 3' })); expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete version 3' })); fireEvent.click(screen.getByRole('button', { name: 'Delete version 3' })); expect(remove).toHaveBeenCalledExactlyOnceWith(3);
  fireEvent.click(screen.getByRole('button', { name: 'Use version 1' })); expect(useVersion).toHaveBeenCalledExactlyOnceWith(1);
});
it('holds deletion until usage is known and previous setting changes are saved', () => {
  const props = { template, editable: true, saved: false, useVersion: vi.fn(), remove: vi.fn() };
  const view = render(<TemplateVersionHistory {...props}/>);
  expect(screen.getByRole('button', { name: 'Delete version 3' })).toBeDisabled();
  view.rerender(<TemplateVersionHistory {...props} usage={[]}/>);
  expect(screen.getByRole('button', { name: 'Delete version 3' })).toBeDisabled();
  expect(screen.getAllByText('Save current changes before deleting.')).toHaveLength(2);
  view.rerender(<TemplateVersionHistory {...props} usage={[]} saved/>);
  expect(screen.getByRole('button', { name: 'Delete version 3' })).toBeEnabled();
});
it('previews the selected historical content rather than the current version', () => {
  render(<TemplateVersionHistory template={template} usage={[]} editable saved useVersion={vi.fn()} remove={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Preview version 1' }));
  const dialog = screen.getByRole('dialog', { name: 'Fictional versioned form version 1' });
  expect(within(dialog).getByText('Saved version 1 content')).toBeInTheDocument();
  expect(within(dialog).queryByText('Saved version 2 content')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
