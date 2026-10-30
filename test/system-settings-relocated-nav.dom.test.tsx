import React from 'react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';

const location = vi.hoisted(() => ({pathname: '/admin/privacy'}));
vi.mock('next/navigation', () => ({
  usePathname: () => location.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));
vi.mock('../lib/session', () => ({getSession: vi.fn()}));
vi.mock('../core/entitlements', () => ({isModuleEnabled: vi.fn()}));
import {Sidebar} from '../components/sidebar';

const catalogues = {en, ms, ta, th, vi: viMessages, zh};
const relocated = [
  ['/admin/settings/notifications', 'workflowEmail'],
  ['/admin/scheduled-actions', 'scheduledActions'],
  ['/admin/privacy', 'dataPrivacy'],
] as const;

function mount({admin = true, operator = false, manager = false, collapsed = false,
  modules = ['notifications'], locale = 'en' as keyof typeof catalogues} = {}) {
  const view = render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>
    <Sidebar isAdmin={admin} canApprove={manager} canConfigureIdentityEmail={operator}
      canPreviewIdentityEmail={admin} canAdministerAi={admin} enabledModules={modules} defaultCollapsed={collapsed}/>
  </NextIntlClientProvider>);
  return view;
}
// A section heading and its submenu can share a label; operate the actual controlled submenu.
function settingsTrigger(label = en.nav.systemConfiguration) {
  const triggers = screen.getAllByRole('button', {name: label}).filter(button =>
    button.hasAttribute('aria-controls') && button.getAttribute('aria-controls') !== 'nav-section-systemConfiguration');
  expect(triggers).toHaveLength(1);
  return triggers[0];
}
function openSettings(label = en.nav.systemConfiguration) {
  const section = document.querySelector<HTMLButtonElement>('button[aria-controls="nav-section-systemConfiguration"]');
  if (section?.getAttribute('aria-expanded') === 'false') fireEvent.click(section);
  const trigger = settingsTrigger(label);
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const panel = document.getElementById(trigger.getAttribute('aria-controls')!);
  expect(panel).not.toBeNull();
  expect(panel).toHaveAttribute('aria-label', label);
  return panel!;
}

beforeEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-ui-theme');
  location.pathname = '/admin/privacy';
});

describe('existing admin destinations relocated into System Configuration', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the existing labels and routes under one parent in %s', locale => {
    mount({locale});
    const nav = catalogues[locale].nav;
    // No relocated destination remains a flat Administration link before opening the node.
    for (const [, key] of relocated) expect(screen.queryByRole('link', {name: nav[key]})).toBeNull();
    const panel = openSettings(nav.systemConfiguration);
    for (const [href, key] of relocated) {
      expect(within(panel).getByRole('link', {name: nav[key]})).toHaveAttribute('href', href);
      expect(screen.getAllByRole('link', {name: nav[key]})).toHaveLength(1);
    }
    expect(within(panel).queryByRole('link', {name: nav.aiConfig})).toBeNull();
    expect(document.querySelector('a[href="/admin/ai"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: nav.aiControlTower}));
    const tower = screen.getByRole('navigation', {name: nav.aiControlTower});
    expect(within(tower).getAllByRole('link').filter(link => link.getAttribute('href') === '/control-tower/agents')).toHaveLength(1);
  });

  it.each(relocated)('preserves active matching and reopen after a bookmarked %s load', (href, key) => {
    location.pathname = href;
    const view = mount();
    let panel = openSettings();
    expect(within(panel).getByRole('link', {name: en.nav[key]})).toHaveAttribute('aria-current', 'page');
    expect(within(panel).getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page')).toHaveLength(1);
    view.unmount();
    mount();
    panel = openSettings();
    expect(within(panel).getByRole('link', {name: en.nav[key]})).toHaveAttribute('aria-current', 'page');
  });

  it('keeps workflow email entitlement-gated without hiding the other relocated rows', () => {
    mount({modules: []});
    const panel = openSettings();
    expect(within(panel).queryByRole('link', {name: en.nav.workflowEmail})).toBeNull();
    expect(within(panel).getByRole('link', {name: en.nav.scheduledActions})).toHaveAttribute('href', '/admin/scheduled-actions');
    expect(within(panel).getByRole('link', {name: en.nav.dataPrivacy})).toHaveAttribute('href', '/admin/privacy');
  });

  it('does not expand installation operator visibility even with notifications enabled', () => {
    mount({admin: false, operator: true});
    const panel = openSettings();
    expect(within(panel).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/admin/settings/email']);
    for (const [, key] of relocated) expect(screen.queryByRole('link', {name: en.nav[key]})).toBeNull();
    expect(screen.queryByRole('link', {name: en.nav.aiConfig})).toBeNull();
  });

  it.each([false, true])('offers none of the relocated destinations to an employee/manager (manager=%s)', manager => {
    mount({admin: false, manager});
    expect(screen.queryByRole('button', {name: en.nav.systemConfiguration})).toBeNull();
    for (const [, key] of relocated) expect(screen.queryByRole('link', {name: en.nav[key]})).toBeNull();
  });

  it('keeps collapsed rail access, keyboard dismissal and focus return', () => {
    mount({collapsed: true});
    const trigger = settingsTrigger();
    const panel = openSettings();
    expect(within(panel).getByRole('link', {name: en.nav.dataPrivacy})).toHaveAttribute('aria-current', 'page');
    expect(within(panel).getAllByRole('link')[0]).toHaveFocus();
    fireEvent.keyDown(document, {key: 'Escape'});
    expect(screen.queryByRole('navigation', {name: en.nav.systemConfiguration})).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it.each(['monolith', 'classic', 'atelier'])('uses the same relocated destinations in the %s shell', theme => {
    document.documentElement.setAttribute('data-ui-theme', theme);
    mount();
    const panel = openSettings();
    for (const [href, key] of relocated) expect(screen.getByRole('link', {name: en.nav[key]})).toHaveAttribute('href', href);
    expect(screen.getByRole('link', {name: en.nav.dataPrivacy})).toHaveAttribute('aria-current', 'page');
    expect(within(panel).queryByRole('link', {name: en.nav.aiConfig})).toBeNull();
    expect(document.querySelector('a[href="/admin/ai"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: en.nav.aiControlTower}));
    const tower = screen.getByRole('navigation', {name: en.nav.aiControlTower});
    expect(within(tower).getAllByRole('link').filter(link => link.getAttribute('href') === '/control-tower/agents')).toHaveLength(1);
  });
});
