import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viMessages from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import { HR_HARNESS_VERSION, summarizeOrchestrationPass } from '../core/orchestrator-harness';
import type { orchestrationQueue } from '../core/hr-orchestrator';

const catalogues = { en, ms, zh, vi: viMessages, th, ta };
let renderLocale: keyof typeof catalogues = 'en';

vi.mock('next/navigation', () => ({ usePathname: () => '/control-tower/readiness' }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: renderLocale, messages: catalogues[renderLocale], namespace }),
  getFormatter: async () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock('../app/control-tower/orchestrator-actions', () => ({ refreshOrchestrationAction: vi.fn() }));
vi.mock('../core/readiness-actions', () => ({ myReadinessActions: vi.fn() }));
import { myReadinessActions } from '../core/readiness-actions';
import { MyReadinessWork } from '../app/me/readiness-work';
import { ControlTowerNavigation } from '../app/control-tower/navigation';
import { OrchestrationWorkQueue } from '../app/control-tower/work-queue';

const show = (element: React.ReactNode) => render(<NextIntlClientProvider locale={renderLocale} messages={catalogues[renderLocale]}>{element}</NextIntlClientProvider>);
const empty = { actionsUnavailable: false, rows: [], total: 0, verified: 0, inactive: 0, observedAt: null, lastRun: null };
const successfulSteps = { observe: 'succeeded', readiness: 'succeeded', claims: 'succeeded', verify: 'succeeded' } as const;
function populatedQueue(): Awaited<ReturnType<typeof orchestrationQueue>> {
  const now = new Date();
  const common = { openedAt: now, observedAt: now, verifiedAt: null, reopenCount: 0, company: 'Fictional Lantern Sdn Bhd' };
  return { ...empty, observedAt: now, total: 2, verified: 3,
    lastRun: { at: now, ...summarizeOrchestrationPass({ harnessVersion: HR_HARNESS_VERSION, failed: false, steps: successfulSteps }) },
    rows: [
      { ...common, id: 'bank-case', employmentId: 'fictional-employee', name: 'Amina Fixture', gap: 'no_bank_account',
        state: 'needs_input', audience: 'employee', action: { type: 'submit_correction', audience: 'employee', tab: 'bankStatutory', requestId: null, approver: 'admin' } },
      { ...common, id: 'tax-case', employmentId: 'fictional-pending', name: 'Daniel Fixture', gap: 'no_tax_number',
        state: 'needs_review', audience: 'hr', action: { type: 'review_submission', audience: 'hr', tab: 'bankStatutory', requestId: 'fictional-request', approver: 'group_admin', mayReview: false } },
    ] };
}
afterEach(() => { cleanup(); renderLocale = 'en'; });

