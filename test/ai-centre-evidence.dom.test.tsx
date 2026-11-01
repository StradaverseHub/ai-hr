/** AI centre: CI component evidence of every new or regrouped screen, from the real components with
 * fictional data owners (no database, no authenticated server journey). Each case also asserts what the
 * screen must show, so the screenshots are not the only check. Screenshots are written only on the selected
 * GitHub Actions runner (test/helpers/ai-review-screenshots.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { aiReviewDomHtml, captureAiReviewScreenshots } from './helpers/ai-review-screenshots';
import { withAiCentre } from './helpers/ai-centre-messages';
import en from '../messages/en.json'; import ms from '../messages/ms.json'; import zh from '../messages/zh.json';
import th from '../messages/th.json'; import ta from '../messages/ta.json'; import viCopy from '../messages/vi.json';
import { AI_FEATURES } from '../lib/ai/features';

const copies = { en, ms, zh, th, ta, vi: viCopy };
type Locale = keyof typeof copies;
const state = vi.hoisted(() => ({ locale: 'en' as string, tasks: [] as unknown[], reduce: true }));
const messagesFor = (locale: string) => withAiCentre(locale, copies[locale as Locale] as Record<string, unknown>) as Record<string, any>;

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: messagesFor(state.locale), namespace }),
  getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), usePathname: () => '/leave', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('../lib/authz', () => ({ isGroupAdmin: () => true, isAdmin: () => true, requireAdmin: async () => ({}) }));
vi.mock('../core/entitlements', () => ({ isModuleEnabledOrFalse: () => true, isModuleEnabled: () => true }));
vi.mock('../core/read', () => ({ allowedCompanies: async () => [{ id: 'fictional-company' }] }));
vi.mock('../lib/scope', () => ({ getScopeIds: async (ids: string[]) => ids }));
vi.mock('../core/approvals-inbox', () => ({ listPendingTasks: async () => state.tasks }));
vi.mock('../core/payroll-anomaly', () => ({ openExceptionsAcrossRuns: async () => ({ total: 3, cappedOut: false, rows: [{ disposition: 'block' }, { disposition: 'review' }, { disposition: 'review' }] }) }));
vi.mock('../core/agent-actions', () => ({ proposeActions: async () => [{ type: 'fictional', subjects: [], count: 2, overCap: false }] }));
vi.mock('../core/record-readiness', () => ({ recordReadiness: async () => ({ employees: 40, ready: 36, gaps: [] }) }));
vi.mock('../core/ai-management', () => ({
  AI_RUN_STATE_FILTERS: ['blocked', 'failed'],
  aiManagementView: async () => ({ provider: { provider: 'fictional', model: 'fictional/model' }, mayWriteUsers: true,
    features: AI_FEATURES.map(feature => ({ ...feature, enabled: feature.setting === null, state: feature.setting === null ? 'ready' : 'paused', mayWrite: feature.kind !== 'platform' })),
    agentSwitches: {}, usage: [], policies: [], userDefault: null, companies: [], companyUsage: [], users: [], moreUsers: false, groups: [],
    attention: { companies: [], users: [], blocked: [] }, runs: [], runFilter: {}, legacyBudget: null, spend: null }),
  bulkAssistantDepartments: async () => [], previewBulkAssistantAccess: async () => ({ matched: 0, changing: 0 }),
}));
vi.mock('../core/ai-inventory', () => ({ aiInventoryView: async () => ({ scope: 'registry', rows: [] }), aiManagementAlerts: async () => ({ status: 'ok', alerts: [] }), aiRunHistory: async () => null }));
vi.mock('../core/hr-orchestrator', () => ({ orchestrationQueue: async () => ({}) }));
vi.mock('../app/control-tower/work-queue', () => ({ OrchestrationWorkQueue: () => null }));
vi.mock('../app/control-tower/agents/actions', () => ({ applyBulkAssistantAction: vi.fn(), clearGroupAllowanceAction: vi.fn(), setGroupAllowanceAction: vi.fn(), clearUserAllowanceAction: vi.fn(), setAiSpendBudgetAction: vi.fn(), setAiAllowanceAction: vi.fn(), setAiFeatureAction: vi.fn(), setAiFeatureCapAction: vi.fn(), setAssistantPermissionAction: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: async () => ({ tenantId: 'fictional', userId: 'fictional', roles: ['hr_admin'] }) }));
vi.mock('../core/assistant-grant', () => ({ mayUseAssistant: async () => ({ allowed: false, reason: 'no_grant' }) }));
vi.mock('../components/assistant/bank-maintenance-panel', () => ({ BankMaintenancePanel: () => null }));
vi.mock('../app/assistant/launcher-actions', () => ({ askFromLauncherAction: vi.fn() }));
vi.mock('../core/digest/daily-digest', () => ({ digestPreview: async () => { throw Error('fixture: digest not part of this screen'); }, latestDailyDigest: async () => null }));
vi.mock('../app/assistant/centre/recommendation', () => ({ readLeaveRecommendation: vi.fn() }));

import { AiCentreTabs } from '../components/ai-centre/centre-tabs';
import { AiCentreInbox } from '../app/assistant/centre/inbox';
import { AiCentreDelegatedJobs } from '../components/ai-centre/delegated-jobs';
import { HowItWorks } from '../components/ai-centre/how-it-works';
import { AiManagementScreen } from '../app/control-tower/agents/screen';
import AssistantBankPage from '../app/assistant/bank/page';
import { AssistantLauncher } from '../components/assistant/assistant-launcher';

const session = { tenantId: 'fictional', userId: 'fictional', roles: ['hr_admin'] } as never;
const FICTION = 'real components; fictional data owners; no authenticated server journey';
const wrap = (locale: string, node: React.ReactNode) =>
  render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
beforeEach(() => {
  state.tasks = [
    { id: 'a1', kind: 'leave', subjectName: 'Fictional Person A', createdAt: '2026-10-31T02:00:00.000Z', linkPath: '/approvals?kind=leave&id=a1' },
    { id: 'b2', kind: 'claim', subjectName: 'Fictional Person B', createdAt: '2026-10-30T02:00:00.000Z', linkPath: '/approvals?kind=claim&id=b2' },
  ];
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: state.reduce && query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }));
});
afterEach(cleanup);

describe('AI centre screens', () => {
  it.each(['en', 'zh'] as const)('%s Inbox lists decisions as cards that only link to the deciding page', async locale => {
    state.locale = locale;
    const tabs = <AiCentreTabs active="inbox" isAdmin />;
    const inbox = await AiCentreInbox({ session });
    const view = wrap(locale, <div className="mx-auto max-w-6xl space-y-6">{tabs}{inbox}</div>);
    const cards = view.container.querySelectorAll('[data-proposal-card]');
    expect(cards).toHaveLength(5);
    for (const card of cards) { expect(card.querySelector('form, button')).toBeNull(); expect(card.querySelectorAll('a')).toHaveLength(1); }
    expect(view.container.querySelector('a[href="/approvals?kind=leave&id=a1"]')).not.toBeNull();
    expect(view.container.querySelector('a[href="/control-tower/exceptions"]')).not.toBeNull();
    expect(within(view.container.querySelector('nav[data-ai-centre-tabs]') as HTMLElement).getByRole('link', { current: 'page' })).toHaveAttribute('href', '/assistant?view=inbox');
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), locale, 'ai-centre-inbox', FICTION, 'atelier');
  }, 120000);

  it('employees see no administrator tabs and no findings', async () => {
    state.locale = 'en';
    const tabs = <AiCentreTabs active="ask" isAdmin={false} />;
    const view = wrap('en', tabs);
    expect(screen.queryByRole('link', { name: messagesFor('en').aiCentre.tabs.workers })).toBeNull();
    expect(screen.getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/assistant', '/assistant?view=inbox', '/assistant?view=jobs', '/assistant?view=how']);
    view.unmount();
  });

  it('Workers groups every AI feature by family, keeps each switch form, and shows the built-in checks', async () => {
    state.locale = 'en';
    const page = await AiManagementScreen({ session, section: 'features', searchParams: Promise.resolve({}), builtInChecks: [
      { id: 'detectors', kind: 'deterministic', active: true, reasonKey: 'detectorsOn' }, { id: 'sweep', kind: 'deterministic', active: true, reasonKey: 'sweepOn' },
      { id: 'actions', kind: 'deterministic', active: true, reasonKey: 'actionsOn' }, { id: 'autonomy', kind: 'deterministic', active: false, reasonKey: 'autonomyByDesign', offByDesign: true }] });
    const view = wrap('en', page);
    const m = messagesFor('en').aiCentre.workers.families;
    for (const family of ['watcher', 'chaser', 'preparer', 'explainer', 'platform']) expect(screen.getByRole('columnheader', { name: new RegExp(m[family]) })).toBeInTheDocument();
    for (const feature of AI_FEATURES) expect(view.container.querySelector(`#ai-feature-${feature.id}`)).not.toBeNull();
    expect(view.container.querySelectorAll('input[name=feature]').length).toBeGreaterThan(10);
    expect(screen.getByText(messagesFor('en').aiCentre.workers.byDesign)).toBeInTheDocument();
    expect(view.container.querySelector('a[href="/admin/scheduled-actions"]')).not.toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-workers', FICTION, 'atelier');
  }, 120000);

  it('Delegated jobs says nothing is delegated and lists what never can be', async () => {
    state.locale = 'en';
    const view = wrap('en', <div className="mx-auto max-w-6xl space-y-6"><AiCentreTabs active="jobs" isAdmin={false} />{await AiCentreDelegatedJobs()}</div>);
    expect(screen.getByText(messagesFor('en').aiCentre.jobs.leadStrong)).toBeInTheDocument();
    expect(view.container.querySelector('a[href="/delegations"]')).not.toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-jobs', FICTION, 'atelier');
  }, 120000);

  it.each(Object.keys(copies) as Locale[])('%s How it works renders the clockwork figure and steps', async locale => {
    state.locale = locale;
    const how = messagesFor(locale).aiCentre.how;
    const view = wrap(locale, <div className="mx-auto max-w-6xl space-y-6"><AiCentreTabs active="how" isAdmin /><HowItWorks /></div>);
    const step = within(screen.getByRole('tablist', { name: how.stepsLabel })).getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')!;
    step.focus(); fireEvent.keyDown(step, { key: 'ArrowRight' }); fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' }); fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('heading', { level: 2, name: how.steps.s3 })).toBeInTheDocument();
    const figure = view.container.querySelector('[data-clockwork-figure]')!;
    expect(figure.querySelector('[data-part="model"]')).not.toBeNull();
    expect(within(figure as HTMLElement).getByText(how.parts.model)).toBeInTheDocument();
    expect(figure.querySelector('[data-face-label]')).toHaveTextContent('Noveri OS');
    expect(screen.getByText(how.titleNamed.replace('{name}', 'Noveri'))).toBeInTheDocument();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), locale, 'ai-centre-how', FICTION, 'atelier');
  }, 120000);

  it('a review page renders inside the shared shell, with the way back to the Inbox and its own refusal', async () => {
    state.locale = 'en';
    const page = await AssistantBankPage({ searchParams: Promise.resolve({}) });
    const view = wrap('en', page);
    const shell = view.container.querySelector('[data-review-shell]')!;
    expect(shell).not.toBeNull();
    expect(shell.querySelector('a[href="/assistant?view=inbox"]')).not.toBeNull();
    expect(screen.getByText(en.assistant.denied_no_grant)).toBeInTheDocument();
    expect(shell.querySelector('a[href="/control-tower/agents/allowances#user-limits"]')).not.toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-review-shell', FICTION, 'atelier');
  }, 120000);

  it('the floating chat links to the Inbox with the decision count', async () => {
    state.locale = 'en';
    const view = wrap('en', <AssistantLauncher position="bottom-right" hiddenAreas={[]} inboxCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: messagesFor('en').aiCentre.launcher.open.replace('{name}', 'Noveri') }));
    const link = screen.getByRole('link', { name: new RegExp(messagesFor('en').aiCentre.launcher.inbox) });
    expect(link).toHaveAttribute('href', '/assistant?view=inbox');
    expect(link).toHaveTextContent('2');
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-floating-chat', FICTION, 'atelier');
  }, 120000);
});
