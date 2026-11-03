/** REVIEW (independent UI review) — PROPOSED evidence test, drafted as
 * test/review/ai-centre-role-matrix-screenshots.dom.test.tsx.
 *
 * Gap it closes: the CI evidence for run 41338446035 (candidate d8aa371bd) covers en for every screen, zh for
 * the Inbox and all six locales for How it works only; always light, always atelier, widths 1440 and 390;
 * roles employee / approver / company admin / group admin only, and never the payroll partner or a manager.
 * No dark-mode or 375px capture exists for any AI centre screen.
 *
 * This renders, for each role (employee, manager, HR admin, group admin, payroll partner) and each locale
 * (en, ms, zh, vi, ta, th): the tab bar plus Delegated jobs and How it works, in dark mode, using the
 * EXISTING helper test/helpers/ai-review-screenshots.ts unchanged. (AI v2 Phase 1: the Inbox is retired and its
 * component removed; Today replaces it and is rendered per role in test/today-home.dom.test.tsx.)
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
const state = vi.hoisted(() => ({ locale: 'en' as string }));
const messagesFor = (locale: string) => withAiCentre(locale, copies[locale as Locale] as Record<string, unknown>) as Record<string, any>;

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: messagesFor(state.locale) as never, namespace }),
  getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams() }));

import { AiCentreTabs } from '../../components/ai-centre/centre-tabs';
import { AiCentreDelegatedJobs } from '../../components/ai-centre/delegated-jobs';
import { HowItWorks } from '../../components/ai-centre/how-it-works';

const FICTION = 'real components; fictional data owners; dark (classic tokens); no authenticated server journey';
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }));
});
afterEach(cleanup);

const dark = (node: React.ReactNode) => <div className="dark min-h-screen bg-background p-4 text-foreground">{node}</div>;

describe.each(Object.keys(copies) as Locale[])('AI centre, dark, phone width — %s', locale => {
  it.each(ROLES)('%s: Delegated jobs and How it works', async role => {
    state.locale = locale;
    const m = messagesFor(locale);
    const jobs = await AiCentreDelegatedJobs();
    const view = render(<NextIntlClientProvider locale={locale} messages={m as never} timeZone="Asia/Kuala_Lumpur">{dark(<div className="mx-auto max-w-6xl space-y-10">
      <AiCentreTabs active="ask" isAdmin={admin(role)} />{jobs}<HowItWorks adminHref={admin(role) ? '#ai-centre-live-status' : undefined} />
    </div>)}</NextIntlClientProvider>);

    const tabs = within(view.container.querySelector('nav[data-ai-centre-tabs]') as HTMLElement).getAllByRole('link');
    expect(tabs.some(tab => tab.getAttribute('href') === '/control-tower/agents/features')).toBe(admin(role));
    // No raw message keys reach the screen in any language.
    expect(view.container.textContent).not.toMatch(/aiCentre\.|notifications\.task\./);

    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), locale, `ai-centre-role-${role}-dark`, FICTION, 'classic');
  }, 180000);
});
