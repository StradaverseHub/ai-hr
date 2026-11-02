/** REVIEW (independent UI review) — drafted as test/review/ai-centre-inbox-payroll-off.dom.test.tsx.
 *
 * An HR administrator in a tenant WITHOUT the payroll module opens the Inbox. The digest's
 * "Statutory deadlines" tile is built for any administrator (core/digest/daily-digest.ts:61, `if(isAdmin(ctx))`,
 * no payroll gate) and always links to DIGEST_PAGES.deadlines = '/payroll/statutory-forms'. That route sits
 * under app/payroll/layout.tsx = moduleLayout('payroll'), which bounces to /?moduleUnavailable=payroll.
 * The Inbox itself already gates its payroll findings on the module (inbox.tsx:45, 54-55); the digest tile
 * does not. Expected: no deadlines tile (or no link) when payroll is off.
 *
 * digestPreview is mocked here only to supply the administrator's digest shape the real service returns
 * (no database in a DOM test); the gating under test is the Inbox's rendering.
 * FAILED on 7d57fc6a4 and on cdfcf53f (run 41353460111); passes on claude/teras-fix-ui. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { enWithAiCentre } from '../helpers/ai-centre-messages';

vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: enWithAiCentre as never, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams() }));
vi.mock('../../lib/authz', () => ({ isAdmin: () => true, isGroupAdmin: () => true }));
vi.mock('../../core/entitlements', () => ({ isModuleEnabledOrFalse: (_s: unknown, code: string) => code !== 'payroll', isModuleEnabled: (_s: unknown, code: string) => code !== 'payroll' }));
vi.mock('../../core/read', () => ({ allowedCompanies: async () => [{ id: 'fictional-company' }] }));
vi.mock('../../lib/scope', () => ({ getScopeIds: async (ids: string[]) => ids }));
vi.mock('../../core/approvals-inbox', () => ({ listPendingTasks: async () => [] }));
vi.mock('../../core/payroll-anomaly', () => ({ openExceptionsAcrossRuns: vi.fn() }));
vi.mock('../../core/agent-actions', () => ({ proposeActions: vi.fn() }));
vi.mock('../../core/record-readiness', () => ({ recordReadiness: async () => ({ employees: 3, ready: 3, gaps: [] }) }));
vi.mock('../../app/assistant/centre/recommendation', () => ({ readLeaveRecommendation: vi.fn() }));
vi.mock('../../core/digest/daily-digest', () => ({
  digestPreview: async () => ({ kind: 'teras.daily_digest', version: 1, asOf: '2026-11-02',
    approvals: { total: 0, byKind: [], page: '/approvals' },
    setup: { blocked: 0, attention: 1, companies: 1, unknown: 0, page: '/control-tower/readiness' },
    deadlines: { overdue: 0, dueSoon: 0, page: '/payroll/statutory-forms' }, text: 'fixture' }),
  latestDailyDigest: async () => null,
}));

import { AiCentreInbox } from '../../app/assistant/centre/inbox';

afterEach(cleanup);

describe('Inbox for an HR administrator without payroll', () => {
  it('fixed M11: no digest link leads into the disabled payroll module', async () => {
    const node = await AiCentreInbox({ session: { tenantId: 'fictional', userId: 'fictional', personId: 'fictional', roles: ['hr_admin'] } as never });
    const view = render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">{node}</NextIntlClientProvider>);
    expect(view.container.querySelector('[data-inbox-digest]')).not.toBeNull();
    // The payroll findings are already gated (pass) ...
    expect(view.container.querySelector('a[href="/control-tower/exceptions"]')).toBeNull();
    // ... the digest's deadlines tile is not (fail).
    expect(view.container.querySelector('a[href^="/payroll/"]')).toBeNull();
  });
});
