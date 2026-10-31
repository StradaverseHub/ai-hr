import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PersonnelReview } from '../app/(app)/lifecycle/v9/personnel-review';
import type { Case } from '../lib/lifecycle-v9-model';
function fixture() { return { id: 'case', state: 'submitted', facts: { employmentId: 'employment' }, documents: [{ id: 'document', name: 'Contact update', fields: [{ pmKey: 'bankAcc', label: 'Bank account no.', sensitive: true }, { pmKey: 'mobile', label: 'Handphone no.', sensitive: false }] }], pmChanges: [{ id: 'bank', documentId: 'document', field: 'bankAcc', before: '123456789012', after: '987654321098', status: 'proposed' }, { id: 'phone', documentId: 'document', field: 'mobile', before: '0111111111', after: '0222222222', status: 'proposed' }, { id: 'unmapped', documentId: 'document', field: 'custom', before: '', after: 'unmapped', status: 'proposed' }] } as unknown as Case; }
it('masks sensitive proposals until explicitly revealed and pushes only checked supported fields', () => {
  const command = vi.fn(); render(<PersonnelReview c={fixture()} busy={false} writableKeys={['bankAcc', 'mobile']} command={command}/>);
  expect(screen.queryByText('123456789012')).not.toBeInTheDocument(); expect(screen.queryByText('987654321098')).not.toBeInTheDocument();
  expect(screen.getByText('•••• 1098')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show Bank account no.' }));
  expect(screen.getByText('987654321098')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide Bank account no.' }));
  expect(screen.queryByText('987654321098')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Push custom to Personnel Management' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Push Handphone no. to Personnel Management' }));
  fireEvent.click(screen.getByRole('button', { name: 'Push 1 change to PM' }));
  expect(command).toHaveBeenLastCalledWith({ type: 'pmPushSelected', ids: ['bank'] });
  fireEvent.click(screen.getByRole('button', { name: 'Keep on case only' }));
  expect(command).toHaveBeenLastCalledWith({ type: 'pmKeep', ids: ['bank', 'phone', 'unmapped'] });
});
it('prevents writeback on closed cases', () => {
  const c = fixture(); c.state = 'cleared'; render(<PersonnelReview c={c} busy={false} writableKeys={['bankAcc', 'mobile']} command={vi.fn()}/>);
  expect(screen.getByRole('button', { name: 'Push 2 changes to PM' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Keep on case only' })).toBeDisabled();
});
