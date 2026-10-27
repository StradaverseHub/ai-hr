/**
 * The rail offers Talent and Development only to a viewer holding that work, and shows Development as a
 * disabled, non-link row while the viewer's own plan is locked (the workspace tab's lock, mirrored).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams(), redirect: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: vi.fn() }));
vi.mock('../core/entitlements', () => ({ isModuleEnabled: vi.fn() }));
import { Sidebar } from '../components/sidebar';

type Offer = { tm: boolean; idp: 'none' | 'open' | 'locked' };
afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-ui-theme'); });

function rail(theme: string, performanceNavigation: Offer | undefined, canApprove = false) {
  document.documentElement.setAttribute('data-ui-theme', theme);
  render(<NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>
    <Sidebar isAdmin={false} canApprove={canApprove} canAccessTeam={canApprove} enabledModules={['performance']} performanceNavigation={performanceNavigation} defaultCollapsed={false} />
  </NextIntlClientProvider>);
  const strat = screen.queryByRole('button', { name: messages.nav.workspaceStrata });
  if (strat) fireEvent.click(strat);
  const perf = screen.queryByRole('button', { name: messages.nav.performance });
  if (perf) fireEvent.click(perf);
}
const link = (name: string) => screen.queryByRole('link', { name });

describe.each(['classic', 'monolith', 'atelier'])('%s rail: review journey modules', theme => {
  it.each([{ canApprove: false }, { canApprove: true }])('hides Talent and Development without that work (manager: $canApprove)', ({ canApprove }) => {
    rail(theme, { tm: false, idp: 'none' }, canApprove);
    expect(screen.queryByText(messages.nav.talent)).toBeNull();
    expect(screen.queryByText(messages.nav.development)).toBeNull();
    expect(document.querySelector('a[href*="module="]')).toBeNull();
    // Performance no longer forces the PM module: the workspace resolves where the viewer lands.
    expect(document.querySelector('a[href="/performance/workspace"]')).not.toBeNull();
  });
  it('hides both rows when the layout supplies no offer', () => {
    rail(theme, undefined);
    expect(screen.queryByText(messages.nav.talent)).toBeNull();
    expect(screen.queryByText(messages.nav.development)).toBeNull();
  });
  it('links Talent and Development to the viewer who holds that work, employee or not', () => {
    rail(theme, { tm: true, idp: 'open' });
    expect(link(messages.nav.talent)).toHaveAttribute('href', '/performance/workspace?module=tm');
    expect(link(messages.nav.development)).toHaveAttribute('href', '/performance/workspace?module=idp');
    expect(document.querySelector('[aria-disabled="true"]')).toBeNull();
  });
  it('shows a locked own plan as a disabled row with no link', () => {
    rail(theme, { tm: true, idp: 'locked' });
    expect(link(messages.nav.development)).toBeNull();
    expect(document.querySelector('a[href="/performance/workspace?module=idp"]')).toBeNull();
    const row = screen.getByText(messages.nav.development).closest('[aria-disabled="true"]');
    expect(row).not.toBeNull();
    expect(row!.tagName).not.toBe('A');
    expect(row!.getAttribute('title')).toBe(messages.onehr.workspace.planLocked);
    expect(row!.querySelector('svg')).not.toBeNull();
    expect(link(messages.nav.talent)).toHaveAttribute('href', '/performance/workspace?module=tm');
  });
});
