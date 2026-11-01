/** REVIEW (independent UI review) — drafted as test/review/ai-centre-inbox-digest.dom.test.tsx.
 *
 * The Inbox (app/assistant/centre/inbox.tsx) shows "Your day · Waiting for your decision N" from the REAL
 * digestPreview (core/digest/daily-digest.ts) directly above "Needs your decision M" and the "Decisions M"
 * summary. The two counts come from different queries:
 *  - Inbox: listPendingTasks(session, scopeIds, modules)                       (inbox.tsx:44)
 *  - digest: listPendingTasks(ctx, undefined, modules, {noticeAcknowledgements:false}) (daily-digest.ts:56)
 * so a person with a notice to acknowledge, or with a company selected in the switcher, sees two different
 * numbers for the same thing on one screen. The existing step-5 evidence test mocks digestPreview to
 * return tasks.length, which hides this.
 *
 * Second defect: the digest tile always links to /approvals (DIGEST_PAGES.approvals). For a person who is
 * not an admin or manager and has no approval-page work, app/approvals/page.tsx:193 does redirect('/'), so
 * the tile silently bounces an employee to the dashboard.
 *
 * Only listPendingTasks and the session plumbing are mocked; digestPreview, the Inbox and the cards are real.
 * Non-admin sessions, so digestPreview never opens a database transaction.
 * FAILED on 7d57fc6a4 and on cdfcf53f (run 41353460111); passes on claude/teras-fix-ui. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { enWithAiCentre } from '../helpers/ai-centre-messages';

const state = vi.hoisted(() => ({ scope: ['fictional-company-a'] as string[] }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: enWithAiCentre as never, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams() }));
// The Inbox's own admin check (lib/authz pulls in the request session); same predicate as lib/authz-model.
vi.mock('../../lib/authz', () => ({ isAdmin: (s: { roles?: string[] }) => !!s.roles?.some(r => r === 'hr_admin' || r === 'super_admin') }));
vi.mock('../../db/client',() => ({ withTenant: vi.fn(async () => { throw Error('fixture: no database in this test'); }) }));
vi.mock('../../core/reporting', () => ({ complianceWorklist: vi.fn() }));
vi.mock('../../core/setup-copilot/copilot', () => ({ setupCopilot: vi.fn() }));
vi.mock('../../core/entitlements', () => ({ isModuleEnabledOrFalse: () => true, isModuleEnabled: () => true }));
vi.mock('../../core/read', () => ({ allowedCompanies: async () => state.scope.map(id => ({ id })) }));
vi.mock('../../lib/scope', () => ({ getScopeIds: async (ids: string[]) => ids }));
vi.mock('../../core/payroll-anomaly', () => ({ openExceptionsAcrossRuns: vi.fn() }));
vi.mock('../../core/agent-actions', () => ({ proposeActions: vi.fn() }));
vi.mock('../../core/record-readiness', () => ({ recordReadiness: vi.fn() }));
vi.mock('../../app/assistant/centre/recommendation', () => ({ readLeaveRecommendation: vi.fn() }));

const LEAVE = { id: '00000000-0000-4000-8000-000000000001', kind: 'leave', subjectName: 'Fictional Person A', createdAt: '2026-11-01T02:00:00.000Z', linkPath: '/approvals?task=leave&requestId=00000000-0000-4000-8000-000000000001' };
const NOTICE = { id: 'n1:e1:1', kind: 'noticeAcknowledgement', subjectName: 'Fictional notice', createdAt: '2026-11-01T03:00:00.000Z', linkPath: '/notices/n1?employmentId=e1' };
const OTHER_COMPANY = { ...LEAVE, id: '00000000-0000-4000-8000-000000000002', subjectName: 'Fictional Person B' };
const listPendingTasks = vi.hoisted(() => vi.fn());
vi.mock('../../core/approvals-inbox', () => ({ listPendingTasks }));

import { AiCentreInbox } from '../../app/assistant/centre/inbox';

const employee = { tenantId: 'fictional-tenant', userId: 'fictional-user', personId: 'fictional-person', roles: ['employee'] } as never;
afterEach(() => { cleanup(); listPendingTasks.mockReset(); state.scope = ['fictional-company-a']; });

async function renderInbox() {
  const node = await AiCentreInbox({ session: employee });
  const view = render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
  const digest = view.container.querySelector('[data-inbox-digest]');
  expect(digest, 'digest section rendered').not.toBeNull();
  const digestCount = Number(digest!.querySelector('a .text-lg')?.textContent);
  const decisions = view.container.querySelectorAll('section[aria-labelledby="inbox-decide"] [data-proposal-card]').length;
  return { view, digest: digest!, digestCount, decisions };
}

describe('Inbox digest agrees with the Inbox', () => {
  it('fixed M9: a notice acknowledgement is counted the same in "Your day" and "Needs your decision"', async () => {
    listPendingTasks.mockImplementation(async (_ctx: unknown, _scope: unknown, _modules: unknown, options: { noticeAcknowledgements?: boolean } = {}) =>
      options.noticeAcknowledgements === false ? [LEAVE] : [LEAVE, NOTICE]);
    const { digestCount, decisions } = await renderInbox();
    expect(decisions).toBe(2);
    expect(digestCount).toBe(decisions);
  });

  it('fixed M9: with a company selected, "Your day" counts the same scope as the list below it', async () => {
    listPendingTasks.mockImplementation(async (_ctx: unknown, scope: string[] | undefined) => (scope === undefined ? [LEAVE, OTHER_COMPANY] : [LEAVE]));
    const { digestCount, decisions } = await renderInbox();
    expect(decisions).toBe(1);
    expect(digestCount).toBe(decisions);
  });

  it('fixed M10: an employee with nothing to approve is not sent to /approvals (which redirects them home)', async () => {
    listPendingTasks.mockResolvedValue([]);
    const { digest } = await renderInbox();
    expect(digest.querySelector('a[href="/approvals"]')).toBeNull();
  });
});
