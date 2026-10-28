/**
 * D-P1-28 (D-P1-32 PT-X5) — below 640px Classic and Monolith hid the navigation rail with no way to open it. A menu
 * button now opens the same rail as a drawer over the page: aria-expanded and aria-controls name the state and the
 * rail, Escape and the backdrop close it, and focus returns to the button. Atelier keeps its own phone toggle.
 * jsdom applies no CSS, so the breakpoint is pinned by the classes (`sm:hidden` on the button, `max-sm:` drawer
 * classes on the rail's wrapper only while open); the rendered behaviour at 390px is PT-X6's render pass.
 *
 * Non-vacuity: removing the button turns every case red; dropping closeMobileNavigation's focus call turns the
 * focus-return assertions red; dropping the collapse override turns the expanded-drawer case red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams(), redirect: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: vi.fn() }));
vi.mock('../core/entitlements', () => ({ isModuleEnabled: vi.fn() }));
import { Sidebar } from '../components/sidebar';

afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-ui-theme'); });
function mount(theme: string, defaultCollapsed = false) {
  document.documentElement.setAttribute('data-ui-theme', theme);
  render(<NextIntlClientProvider locale="en" messages={messages}>
    <Sidebar isAdmin={false} canApprove={false} enabledModules={null} defaultCollapsed={defaultCollapsed} />
  </NextIntlClientProvider>);
}
const toggle = () => document.querySelector<HTMLButtonElement>('[data-mobile-navigation-toggle]')!;
const rail = () => document.getElementById('app-mobile-navigation')!;
const wrapper = () => rail().parentElement!;
const backdrop = () => document.querySelector<HTMLElement>('[data-mobile-navigation-backdrop]');

describe.each(['classic', 'monolith'])('%s: the phone menu button', theme => {
  it('is a labelled button shown only below 640px that controls the rail', () => {
    mount(theme);
    const button = toggle();
    expect(button).toBeTruthy();
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toContain(messages.nav.workspaceSwitch);
    expect(button.className.split(' ')).toContain('sm:hidden');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('app-mobile-navigation');
    expect(rail().hasAttribute('data-app-sidebar')).toBe(true);
    // Closed: the rail keeps its desktop-only wrapper, and no backdrop.
    expect(wrapper().className).toContain('hidden');
    expect(wrapper().className).not.toContain('max-sm:fixed');
    expect(backdrop()).toBeNull();
  });
  it('opens the rail as a drawer over the page; Escape closes it and returns focus to the button', () => {
    mount(theme);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(wrapper().className).toContain('max-sm:fixed');
    expect(wrapper().className).toContain('max-sm:block');
    expect(backdrop()).toBeTruthy();
    const link = rail().querySelector('a')!;
    link.focus();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(wrapper().className).not.toContain('max-sm:fixed');
    expect(document.activeElement).toBe(toggle());
  });
  it('the backdrop closes it and returns focus too, and the button toggles it closed', () => {
    mount(theme);
    fireEvent.click(toggle());
    fireEvent.click(backdrop()!);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(backdrop()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the phone drawer', () => {
  it('shows Classic\'s rail with its labels even when the desktop rail is collapsed', () => {
    mount('classic', true);
    expect(rail().className).toContain('w-[66px]');
    fireEvent.click(toggle());
    expect(rail().className).toContain('w-[232px]');
    fireEvent.keyDown(rail(), { key: 'Escape' });
    expect(rail().className).toContain('w-[66px]');
  });
  it('is not added to Atelier, which keeps its own phone toggle', () => {
    mount('atelier');
    expect(document.querySelector('[data-mobile-navigation-toggle]')).toBeNull();
    expect(screen.getByRole('button', { name: messages.nav.workspaceSwitch }).className).toContain('atelier-mobile-toggle');
  });
});
