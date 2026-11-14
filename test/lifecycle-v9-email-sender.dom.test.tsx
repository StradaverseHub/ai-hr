/** Board 5a8c382c: the template editor shows the tenant's one sender name read-only; there is nothing to pick. */
import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmailDefinition } from '../app/lifecycle/v9/email-definition';
import type { EmailTemplate } from '../lib/lifecycle-v9-model';
const email: EmailTemplate = { id: 'email', name: 'Fictional email', module: 'onb', active: true, sender: 'hr', subject: 'Welcome', body: 'Dear colleague,', cc: [], links: [], attachments: [], slots: [] };
const view = (sender?: { name: string | null; configured: boolean }) => render(<EmailDefinition email={email} templates={[]} disabled={false} sender={sender} change={() => { throw Error('The sender cannot be changed here'); }}/>);
it('shows the resolved tenant sender name with no sender choice', () => {
  view({ name: 'Fictional Group HR', configured: true });
  const sender = document.querySelector('[data-email-sender]')!;
  expect(sender.querySelector('output')?.textContent).toBe('Fictional Group HR');
  expect(screen.getByText('Sender')).toBeInTheDocument();
  expect(sender.querySelector('select,input')).toBeNull();
  expect(screen.queryAllByRole('combobox').map(select => select.getAttribute('aria-label') ?? select.closest('label')?.textContent ?? '')).not.toContain('Sender');
  for (const retired of ['HR Onboarding', 'Human Resource Department', 'Kingdee AI HR']) expect(screen.queryByText(retired)).not.toBeInTheDocument();
});
it('says when email delivery is not set up, and stays neutral for a viewer without the projection', () => {
  const { unmount } = view({ name: null, configured: false });
  expect(document.querySelector('[data-email-sender] output')?.textContent).toBe('Email delivery is not set up');
  unmount(); view();
  expect(document.querySelector('[data-email-sender] output')?.textContent).toBe('Set by your email administrator');
});
