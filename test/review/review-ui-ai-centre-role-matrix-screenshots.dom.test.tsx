/** REVIEW (independent UI review) — PROPOSED evidence test, drafted as
 * test/review/ai-centre-role-matrix-screenshots.dom.test.tsx.
 *
 * Gap it closes: the CI evidence for run 41338446035 (candidate d8aa371bd) covers en for every screen, zh for
 * the Inbox and all six locales for How it works only; always light, always atelier, widths 1440 and 390;
 * roles employee / approver / company admin / group admin only, and never the payroll partner or a manager.
 * No dark-mode or 375px capture exists for any AI centre screen.
 *
 * This renders, for each role (employee, manager, HR admin, group admin, payroll partner) and each locale
 * (en, ms, zh, vi, ta, th): the tab bar plus Inbox, Delegated jobs and How it works, in dark mode, using the
 * EXISTING helper test/helpers/ai-review-screenshots.ts unchanged.
 *
 * Dark mode with the unchanged helper: the default ("classic") palette's dark tokens are declared on `.dark`
 * (app/globals.css:52), so wrapping the markup in <div class="dark bg-background text-foreground"> gives the
 * real dark tokens. Atelier's dark tokens are declared on `:root[data-ui-theme='atelier'].dark` (app/atelier.css:59)
 * and cannot be reached from a wrapper, and the helper's phone width is fixed at 390. Minimal helper patch to
 * also cover atelier-dark at 375 (proposed, not applied):
 *   - add `options:{dark?:boolean;viewports?:readonly (readonly [string,number,number])[]}={}` as the last
 *     parameter; use `options.viewports ?? [['desktop',1440,1000],['mobile',390,844]]` in the loop;
 *   - write `<html lang=… data-ui-theme=… class="${options.dark?'dark':''}">`;
 *   - add `dark` to each JSON row and to the file name (`${locale}-${section}${options.dark?'-dark':''}-${device}.png`).
 * The assertions below run everywhere; screenshots are written only on the selected Actions runner. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { aiReviewDomHtml, captureAiReviewScreenshots } from '../helpers/ai-review-screenshots';
import { withAiCentre } from '../helpers/ai-centre-messages';
import en from '../../messages/en.json'; import ms from '../../messages/ms.json'; import zh from '../../messages/zh.json';
import th from '../../messages/th.json'; import ta from '../../messages/ta.json'; import viCopy from '../../messages/vi.json';

const copies = { en, ms, zh, vi: viCopy, ta, th };
type Locale = keyof typeof copies;
type Role = 'employee' | 'manager' | 'hr_admin' | 'group_admin' | 'payroll_partner';
const ROLES: readonly Role[] = ['employee', 'manager', 'hr_admin', 'group_admin', 'payroll_partner'];
const admin = (role: Role) => role === 'hr_admin' || role === 'group_admin';
const state = vi.hoisted(() => ({ locale: 'en' as string, role: 'employee' as string }));
const messagesFor = (locale: string) => withAiCentre(locale, copies[locale as Locale] as Record<string, unknown>) as Record<string, any>;

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: messagesFor(state.locale) as never, namespace }),
  getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams() }));
vi.mock('../../lib/authz', () => ({ isAdmin: () => state.role === 'hr_admin' || state.role === 'group_admin', isGroupAdmin: () => state.role === 'group_admin' }));
vi.mock('../../core/entitlements', () => ({ isModuleEnabledOrFalse: () => true, isModuleEnabled: () => true }));
vi.mock('../../core/read', () => ({ allowedCompanies: async () => [{ id: 'fictional-company' }] }));
vi.mock('../../lib/scope', () => ({ getScopeIds: async (ids: string[]) => ids }));
// Fictional queue per role: a manager and an HR admin have a leave decision; nobody else has one.
vi.mock('../../core/approvals-inbox', () => ({ listPendingTasks: async () => (state.role === 'manager' || state.role === 'hr_admin' || state.role === 'group_admin'
  ? [{ id: '00000000-0000-4000-8000-0000000000a1', kind: 'leave', subjectName: 'Fictional Person A', createdAt: '2026-11-01T02:00:00.000Z', linkPath: '/approvals?task=leave&requestId=00000000-0000-4000-8000-0000000000a1' }] : []) }));
vi.mock('../../core/payroll-anomaly', () => ({ openExceptionsAcrossRuns: async () => ({ total: 2, cappedOut: false, rows: [{ disposition: 'block' }, { disposition: 'review' }] }) }));
vi.mock('../../core/agent-actions', () => ({ proposeActions: async () => [{ type: 'fictional', subjects: [], count: 1, overCap: false }] }));
vi.mock('../../core/record-readiness', () => ({ recordReadiness: async () => ({ employees: 10, ready: 8, gaps: [] }) }));
vi.mock('../../core/digest/daily-digest', () => ({
  digestPreview: async () => ({ kind: 'teras.daily_digest', version: 1, asOf: '2026-11-02', approvals: { total: 0, byKind: [], page: '/approvals' },
    setup: state.role === 'hr_admin' || state.role === 'group_admin' ? { blocked: 1, attention: 1, companies: 1, unknown: 0, page: '/control-tower/readiness' } : null,
    deadlines: state.role === 'hr_admin' || state.role === 'group_admin' ? { overdue: 1, dueSoon: 2, page: '/payroll/statutory-forms' } : null, text: 'fixture' }),
  latestDailyDigest: async () => null,
}));
vi.mock('../../app/assistant/centre/recommendation', () => ({ readLeaveRecommendation: vi.fn() }));
// The recommender's gate is open in this matrix, so each approver's card offers the recommendation as in production.
vi.mock('../../core/agent-registry/controls', async original => ({ ...(await original<typeof import('../../core/agent-registry/controls')>()), workerRunGate: async () => ({ run: true, reasons: [] }) }));

import { AiCentreTabs } from '../../components/ai-centre/centre-tabs';
import { AiCentreInbox } from '../../app/assistant/centre/inbox';
import { AiCentreDelegatedJobs } from '../../components/ai-centre/delegated-jobs';
import { HowItWorks } from '../../components/ai-centre/how-it-works';

const FICTION = 'real components; fictional data owners; dark (classic tokens); no authenticated server journey';
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }));
});
afterEach(cleanup);

const dark = (node: React.ReactNode) => <div className="dark min-h-screen bg-background p-4 text-foreground">{node}</div>;

describe.each(Object.keys(copies) as Locale[])('AI centre, dark, phone width — %s', locale => {
  it.each(ROLES)('%s: Inbox, Delegated jobs and How it works', async role => {
    state.locale = locale; state.role = role;
    const m = messagesFor(locale);
    const session = { tenantId: 'fictional', userId: 'fictional', personId: 'fictional', roles: [role === 'group_admin' ? 'hr_admin' : role] } as never;
    const inbox = await AiCentreInbox({ session });
    const jobs = await AiCentreDelegatedJobs();
    const view = render(<NextIntlClientProvider locale={locale} messages={m as never} timeZone="Asia/Kuala_Lumpur">{dark(<div className="mx-auto max-w-6xl space-y-10">
      {/* AI v2 Phase 1: no Inbox tab (Today replaces it); the retired Inbox component is still drawn here until it is removed. */}
      <AiCentreTabs active="ask" isAdmin={admin(role)} />{inbox}{jobs}<HowItWorks adminHref={admin(role) ? '#ai-centre-live-status' : undefined} />
    </div>)}</NextIntlClientProvider>);

    const tabs = within(view.container.querySelector('nav[data-ai-centre-tabs]') as HTMLElement).getAllByRole('link');
    expect(tabs.some(tab => tab.getAttribute('href') === '/control-tower/agents/features')).toBe(admin(role));
    expect(view.container.querySelector('a[href="/control-tower/exceptions"]') !== null).toBe(admin(role));
    // No raw message keys reach the screen in any language.
    expect(view.container.textContent).not.toMatch(/aiCentre\.|notifications\.task\./);

    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), locale, `ai-centre-role-${role}-dark`, FICTION, 'classic');
  }, 180000);
});
