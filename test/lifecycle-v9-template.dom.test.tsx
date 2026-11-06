import { useState } from 'react';
import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TemplateVersionEditor } from '../app/lifecycle/v9/template-version-editor';
import type { TemplateVersion } from '../lib/lifecycle-v9-model';

function Harness({ disabled = false, picker = false }: { disabled?: boolean; picker?: boolean }) {
  const [version, setVersion] = useState<TemplateVersion>({ version: 2, state: 'draft', at: '', by: '', blocks: [{ id: 'heading', type: 'heading', text: 'Personal details', section: 'main' }], fields: [] });
  return <><TemplateVersionEditor personnelPicker={picker} previewCases={picker ? [{ id: 'fixture', label: 'Fictional Person' }] : []} loadPreview={async () => ({ ok: true, values: { 'joiner.joinDate': '06/11/2026' } })} version={version} name="Personal details" disabled={disabled} change={change => setVersion(value => { const next = structuredClone(value); change(next); return next; })}/><output data-testid="version">{JSON.stringify(version)}</output></>;
}
it('creates an editable structured field, its display block and a read-only preview', () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('tab', { name: 'Fields' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
  fireEvent.change(screen.getByLabelText('Field 1 label'), { target: { value: 'Children' } });
  fireEvent.change(screen.getByLabelText('Field 1 type'), { target: { value: 'table' } });
  fireEvent.change(screen.getByLabelText('Field 1 columns'), { target: { value: 'Name\nDate of birth' } });
  fireEvent.change(screen.getByLabelText('Field 1 width'), { target: { value: 'half' } });
  const version: TemplateVersion = JSON.parse(screen.getByTestId('version').textContent!);
  expect(version.fields[0]).toMatchObject({ label: 'Children', type: 'table', columns: ['Name', 'Date of birth'], width: 'half' });
  expect(version.blocks[1]).toMatchObject({ type: 'field', fieldId: version.fields[0].id });
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  expect(screen.getByRole('columnheader', { name: 'Date of birth' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add row' })).not.toBeInTheDocument();
});
it('prevents edits to published content', () => {
  render(<Harness disabled/>);
  expect(screen.getByLabelText('Heading 1')).toBeDisabled();
  expect(screen.getByLabelText('Add block')).toBeDisabled();
  fireEvent.click(screen.getByRole('tab', { name: 'Fields' }));
  expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
});

it('loads selected Personnel values and renders a typed prefilled date in preview', async () => {
  render(<Harness picker/>);
  fireEvent.change(screen.getByLabelText('Preview values for'), { target: { value: 'fixture' } });
  fireEvent.change(screen.getByLabelText('Search merge fields'), { target: { value: 'Join date' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add Join date as a pre-filled field' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  expect(await screen.findByDisplayValue('2026-11-06')).toBeDisabled();
});
