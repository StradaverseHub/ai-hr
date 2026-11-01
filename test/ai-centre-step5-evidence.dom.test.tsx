/** AI centre step 5: rendered evidence per role, from the real components with fictional data owners
 * (no database, no authenticated server journey). Each case asserts what that role must and must not see:
 *  - employee: Inbox digest, no findings, no recommendations, no administrator tabs;
 *  - manager or approver: a leave decision card whose recommendation opens on request and names the failed
 *    rule with its version label, never a reject verdict;
 *  - company HR administrator: Workers without the registry (the registry is group administrators' only);
 *  - group administrator: the worker registry, a worker's detail and the outcome summary.
 * Screenshots are written only on the selected GitHub Actions runner. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { aiReviewDomHtml, captureAiReviewScreenshots } from './helpers/ai-review-screenshots';
import { enWithAiCentre } from './helpers/ai-centre-messages';
import { AI_FEATURES } from '../lib/ai/features';

const state = vi.hoisted(() => ({ admin: false, group: false, tasks: [] as unknown[], recommendation: null as unknown }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: enWithAiCentre as never, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('../lib/authz', () => ({ isAdmin: () => state.admin, isGroupAdmin: () => state.group, requireAdmin: async () => ({}) }));
vi.mock('../core/entitlements', () => ({ isModuleEnabledOrFalse: () => true, isModuleEnabled: () => true }));
vi.mock('../core/read', () => ({ allowedCompanies: async () => [{ id: 'fictional-company' }] }));
vi.mock('../lib/scope', () => ({ getScopeIds: async (ids: string[]) => ids }));
vi.mock('../core/approvals-inbox', () => ({ listPendingTasks: async () => state.tasks }));
vi.mock('../core/payroll-anomaly', () => ({ openExceptionsAcrossRuns: async () => ({ total: 1, cappedOut: false, rows: [{ disposition: 'review' }] }) }));
vi.mock('../core/agent-actions', () => ({ proposeActions: async () => [] }));
vi.mock('../core/record-readiness', () => ({ recordReadiness: async () => ({ employees: 12, ready: 12, gaps: [] }) }));
vi.mock('../core/digest/daily-digest', () => ({
  digestPreview: async () => ({ kind: 'teras.daily_digest', version: 1, asOf: '2026-11-02',
    approvals: { total: state.tasks.length, byKind: [], page: '/approvals' },
    setup: state.admin ? { blocked: 1, attention: 2, companies: 1, unknown: 0, page: '/control-tower/readiness' } : null,
    deadlines: state.admin ? { overdue: 0, dueSoon: 1, page: '/payroll/statutory-forms' } : null, text: 'fixture' }),
  latestDailyDigest: async () => (state.admin ? { recordId: 'fictional', preparedAt: new Date('2026-11-02T00:30:00Z'), digest: {} } : null),
}));
vi.mock('../app/assistant/centre/recommendation', () => ({ readLeaveRecommendation: async () => state.recommendation }));
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

import { AiCentreTabs } from '../components/ai-centre/centre-tabs';
import { AiCentreInbox } from '../app/assistant/centre/inbox';
import { AiManagementScreen } from '../app/control-tower/agents/screen';
import type { WorkerRow } from '../core/agent-registry/views';

const FICTION = 'real components; fictional data owners; no authenticated server journey';
const session = { tenantId: 'fictional', userId: 'fictional', roles: ['hr_admin'] } as never;
const wrap = (node: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
const LEAVE_ID = '22222222-2222-4222-8222-222222222222';
afterEach(cleanup);

function worker(id: string, overrides: Partial<WorkerRow>): WorkerRow {
  return { id, label: id, family: 'chaser', trigger: { kind: 'schedule', detail: 'fixture' }, readScope: [], effect: 'notify', authority: { kind: 'tenant_switch', actsAs: 'agent_principal' }, owners: [],
    switch: { on: false, owner: 'tenant_setting', detail: 'off' }, stopped: false, stopHonoured: true, stopPending: null, gate: { run: false, reasons: ['switched_off'] },
    lastRunAt: null, metrics: { measured: false, acceptanceRate: null, reversalRate: null, decided: 0, reason: 'fixture' }, mandates: null, ...overrides } as WorkerRow;
}
const ROWS: WorkerRow[] = [
  worker('approver_recommendation', { family: 'explainer', trigger: { kind: 'request', detail: 'fixture' }, effect: 'none', authority: { kind: 'tenant_switch', actsAs: 'requester' },
    switch: { on: true, owner: 'worker_control', detail: 'on' }, gate: { run: true, reasons: [] }, lastRunAt: new Date('2026-11-02T02:15:00Z'),
    metrics: { measured: true, acceptanceRate: 0.82, reversalRate: 0.04, decided: 50, reason: null } }),
  worker('claims_triage', { family: 'watcher' }),
  worker('payroll_anomaly_narrator', { family: 'explainer', trigger: { kind: 'request', detail: 'fixture' }, effect: 'none', switch: { on: true, owner: 'ai_provider', detail: 'on' }, gate: { run: true, reasons: [] }, stopHonoured: false, stopPending: 'fixture' }),
  worker('daily_digest', { family: 'preparer', effect: 'prepare', authority: { kind: 'mandate', jobType: 'daily_digest' } as never, switch: { on: true, owner: 'job_type', detail: 'on' }, gate: { run: true, reasons: [] }, mandates: { active: 3, total: 4 } }),
];

describe('AI centre step 5, rendered per role', () => {
  it('employee: the Inbox digest, no findings, no recommendation, no administrator tabs', async () => {
    Object.assign(state, { admin: false, group: false, tasks: [] });
    const view = wrap(<div className="mx-auto max-w-6xl space-y-6"><AiCentreTabs active="inbox" isAdmin={false} />{await AiCentreInbox({ session })}</div>);
    const digest = view.container.querySelector('[data-inbox-digest]') as HTMLElement;
    expect(within(digest).getByText(enWithAiCentre.aiCentre.digest.approvals)).toBeInTheDocument();
    expect(within(digest).queryByText(enWithAiCentre.aiCentre.digest.setup)).toBeNull();
    expect(view.container.querySelector('[data-recommendation-loader]')).toBeNull();
    expect(screen.queryByRole('link', { name: enWithAiCentre.aiCentre.tabs.workers })).toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-step5-employee-inbox', FICTION, 'atelier');
  }, 120000);

  it('manager or approver: the recommendation opens on request and names the failed rule with its version', async () => {
    Object.assign(state, { admin: false, group: false, tasks: [{ id: LEAVE_ID, kind: 'leave', subjectName: 'Fictional Person C', createdAt: '2026-11-01T02:00:00.000Z', linkPath: `/approvals?kind=leave&id=${LEAVE_ID}` }],
      recommendation: { kind: 'recommendation', verdict: 'needs_review', failedRules: [{ check: 'balance_covers', blocking: true, version: { kind: 'leave_type', version: 3 } }, { check: 'team_coverage', blocking: false, version: null }] } });
    // Before the approver opens it: a link, never a recommendation run.
    const closed = wrap(await AiCentreInbox({ session }));
    expect(closed.container.querySelector('[data-recommendation-loader]')).toHaveAttribute('href', `/assistant?view=inbox&recommend=${LEAVE_ID}#recommendation-${LEAVE_ID}`);
    expect(closed.container.querySelector('[data-recommendation]')).toBeNull();
    closed.unmount();
    const view = wrap(<div className="mx-auto max-w-6xl space-y-6"><AiCentreTabs active="inbox" isAdmin={false} />{await AiCentreInbox({ session, recommend: LEAVE_ID })}</div>);
    const panel = view.container.querySelector('[data-recommendation]') as HTMLElement;
    const copy = enWithAiCentre.aiCentre.recommendation;
    expect(panel).toHaveAttribute('data-recommendation', 'needs_review');
    expect(within(panel).getByText(copy.check.balance_covers)).toBeInTheDocument();
    expect(within(panel).getByText(copy.blocking)).toBeInTheDocument();
    expect(within(panel).getByText(copy.version.leave_type.replace('{version}', '3'))).toBeInTheDocument();
    expect(within(panel).getAllByText(/version/)).toHaveLength(1);
    expect(panel.textContent).not.toMatch(/reject/i);
    expect(view.container.querySelectorAll('[data-proposal-card] button, [data-proposal-card] form')).toHaveLength(0);
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-step5-approver-inbox', FICTION, 'atelier');
  }, 120000);

  it('company HR administrator: Workers without the registry', async () => {
    Object.assign(state, { admin: true, group: false });
    const view = wrap(await AiManagementScreen({ session, section: 'features', searchParams: Promise.resolve({}), builtInChecks: [], registry: null }));
    expect(view.container.querySelector('#ai-registry')).toBeNull();
    expect(view.container.querySelector('#ai-features')).not.toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-step5-company-admin-workers', FICTION, 'atelier');
  }, 120000);

  it('group administrator: the registry, a worker detail and the outcome summary', async () => {
    Object.assign(state, { admin: true, group: true });
    const view = wrap(await AiManagementScreen({ session, section: 'features', searchParams: Promise.resolve({ worker: 'daily_digest' }), builtInChecks: [], registry: {
      rows: ROWS,
      summary: { tenantId: 'fictional', since: null, records: 128, byWorker: [], byFamily: { watcher: 40, chaser: 30, preparer: 18, decider: 0, explainer: 40 }, mandates: [] },
      detail: { worker: ROWS[3], recentRuns: [{ at: new Date('2026-11-02T00:30:00Z'), runId: 'r1', outcomeKind: 'prepared', humanInvolvement: 'none', decision: null, mandateId: 'm1' }],
        mandates: [{ id: 'm1', grantorUserId: 'u', grantorPersonId: 'p', agentIdentity: 'agent.daily_digest', state: 'active', validUntil: new Date('2027-01-31T00:00:00Z'), revokedBy: null, version: 1 }] },
    } }));
    const copy = enWithAiCentre.aiCentre.registry;
    const registry = view.container.querySelector('#ai-registry') as HTMLElement;
    expect(within(registry).getByText(copy.workers.approver_recommendation)).toBeInTheDocument();
    expect(within(registry).getByText('82% accepted')).toBeInTheDocument();
    expect(within(registry).getAllByText(copy.notMeasured.replace('{count}', '0')).length).toBeGreaterThan(0);
    expect(within(registry).queryByText('0% accepted')).toBeNull();
    // No switch is changed from the registry yet: the registry-controlled one is shown read-only (its action
    // needs an ADR-0151 inventory entry inside the approved digest); the others link to where theirs lives.
    expect(registry.querySelectorAll('form, button')).toHaveLength(0);
    expect(registry.querySelector('#worker-approver_recommendation')).toHaveTextContent(copy.switchOwner.worker_control);
    expect(within(registry).getByText(copy.stopPending)).toBeInTheDocument();
    expect(view.container.querySelector('#worker-detail')).toHaveTextContent(copy.mandateState.active);
    expect(view.container.querySelector('#ai-outcomes')).toHaveTextContent('128');
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'ai-centre-step5-group-admin-workers', FICTION, 'atelier');
  }, 120000);
});
