/** AI centre: the one proposal card never completes anything. Its only action is a link to the page where
 * the person decides, so a review page can be redesigned but never bypassed from the Inbox. */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
vi.mock('next/link', () => ({ default: ({ children, ...props }: Record<string, unknown> & { children: React.ReactNode }) => <a {...props}>{children}</a> }));
import { ProposalCard } from '../components/ai-centre/proposal-card';

describe('ProposalCard', () => {
  it('has exactly one action, a link to the deciding page, and no form or button', () => {
    const view = render(<ProposalCard tone="decide" icon={<svg />} title="Approve leave request · Fictional Person" meta={['From your approvals', '1 Nov 2026']}
      href="/approvals?kind=leave&id=11111111-1111-4111-8111-111111111111" cta="Review" awaitingLabel="Waiting for your confirmation"
      checks={[{ label: 'Balance covers it', tone: 'ok', ruleVersion: 'AL-2026.3' }]}
      prepared={{ summary: 'How this was prepared', rows: [['Authority', 'You are the assigned approver']] }} />);
    const card = view.container.querySelector('[data-proposal-card]')!;
    const links = within(card as HTMLElement).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/approvals?kind=leave&id=11111111-1111-4111-8111-111111111111');
    expect(card.querySelector('form, button, input')).toBeNull();
    expect(screen.getByRole('img', { name: 'Waiting for your confirmation' })).toBeInTheDocument();
    expect(screen.getByText('Balance covers it')).toHaveAttribute('title', 'AL-2026.3');
  });
});
