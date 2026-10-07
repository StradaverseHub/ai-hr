/**
 * r398 — THE MONOLITH SHELL (docs/design/monolith/README.md §3), rendered for real in jsdom.
 *
 * What is pinned, and why it is pinned here rather than by eye:
 *  • Monolith's rail is a different STRUCTURE, not a restyle: mono rows with no icons, aria-current on the
 *    current row, a module's children INLINE behind a hairline (no flyout panel), no collapse control, the
 *    brand line and the user line. CSS cannot produce any of that, so the component branches — and a branch
 *    can silently drop an accessibility attribute the Classic branch carries. The assertions are on roles,
 *    names and aria state, the things a screen reader gets.
 *  • The intent bar is a LABELLED input that opens the EXISTING command bar dialog with what was typed —
 *    not a second palette. Proven by rendering the real <CommandBar /> beside it and watching its dialog open
 *    with the query in its own input.
 *  • Classic renders today's markup: the specific elements Monolith replaces (icons, the collapse control,
 *    the flyout panel, the bell glyph) are asserted PRESENT there, and the Monolith-only pieces ABSENT.
 *  • The branch follows <html data-ui-theme> live (the switcher sets it before the server round trip).
 *
 * The theme is set the way the app sets it — the attribute on <html> — never by a prop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../messages/en.json';

let pathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  redirect: vi.fn(),
}));
// Server actions and the delegation panel: server-only imports that cannot load in jsdom; nothing here
// submits them.
vi.mock('../app/delegations/actions', () => ({ loadDelegationContextAction: vi.fn() }));
vi.mock('../components/delegation-manager', () => ({ DelegationManager: () => null }));
vi.mock('../app/notification-actions', () => ({
  markAllNotificationsReadAction: vi.fn(),
  markNotificationReadAction: vi.fn(),
}));
vi.mock('../app/scope-actions', () => ({ setCompanyScope: vi.fn() }));

import { Sidebar } from '../components/sidebar';
import { IntentBar } from '../components/intent-bar';
import { CommandBar } from '../components/command-bar';
import { NotificationCenter } from '../components/notification-center';
import { ShellRoutePath, ShellStatusLine } from '../components/shell-top-line';

const setTheme = (theme: 'monolith' | 'classic' | null) => {
  if (theme === null) document.documentElement.removeAttribute('data-ui-theme');
  else document.documentElement.setAttribute('data-ui-theme', theme);
};

const wrap = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      onError={(e) => {
        throw e;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );

const adminRail = () =>
  wrap(
    <Sidebar
      isAdmin
      canApprove
      canAccessTeam
      approvalCount={3}
      enabledModules={null}
      defaultCollapsed={false}
      viewerName="Aisyah Rahman"
      viewerCode="EMP-0001"
    />,
  );

const aside = () => {
  const el = document.querySelector('aside');
  expect(el, 'the rail rendered').not.toBeNull();
  return el!;
};

afterEach(() => {
  cleanup();
  setTheme(null);
  pathname = '/';
});

describe('Monolith rail', () => {
  it('rows are mono, carry no icons, and the current row is aria-current', () => {
    setTheme('monolith');
    adminRail();
    const rail = aside();
    expect(rail.querySelectorAll('svg'), 'no icons anywhere in the Monolith rail').toHaveLength(0);
    const dashboard = within(rail).getByRole('link', { name: messages.nav.dashboard });
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    expect(dashboard.className).toContain('font-mono');
    expect(dashboard.className).toContain('border-ink');
    const profile = within(rail).getByRole('link', { name: messages.nav.myWorkspace });
    expect(profile).not.toHaveAttribute('aria-current');
    // The board's brand line and the user line, and NO collapse control (the rail is always open).
    expect(rail.textContent).toContain('SYSTEM 01');
    expect(within(rail).getByRole('link', { name: messages.nav.home })).toHaveAttribute('href', '/');
    expect(rail.querySelector('[data-rail-user]')?.textContent).toContain('Aisyah Rahman');
    expect(within(rail).queryByRole('button', { name: messages.nav.collapse })).toBeNull();
  });

  it('the active module lists its children INLINE, the current child aria-current in signal-text', () => {
    setTheme('monolith');
    pathname = '/admin/leave-config/types';
    adminRail();
    const rail = aside();
    const kids = within(rail).getByRole('navigation', { name: messages.nav.leaveConfig });
    // Inline: inside the rail itself, not a panel beside it.
    expect(rail.contains(kids)).toBe(true);
    expect(document.querySelector('[id^="nav-flyout-"]'), 'no flyout panel in Monolith').toBeNull();
    const current = within(kids).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current, 'exactly one child is the current page').toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/admin/leave-config/types');
    expect(current[0].className).toContain('text-signal-text');
  });

  it('a closed module opens inline from its own button (aria-expanded follows)', () => {
    setTheme('monolith');
    pathname = '/admin/leave-config/types';
    adminRail();
    const rail = aside();
    const payroll = within(rail).getByRole('button', { name: messages.nav.payroll });
    expect(payroll).toHaveAttribute('aria-expanded', 'false');
    expect(within(rail).queryByRole('navigation', { name: messages.nav.payroll })).toBeNull();
    fireEvent.click(payroll);
    expect(payroll).toHaveAttribute('aria-expanded', 'true');
    const kids = within(rail).getByRole('navigation', { name: messages.nav.payroll });
    expect(payroll.getAttribute('aria-controls')).toBe(kids.id);
    expect(within(kids).getAllByRole('link').length).toBeGreaterThan(0);
  });

  it('the approval count keeps its accessible name', () => {
    setTheme('monolith');
    adminRail();
    fireEvent.click(within(aside()).getByRole('button', { name: messages.nav.manage }));
    expect(
      within(aside()).getByRole('link', { name: `${messages.nav.approvals}, 3 items awaiting your decision` }),
    ).toHaveAttribute('href', '/approvals');
  });
});

describe('Classic rail renders today’s markup', () => {
  it('icons, the collapse control, the rounded floating panel, the flyout — and none of Monolith’s pieces', () => {
    // No attribute and an explicit `classic` must both be Classic: the stylesheet paints Classic in both.
    for (const theme of [null, 'classic'] as const) {
      setTheme(theme);
      pathname = '/admin/leave-config/types';
      adminRail();
      const rail = aside();
      expect(rail.querySelectorAll('svg').length).toBeGreaterThan(5);
      expect(rail.className).toContain('rounded-[1.25rem]');
      expect(within(rail).getByRole('button', { name: messages.nav.collapse })).toBeInTheDocument();
      expect(rail.textContent).not.toContain('SYSTEM 01');
      expect(rail.querySelector('[data-rail-user]')).toBeNull();
      fireEvent.click(within(rail).getByRole('button', { name: messages.nav.payroll }));
      expect(document.getElementById('nav-flyout-payroll'), 'the flyout panel beside the rail').not.toBeNull();
      cleanup();
    }
  });

  it('follows <html data-ui-theme> live: Classic → Monolith without a remount', async () => {
    setTheme('classic');
    adminRail();
    expect(within(aside()).getByRole('button', { name: messages.nav.collapse })).toBeInTheDocument();
    await act(async () => setTheme('monolith'));
    await waitFor(() => expect(aside().querySelectorAll('svg')).toHaveLength(0));
    expect(within(aside()).queryByRole('button', { name: messages.nav.collapse })).toBeNull();
  });
});

describe('the intent bar is the command bar made visible', () => {
  it('is a labelled input whose Enter opens the EXISTING command bar with the typed query', async () => {
    setTheme('monolith');
    wrap(
      <>
        <CommandBar />
        <IntentBar />
      </>,
    );
    const input = screen.getByRole('textbox', { name: messages.commandBar.open });
    expect(input).toHaveAttribute('placeholder', messages.commandBar.placeholder);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(input, { target: { value: 'deleg' } });
    fireEvent.submit(input.closest('form')!);
    const dialog = await screen.findByRole('dialog');
    // The command bar's OWN search input carries the query, and its registry answered it.
    const inner = within(dialog).getByRole('textbox');
    expect(inner).not.toBe(input);
    expect(inner).toHaveValue('deleg');
    expect(within(dialog).getByText(messages.commandBar.delegationTitle)).toBeInTheDocument();
    // One palette: the intent bar contributed no dialog of its own.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(input).toHaveValue('');
  });

  it('the ↵ button is a labelled submit of the same form', () => {
    setTheme('monolith');
    wrap(<IntentBar />);
    const submit = screen.getByRole('button', { name: messages.commandBar.open });
    expect(submit).toHaveAttribute('type', 'submit');
    expect(submit.closest('form')).toBe(screen.getByRole('textbox').closest('form'));
  });

  it('renders nothing in Classic (Classic keeps the header search trigger)', () => {
    setTheme('classic');
    const { container } = wrap(<IntentBar />);
    expect(container.innerHTML).toBe('');
  });
});

describe('the top line and the status line', () => {
  it('Monolith shows the route path and the scope; Classic shows neither', () => {
    pathname = '/leave';
    const companies = [
      { id: 'a', name: 'Nusantara Sdn Bhd' },
      { id: 'b', name: 'Borneo Sdn Bhd' },
    ];
    setTheme('monolith');
    wrap(
      <>
        <ShellRoutePath />
        <ShellStatusLine companies={companies} selected={['a']} />
      </>,
    );
    expect(document.querySelector('[data-shell-path]')?.textContent).toBe('/leave');
    expect(document.querySelector('[data-shell-status]')?.textContent).toBe(
      `${messages.topbar.scope} · Nusantara Sdn Bhd`,
    );
    cleanup();
    setTheme('classic');
    const { container } = wrap(
      <>
        <ShellRoutePath />
        <ShellStatusLine companies={companies} selected={['a']} />
      </>,
    );
    expect(container.innerHTML).toBe('');
  });

  const bell = () =>
    wrap(
      <NotificationCenter
        unread={1}
        items={[]}
        tasks={[]}
        taskNotifications={[]}
        taskCount={3}
        readItems={[]}
        history={[]}
        canApprove={false}
      />,
    );

  it('Monolith: the notification count is mono text with the number in signal-text, same accessible name', () => {
    setTheme('monolith');
    bell();
    const button = screen.getByRole('button', { name: /4/ });
    expect(button.querySelector('svg'), 'no bell glyph').toBeNull();
    const number = [...button.querySelectorAll('span')].find((s) => s.textContent === '4');
    expect(number?.className).toContain('text-signal-text');
    expect(button.textContent).toContain('notifications');
  });

  it('Classic: the bell glyph and its badge, as before', () => {
    setTheme('classic');
    bell();
    const button = screen.getByRole('button', { name: /4/ });
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.textContent).toBe('4');
  });
});
