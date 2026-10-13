import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

vi.mock('next/navigation', () => ({ usePathname: () => '/control-tower/readiness' }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: en, namespace }),
  getFormatter: async () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock('../app/control-tower/orchestrator-actions', () => ({ refreshOrchestrationAction: vi.fn() }));
vi.mock('../core/readiness-actions', () => ({ myReadinessActions: vi.fn() }));
import { myReadinessActions } from '../core/readiness-actions';
import { MyReadinessWork } from '../app/me/readiness-work';
import { ControlTowerNavigation } from '../app/control-tower/navigation';
import { OrchestrationWorkQueue } from '../app/control-tower/work-queue';

const show = (element: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
const empty = { actionsUnavailable: false, rows: [], total: 0, verified: 0, inactive: 0, observedAt: null, lastRun: null };
afterEach(cleanup);

describe('consolidated Control Tower', () => {
  it('keeps the existing queues and controls in one navigation with the active route identified', () => {
    show(<ControlTowerNavigation />);
    expect(screen.getByRole('link', { name: 'Employee data' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Approvals' }).getAttribute('href')).toBe('/control-tower/actions');
    expect(screen.getByRole('link', { name: 'Automation' }).getAttribute('href')).toBe('/control-tower/agents');
    expect(screen.getAllByRole('link')).toHaveLength(6);
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
    show(await OrchestrationWorkQueue({ view: { ...empty, observedAt: now, lastRun: { at: now, failed: true } } }));
    expect(screen.getByText(en.controlTower.orchestrator.empty)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(en.controlTower.orchestrator.runFailed);
    expect(screen.getByText(en.controlTower.orchestrator.verificationNote)).toBeTruthy();
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