describe('consolidated Control Tower', () => {
  it('keeps the existing queues and controls in one navigation with the active route identified', () => {
    show(<ControlTowerNavigation />);
    expect(screen.getByRole('link', { name: 'Employee data' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Approvals' }).getAttribute('href')).toBe('/control-tower/actions');
    expect(screen.getByRole('link', { name: 'AI management' }).getAttribute('href')).toBe('/control-tower/agents');
    expect(screen.getByRole('link', { name: 'Opportunities' }).getAttribute('href')).toBe('/control-tower/opportunities');
    expect(screen.getAllByRole('link')).toHaveLength(7);
  });
  it('does not present an unobserved queue as a successful clean check', async () => {
    show(await OrchestrationWorkQueue({ view: empty }));
    expect(screen.getByText(en.controlTower.orchestrator.unobserved)).toBeTruthy();
    expect(screen.queryByText(en.controlTower.orchestrator.empty)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check current records' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Execution history' })).toBeNull();
  });
  it('offers the system execution log only when the parent authorizes that view', async () => {
    show(await OrchestrationWorkQueue({ view: empty, canViewRuns: true }));
    expect(screen.getByRole('link', { name: 'Execution history' }).getAttribute('href')).toBe('/admin/scheduled-actions');
  });
  it('keeps core HR available without advertising payroll-specific queues', () => {
    show(<ControlTowerNavigation payrollEnabled={false} />);
    expect(screen.getByRole('link', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Employee data' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Payroll exceptions' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Approvals' })).toBeNull();
  });
  it('shows failed execution separately from verified absence of open cases', async () => {
    const now = new Date();
    show(await OrchestrationWorkQueue({ view: { ...empty, observedAt: now, lastRun: { at: now, ...summarizeOrchestrationPass({ failed: true }) } } }));
    expect(screen.getByText(en.controlTower.orchestrator.empty)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(en.controlTower.orchestrator.runFailed);
    expect(screen.getByText(en.controlTower.orchestrator.verificationNote)).toBeTruthy();
  });
  it('keeps step details collapsed until requested and separates execution from HR outcomes', async () => {
    const now = new Date();
    show(await OrchestrationWorkQueue({ view: { ...empty, observedAt: now, lastRun: { at: now,
      ...summarizeOrchestrationPass({ harnessVersion: HR_HARNESS_VERSION, failed: false, steps: { ...successfulSteps, readiness: 'failed' } }) } } }));
    const details = screen.getByText(en.controlTower.orchestrator.runDetails.title).closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    const readiness = screen.getByText(en.controlTower.orchestrator.runDetails.steps.readiness).closest('div')!;
    expect(within(readiness).getByText(en.controlTower.orchestrator.runDetails.states.failed)).toBeTruthy();
    const verification = screen.getByText(en.controlTower.orchestrator.runDetails.steps.verify).closest('div')!;
    expect(within(verification).getByText(en.controlTower.orchestrator.runDetails.states.succeeded)).toBeTruthy();
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.evidenceNote)).toBeTruthy();
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.receiptNote)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.controlTower.orchestrator.refresh })).toBeTruthy();
  });
  it.each(['en', 'ms', 'zh', 'vi', 'th', 'ta'] as const)('offers scoped failure details without group-only history in %s', async locale => {
    renderLocale = locale;
    const messages = catalogues[locale].controlTower.orchestrator;
    show(await OrchestrationWorkQueue({ view: { ...empty, lastRun: { at: new Date(),
      ...summarizeOrchestrationPass({ harnessVersion: HR_HARNESS_VERSION, failed: false, steps: { ...successfulSteps, claims: 'failed' } }) } } }));
    expect(screen.getByRole('status').textContent).toBe(messages.runFailed);
    expect(screen.queryByRole('link', { name: messages.runs })).toBeNull();
    const details = screen.getByText(messages.runDetails.title).closest('details')!;
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    const claims = within(details).getByText(messages.runDetails.steps.claims).closest('div')!;
    expect(within(claims).getByText(messages.runDetails.states.failed)).toBeTruthy();
  });
  it.each([
    { name: 'legacy incomplete', payload: { failed: false } },
    { name: 'unsupported future', payload: { harnessVersion: 'readiness-v999', failed: false, steps: successfulSteps } },
    { name: 'private malformed', payload: { harnessVersion: 'private employee data', failed: false,
      steps: { observe: { status: 'succeeded', value: 'private source data' }, claims: 'private instruction' }, error: 'private provider error' } },
  ])('does not label a $name receipt as completed', async ({ payload }) => {
    show(await OrchestrationWorkQueue({ view: { ...empty, lastRun: { at: new Date(), ...summarizeOrchestrationPass(payload) } } }));
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.outcomes.unknown)).toBeTruthy();
    expect(screen.queryByText(en.controlTower.orchestrator.runDetails.outcomes.succeeded)).toBeNull();
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.incomplete)).toBeTruthy();
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.title).closest('details')!.textContent).not.toContain('private');
  });
  it('keeps unresolved source work visible after a completed run and respects the supplied review permission', async () => {
    show(await OrchestrationWorkQueue({ view: populatedQueue() }));
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'controlTower.orchestrator' });
    expect(screen.getByText(t('openCount', { count: 2 }))).toBeTruthy();
    expect(screen.getByText(t('verifiedCount', { count: 3 }))).toBeTruthy();
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.outcomes.succeeded)).toBeTruthy();
    expect(screen.queryByText(en.controlTower.orchestrator.empty)).toBeNull();
    const employeeRow = screen.getByRole('link', { name: 'Amina Fixture' }).closest('tr')!;
    expect(within(employeeRow).getByText(en.controlTower.orchestrator.collect)).toBeTruthy();
    const pendingRow = screen.getByRole('link', { name: 'Daniel Fixture' }).closest('tr')!;
    expect(within(pendingRow).getByText(en.controlTower.corrections.waitingGroup)).toBeTruthy();
    expect(within(pendingRow).getByText(en.controlTower.corrections.groupHr)).toBeTruthy();
    expect(screen.queryByRole('link', { name: en.controlTower.corrections.review })).toBeNull();
    expect(screen.queryByRole('link', { name: en.controlTower.orchestrator.runs })).toBeNull();
  });
  it('retains source work when next actions are unavailable without offering a stale review action', async () => {
    const view = populatedQueue();
    view.actionsUnavailable = true;
    view.rows[1].action = { ...view.rows[1].action!, mayReview: true };
    show(await OrchestrationWorkQueue({ view }));
    expect(screen.getAllByText(en.controlTower.corrections.actionUnavailable)).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Amina Fixture' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Daniel Fixture' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: en.controlTower.corrections.review })).toBeNull();
    expect(screen.queryByText(en.controlTower.orchestrator.empty)).toBeNull();
  });
  it.each(['en', 'ms', 'zh', 'vi', 'th', 'ta'] as const)('renders the complete run summary in %s', async locale => {
    renderLocale = locale;
    const messages = catalogues[locale].controlTower.orchestrator.runDetails;
    show(await OrchestrationWorkQueue({ view: { ...empty, lastRun: { at: new Date(),
      ...summarizeOrchestrationPass({ harnessVersion: HR_HARNESS_VERSION, failed: false, steps: successfulSteps }) } } }));
    const details = screen.getByText(messages.title).closest('details')!;
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(screen.getByText(messages.outcomes.succeeded)).toBeTruthy();
    for (const label of Object.values(messages.steps)) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getAllByText(messages.states.succeeded)).toHaveLength(4);
    expect(screen.getByText(messages.receiptNote)).toBeTruthy();
    expect(screen.queryByText(messages.incomplete)).toBeNull();
  });
});


