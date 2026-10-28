/**
 * D-P1-32 PT-X5 (APR-025 D4) — the rail's performance presence is EXACTLY TWO entries, in every theme:
 * Performance & Talent (every viewer with the Performance module, to /performance/home) and Performance admin (OneHR
 * administrators only, to the admin area's first tab for the latest cycle, or /performance without a cycle). The
 * retired rows (My Performance, Performance, Calibration, Talent, Development) are gone for every viewer; Rewards
 * keeps its own rows. Each entry stays lit across the routes it owns.
 *
 * Non-vacuity: giving the admin descriptor back a managerUp flag turns the manager case red; dropping the
 * `performanceAdminHref` substitution turns the latest-cycle case red; dropping PERFORMANCE_AREA_OWNED_PATHS from
 * the area descriptor turns the lit tab-route cases red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
const nav = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.path, useSearchParams: () => new URLSearchParams(), redirect: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: vi.fn() }));
vi.mock('../core/entitlements', () => ({ isModuleEnabled: vi.fn() }));
import { Sidebar } from '../components/sidebar';

const CYCLE = '0f9b4c1e-2d3a-4b5c-8d7e-6f5a4b3c2d1e';
const LATEST = `/performance/${CYCLE}/cycle/calendar`;
afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-ui-theme'); nav.path = '/'; });

type Viewer = { isAdmin?: boolean; canApprove?: boolean; canAdministerOnehr?: boolean; performanceAdminHref?: string; enabledModules?: string[] };
function rail(theme: string, viewer: Viewer = {}) {
  document.documentElement.setAttribute('data-ui-theme', theme);
  render(<NextIntlClientProvider locale="en" messages={messages} onError={error => { throw error; }}>
    <Sidebar isAdmin={viewer.isAdmin ?? false} canApprove={viewer.canApprove ?? false} canAccessTeam={viewer.canApprove ?? false}
      canAdministerOnehr={viewer.canAdministerOnehr} performanceAdminHref={viewer.performanceAdminHref}
      enabledModules={viewer.enabledModules ?? ['performance', 'rewards']} defaultCollapsed={false} />
  </NextIntlClientProvider>);
  // The performance entries live in the Strata workspace.
  const strata = screen.queryByRole('button', { name: messages.nav.workspaceStrata });
  if (strata) fireEvent.click(strata);
}
/** Every rail link into the Performance & Talent area or its administration (Rewards and Reports are elsewhere). */
const performanceHrefs = () => [...document.querySelectorAll('a[href^="/performance"], a[href^="/me/performance"]')].map(link => link.getAttribute('href'));
const hrefOf = (name: string) => screen.getByRole('link', { name }).getAttribute('href');

describe.each(['classic', 'monolith', 'atelier'])('%s rail: the two performance entries', theme => {
  it.each([{ who: 'an employee', viewer: {} }, { who: 'a manager', viewer: { canApprove: true } }])('$who gets Performance & Talent only', ({ viewer }) => {
    rail(theme, viewer);
    expect(performanceHrefs()).toEqual(['/performance/home']);
    expect(hrefOf(messages.nav.performanceTalent)).toBe('/performance/home');
    for (const retired of [messages.nav.myPerformance, messages.nav.talent, messages.nav.development, messages.nav.calibration, messages.nav.performanceAdmin]) {
      expect(screen.queryByText(retired), retired).toBeNull();
    }
  });
  it('a OneHR administrator also gets Performance admin, opening the latest cycle\'s admin area', () => {
    rail(theme, { canAdministerOnehr: true, performanceAdminHref: LATEST });
    expect(performanceHrefs()).toEqual(['/performance/home', LATEST]);
    expect(hrefOf(messages.nav.performanceTalent)).toBe('/performance/home');
    expect(hrefOf(messages.nav.performanceAdmin)).toBe(LATEST);
  });
  it('with no cycle to administer, Performance admin opens the cycle list', () => {
    rail(theme, { canAdministerOnehr: true });
    expect(performanceHrefs()).toEqual(['/performance/home', '/performance']);
    expect(hrefOf(messages.nav.performanceAdmin)).toBe('/performance');
  });
  it('an HR administrator or manager without OneHR administration gets no admin entry', () => {
    rail(theme, { isAdmin: true, canApprove: true });
    expect(performanceHrefs()).toEqual(['/performance/home']);
  });
  it('neither entry without the Performance module', () => {
    rail(theme, { canAdministerOnehr: true, performanceAdminHref: LATEST, enabledModules: ['rewards'] });
    expect(performanceHrefs()).toEqual([]);
  });
  it.each([
    ['/performance/home', '/performance/home'],
    ['/performance/team/kpis', '/performance/home'],
    ['/performance/calibration/talent-box', '/performance/home'],
    [`/performance/${CYCLE}/performance/run`, LATEST],
    [`/performance/${CYCLE}`, LATEST],
  ])('at %s the lit entry is %s', (path, lit) => {
    nav.path = path;
    rail(theme, { canAdministerOnehr: true, performanceAdminHref: LATEST });
    expect([...document.querySelectorAll('a[aria-current="page"]')].map(link => link.getAttribute('href'))).toEqual([lit]);
  });
});
