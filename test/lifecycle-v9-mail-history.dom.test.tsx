import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaseMailHistory } from '../app/(app)/lifecycle/v9/mail-history';
import type { Mail } from '../lib/lifecycle-v9-model';
const failed = (): Mail => ({ id: 'fictional-delivery', key: 'fictional-key', workflowId: 'workflow', templateId: null, to: ['employee'], cc: [], subject: 'Fictional saved message', body: 'Original saved content', documentIds: [], fileIds: [], status: 'failed', test: false, at: '2026-10-29T02:00:00Z', deliveredAt: null, failure: 'smtpTemporary', delivery: { version: 1, queuedBy: { id: 'hr', name: 'Fictional HR' }, sender: 'hr', linkDocumentIds: [], pdfDocumentIds: [], toNames: ['Fictional employee'], ccNames: [] } });
it('requires a review reason and queues a new retry without relabeling the failed receipt as sent', async () => {
  const mail = failed(), command = vi.fn().mockResolvedValue({ ok: true });
  render(<CaseMailHistory mails={[mail]} open command={command}/>);
  fireEvent.click(screen.getByText('Review delivery'));
  expect(screen.getByRole('button', { name: 'Queue retry' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Delivery review reason'), { target: { value: 'Fictional relay rejection reviewed.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Queue retry' }));
  await waitFor(() => expect(command).toHaveBeenCalledExactlyOnceWith({ type: 'emailRetry', id: mail.id, reason: 'Fictional relay rejection reviewed.' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Retry queued for delivery.');
  expect(screen.getByText(/No acknowledgement recorded/)).toBeVisible(); expect(mail.status).toBe('failed');
});
it('retains the review when the private receipt refuses a retry', async () => {
  const command = vi.fn().mockResolvedValue({ ok: false, error: 'The saved copy changed.' });
  render(<CaseMailHistory mails={[failed()]} open command={command}/>);
  fireEvent.click(screen.getByText('Review delivery')); fireEvent.change(screen.getByLabelText('Delivery review reason'), { target: { value: 'Keep my review' } }); fireEvent.click(screen.getByRole('button', { name: 'Queue retry' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The saved copy changed.'); expect(screen.getByLabelText('Delivery review reason')).toHaveValue('Keep my review');
});
it('offers no retry for uncertain delivery and identifies a retained original after a new attempt', () => {
  const original = failed(); original.status = 'uncertain'; original.failure = 'uncertain';
  const view = render(<CaseMailHistory mails={[original]} open command={vi.fn()}/>);
  fireEvent.click(screen.getByText('Review delivery')); expect(screen.queryByRole('button', { name: 'Queue retry' })).not.toBeInTheDocument(); expect(screen.getByText(/An uncertain delivery cannot be retried here/)).toBeVisible();
  original.status = 'failed'; const retry = { ...failed(), id: 'new-attempt', status: 'pending' as const, retryOf: original.id, retryReason: 'Reviewed' };
  view.rerender(<CaseMailHistory mails={[original, retry]} open command={vi.fn()}/>);
  expect(screen.getByRole('link', { name: 'Retry of an earlier delivery' })).toHaveAttribute('href', '#delivery-' + original.id); expect(screen.queryByRole('button', { name: 'Queue retry' })).not.toBeInTheDocument();
});