describe('personal correction guidance', () => {
  const session = { tenantId: 'tenant', personId: 'person', roles: ['employee'] };
  it('offers the permitted existing form, then replaces the task link while approval is pending', async () => {
    vi.mocked(myReadinessActions).mockResolvedValue([{ gap: 'no_bank_account', type: 'submit_correction', audience: 'employee', tab: 'bankStatutory', requestId: null, approver: 'admin' }]);
    show(await MyReadinessWork({ session, employmentId: 'employment' }));
    expect(screen.getByRole('link', { name: en.controlTower.corrections.submit }).getAttribute('href')).toBe('/me?tab=bankStatutory#section-request-bankStatutory');
    cleanup();
    vi.mocked(myReadinessActions).mockResolvedValue([{ gap: 'no_bank_account', type: 'review_submission', audience: 'hr', tab: 'bankStatutory', requestId: 'request', approver: 'group_admin' }]);
    show(await MyReadinessWork({ session, employmentId: 'employment' }));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(en.controlTower.corrections.waitingGroup)).toBeTruthy();
    expect(screen.getByText(en.controlTower.corrections.approvalNote)).toBeTruthy();
  });
  it('shows an unavailable status rather than a false complete record', async () => {
    vi.mocked(myReadinessActions).mockRejectedValue(new Error('unavailable'));
    show(await MyReadinessWork({ session, employmentId: 'employment' }));
    expect(screen.getByRole('status').textContent).toBe(en.controlTower.corrections.unavailable);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
