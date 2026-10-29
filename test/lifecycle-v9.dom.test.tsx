import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DocumentBody } from '../components/lifecycle-v9/document-body';
import { SignatureInput } from '../components/lifecycle-v9/signature-input';
import type { Document, Field } from '../lib/lifecycle-v9-model';

const field = (id: string, patch: Partial<Field> = {}): Field => ({ id, label: id, type: 'text', owner: 'employee', pmKey: null, required: false, sensitive: false, options: [], section: 'details', when: null, width: 'full', columns: [], ...patch });
const document = (fields: Field[]): Document => ({ id: 'document', templateId: 'template', version: 1, name: 'Details', status: 'sent', fields, blocks: fields.map(f => ({ id: 'b-' + f.id, type: 'field', fieldId: f.id, text: '', section: 'details' })), values: {}, edits: {}, hrSignature: null, employeeSignature: null, createdAt: '2026-10-29T00:00:00Z', sentAt: '2026-10-29T00:00:00Z' });
it('keeps Personnel values locked and conditional fields tied to their controlling answer', () => {
  const doc = document([field('Name', { owner: 'pmLocked' }), field('Marital status', { type: 'select', options: ['Single', 'Married'] }), field('Spouse name', { when: { field: 'Marital status', value: 'Married' } })]);
  const change = vi.fn(), view = render(<DocumentBody document={doc} editableBy="employee" values={{ Name: 'Actual Personnel value', 'Marital status': 'Single' }} change={change}/>);
  expect(screen.getByLabelText(/Name.*Personnel Management/)).toBeDisabled();
  expect(screen.queryByLabelText('Spouse name')).not.toBeInTheDocument();
  view.rerender(<DocumentBody document={doc} editableBy="employee" values={{ Name: 'Actual Personnel value', 'Marital status': 'Married' }} change={change}/>);
  fireEvent.change(screen.getByLabelText('Spouse name'), { target: { value: 'Proposed value' } });
  expect(change).toHaveBeenCalledWith('Spouse name', 'Proposed value');
  expect(screen.getByLabelText(/Name.*Personnel Management/)).toHaveValue('Actual Personnel value');
});
it('records structured table rows with the supplied columns', () => {
  const doc = document([field('Children', { type: 'table', columns: ['Name', 'NRIC'] })]), change = vi.fn();
  render(<DocumentBody document={doc} editableBy="employee" change={change}/>);
  expect(screen.getByRole('columnheader', { name: 'NRIC' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
  expect(change).toHaveBeenCalledWith('Children', '[["",""]]');
});
it('requires a typed name and explicit consent before signing', () => {
  const submit = vi.fn(); render(<SignatureInput busy={false} submit={submit}/>);
  const button = screen.getByRole('button', { name: 'Sign and submit' });
  expect(button).toBeDisabled(); fireEvent.change(screen.getByLabelText('Type your full name'), { target: { value: 'Employee Name' } });
  expect(button).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(button); expect(submit).toHaveBeenCalledWith({ method: 'typed', value: 'Employee Name', consent: true });
});
