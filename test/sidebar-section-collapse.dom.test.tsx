import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const route = vi.hoisted(() => ({ pathname: '/', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
  redirect: vi.fn(),
}));
vi.mock('../lib/session', () => ({ getSession: vi.fn() }));
vi.mock('../core/entitlements', () => ({ isModuleEnabled: vi.fn() }));
import { Sidebar } from '../components/sidebar';

const themes = ['monolith', 'classic'] as const;
const ui = () => <NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>
  <Sidebar isAdmin canApprove canAccessTeam enabledModules={null} defaultCollapsed={false}/>
</NextIntlClientProvider>;
function section() { return screen.getByRole('button', { name: messages.nav.admin }); }
function contents() {
  const id = section().getAttribute('aria-controls');
  expect(id).toBeTruthy();
  const element = document.getElementById(id!);
  expect(element).not.toBeNull();
  return element!;
}
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-ui-theme');
  route.pathname = '/'; route.search = '';
});

describe.each(themes)('%s sidebar section collapse on the current route', theme => {
  it('keeps the manually expanded Admin control enabled after Organization navigation and supports keyboard collapse/reopen', async () => {
    document.documentElement.setAttribute('data-ui-theme', theme);
    const user = userEvent.setup(), view = render(ui());
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    await user.click(section());
    expect(section()).toBeEnabled();
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    if (theme === 'monolith') expect(section()).toHaveTextContent('−');
    expect(within(contents()).getByRole('link', { name: messages.nav.organization })).toHaveAttribute('href', '/admin/organization');

    // Same mounted sidebar after a real router pathname change, as in the reported journey.
    route.pathname = '/admin/organization'; view.rerender(ui());
    expect(section()).toBeEnabled();
    if (theme === 'monolith') expect(section()).toHaveTextContent('−');
    expect(within(contents()).getByRole('link', { name: messages.nav.organization })).toHaveAttribute('aria-current', 'page');
    section().focus();
    await user.keyboard(' ');
    expect(section()).toHaveFocus();
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    expect(within(contents()).queryByRole('link')).toBeNull();
    if (theme === 'monolith') expect(section()).toHaveTextContent('+');
    expect(route.pathname).toBe('/admin/organization');
    view.rerender(ui());
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    expect(within(contents()).getByRole('link', { name: messages.nav.organization })).toHaveAttribute('aria-current', 'page');
  });

  it('opens a newly visited route or query without overriding a same-route manual collapse', () => {
    document.documentElement.setAttribute('data-ui-theme', theme);
    route.pathname = '/reports'; route.search = 'cat=master';
    const view = render(ui());
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(section());
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    view.rerender(ui());
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    route.search = 'cat=payroll'; view.rerender(ui());
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(section());
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    route.pathname = '/admin/organization'; route.search = ''; view.rerender(ui());
    expect(section()).toHaveAttribute('aria-expanded', 'true');
    expect(within(contents()).getByRole('link', { name: messages.nav.organization })).toHaveAttribute('aria-current', 'page');
  });

  it('retains the existing nested module toggle and current child after closing and reopening the section', () => {
    document.documentElement.setAttribute('data-ui-theme', theme);
    route.pathname = '/admin/settings/movement'; render(ui());
    const module = () => screen.getByRole('button', { name: messages.nav.systemSettings });
    if (module().getAttribute('aria-expanded') !== 'true') fireEvent.click(module());
    const child = () => screen.getByRole('navigation', { name: messages.nav.systemSettings });
    expect(within(child()).getByRole('link', { name: messages.nav.movementSettings })).toHaveAttribute('aria-current', 'page');
    if (theme === 'classic') {
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(module()).toHaveFocus();
    } else fireEvent.click(module());
    expect(module()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(section());
    expect(section()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: messages.nav.systemSettings })).toBeNull();
    fireEvent.click(section());
    expect(module()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(module());
    expect(within(child()).getByRole('link', { name: messages.nav.movementSettings })).toHaveAttribute('aria-current', 'page');
    if (theme === 'monolith') expect(screen.queryByRole('button', { name: messages.nav.collapse })).toBeNull();
    else expect(screen.getByRole('button', { name: messages.nav.collapse })).toBeEnabled();
  });
});


describe('Classic prototype onboarding navigation',()=>{
  it.each([['/lifecycle/onboarding','onboardingV31','newJoiners'],['/lifecycle/requisitions/onboarding','onboardingRequisitions','allOnboardingRequisitions']] as const)('keeps %s current and permits keyboard collapse and reopen',async(path,parent,child)=>{
    document.documentElement.setAttribute('data-ui-theme','classic');route.pathname=path;
    const user=userEvent.setup();
    render(<NextIntlClientProvider locale="en" messages={messages}><Sidebar isAdmin onboardingAccess onboardingMaster onboardingRequisitionsAccess enabledModules={null} defaultCollapsed={false}/></NextIntlClientProvider>);
    const toggle=screen.getByRole('button',{name:messages.nav[parent]});
    expect(toggle).toHaveAttribute('aria-expanded','true');
    const navigation=()=>screen.getByRole('navigation',{name:messages.nav[parent]});
    expect(within(navigation()).getByRole('link',{name:messages.nav[child]})).toHaveAttribute('aria-current','page');
    toggle.focus();await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded','false');
    expect(screen.queryByRole('navigation',{name:messages.nav[parent]})).toBeNull();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded','true');
    expect(within(navigation()).getByRole('link',{name:messages.nav[child]})).toHaveAttribute('href',path);
  });
});
