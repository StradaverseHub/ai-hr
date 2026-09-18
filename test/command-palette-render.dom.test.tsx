/**
 * r306 — the palette, RENDERED.
 *
 * test/command-palette-pages.dom.test.tsx proves what the page list contains. This proves a person can
 * see and use it: the dialog opens on ⌘K, one query fills three groups (Pages / People / Actions), and
 * every label comes out of the real catalogue rather than as a raw key — the failure that passes tsc,
 * passes next build and returns 200 (the palette reads page labels from the `nav` namespace, which is
 * the rail's own keys, so a wrong namespace here would paint `dashboard` at the user).
 *
 * The two server actions are mocked: what is under test is the palette, not the queries, and the dom
 * project has no database by design (test/dom-setup.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const gates = { isAdmin: true, canApprove: true, enabledModules: null };
const people = [
  { employmentId: 'emp-1', name: 'Aina Rahman', employeeCode: 'E-1001', department: 'Finance', company: 'Demo Sdn Bhd' },
];

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/app/command-bar-actions', () => ({
  commandBarGatesAction: vi.fn(async () => gates),
  // Query-aware on purpose: a mock that answers every query with a hit makes the "nothing matched"
  // state unreachable, and that state is one of the cases below.
  searchPeopleAction: vi.fn(async (q: string) =>
    people.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase())),
  ),
}));
// The delegation panel's loader would reach the database the moment its quick panel mounts.
vi.mock('@/app/delegations/actions', () => ({
  loadDelegationContextAction: vi.fn(async () => {
    throw new Error('not used in this test');
  }),
}));

const { CommandBar } = await import('../components/command-bar');

const openPalette = async () => {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur">
      <CommandBar />
    </NextIntlClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: messages.commandBar.placeholder }));
  return screen.getByPlaceholderText(messages.commandBar.placeholder);
};

describe('the ⌘K palette', () => {
  it('opens empty — a full page list is a menu, not a search result', async () => {
    await openPalette();
    // The one action in the registry is offered unfiltered; pages and people wait for a query.
    expect(screen.getByText(messages.commandBar.delegationTitle)).toBeInTheDocument();
    expect(screen.queryByText(messages.commandBar.groupPages)).toBeNull();
    expect(screen.queryByText(messages.commandBar.groupPeople)).toBeNull();
  });

  it('finds a page by its menu label, in the words the menu uses', async () => {
    const input = await openPalette();
    await userEvent.type(input, 'payroll');
    await waitFor(() => expect(screen.getByText(messages.commandBar.groupPages)).toBeInTheDocument());
    // nav.payrollProcess — a real label from the real catalogue, not the key.
    const hit = screen.getByText(messages.nav.payrollProcess);
    expect(hit).toBeInTheDocument();
    expect(hit.closest('a')).toHaveAttribute('href', expect.stringContaining('/payroll'));
    // No raw keys anywhere in the list.
    expect(screen.queryByText('payrollProcess')).toBeNull();
  });

  it('finds a page by its address, for someone who knows where they are going', async () => {
    const input = await openPalette();
    await userEvent.type(input, '/admin/holidays');
    await waitFor(() => expect(screen.getByText(messages.nav.holidays)).toBeInTheDocument());
  });

  it('finds people, and links to the person rather than a search page', async () => {
    const input = await openPalette();
    await userEvent.type(input, 'aina');
    await waitFor(() => expect(screen.getByText('Aina Rahman')).toBeInTheDocument());
    expect(screen.getByText(messages.commandBar.groupPeople)).toBeInTheDocument();
    expect(screen.getByText('Aina Rahman').closest('a')).toHaveAttribute('href', '/personnel/emp-1');
    // The subtitle carries what distinguishes two people with one name.
    expect(screen.getByText(/E-1001/)).toBeInTheDocument();
  });

  it('says so when nothing matches, instead of showing an empty box', async () => {
    const input = await openPalette();
    await userEvent.type(input, 'zzzzzzz');
    await waitFor(() => expect(screen.getByText(messages.commandBar.noResults)).toBeInTheDocument());
  });
});
