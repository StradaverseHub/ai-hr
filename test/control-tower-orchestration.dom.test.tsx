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
    expect(screen.getByRole('button', { name: en.controlTower.orchestrator.refresh })).toBeTruthy();
  });
  it('does not label a legacy incomplete receipt as completed', async () => {
    show(await OrchestrationWorkQueue({ view: { ...empty, lastRun: { at: new Date(), ...summarizeOrchestrationPass({ failed: false }) } } }));
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.outcomes.unknown)).toBeTruthy();
    expect(screen.queryByText(en.controlTower.orchestrator.runDetails.outcomes.succeeded)).toBeNull();
    expect(screen.getByText(en.controlTower.orchestrator.runDetails.incomplete)).toBeTruthy();
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
