/** Actual board/Kanban components, fictional feedback and release records. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import { captureAiReviewScreenshots } from './helpers/ai-review-screenshots';
import type { FeedbackRow } from '../core/feedback';
const copies = { en, ms, zh, vi: viCopy, th, ta };
const state = vi.hoisted(() => ({ locale: 'en' as keyof typeof copies, rows: [] as FeedbackRow[], query: vi.fn(), counts: undefined as { status: string; count: number }[] | undefined }));
vi.mock('next/link', () => ({ default: ({ children, scroll, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('../components/intent-link', () => ({ default: ({ children, scroll, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: copies[state.locale], namespace }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw Error('not found'); }, usePathname: () => '/feedback', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock('../lib/session', () => ({ getSession: async () => ({}) }));
vi.mock('../app/(app)/feedback/board', () => ({ feedbackBoardOpen: () => true }));
vi.mock('../app/(app)/feedback/actions', () => ({ submitFeedbackAction: vi.fn(), bulkReviewAction: vi.fn() }));
vi.mock('../core/feedback', () => ({ FEEDBACK_LIST_LIMIT: 200, feedbackBoardCounts: async () => state.counts ?? Object.entries(state.rows.reduce((acc, row) => { const key = feedbackBoardStatus(row); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {} as Record<string, number>)).map(([status, count]) => ({ status, count })), listFeedback: (...args: any[]) => { state.query(...args); return Promise.resolve(state.rows); } }));
import FeedbackPage from '../app/(app)/feedback/page';
import { feedbackBoardStatus } from '../lib/feedback-release';
function fixtures(): FeedbackRow[] {
  return ['staging', 'production_ready', 'production', 'deployed', 'blocked', 'building'].map((st, i) => ({
    id: `00000000-0000-0000-0000-00000000000${i}`, title: ['Improve claim receipt uploads', 'Clarify leave balance', 'Show payroll approval history', 'Historical deployment', 'Awaiting a decision', 'Improve feedback search'][i],
    category: 'enhancement', status: ['blocked', 'building'].includes(st) ? st as 'blocked' | 'building' : 'deployed', reporter: 'Fictional reviewer',
    planRevision: 1, reopenedCount: 0, buildRef: 'fixture-pr', createdAt: new Date('2026-10-29T02:00:00Z'), updatedAt: new Date('2026-10-30T02:00:00Z'),
    release: ['staging', 'production_ready', 'production'].includes(st) ? { stage: st as 'staging' | 'production_ready' | 'production', sourceSha: 'a'.repeat(40), buildId: 'fixture', buildRef: 'fixture-pr', evidence: 'fixture-record', recordedAt: '2026-10-30T02:00:00Z', planRevision: 1, reopenedCount: 0 } : null,
  }));
}
afterEach(() => { cleanup(); state.counts = undefined; });
async function board(params: { view?: string; status?: string; sort?: string } = {}) {
  const element = await FeedbackPage({ searchParams: Promise.resolve(params) });
  return render(<NextIntlClientProvider locale={state.locale} messages={copies[state.locale]}><main className="min-w-0 p-4">{element}</main></NextIntlClientProvider>);
}
describe('feedback Kanban and release labels', () => {
  it.each(Object.keys(copies) as (keyof typeof copies)[])('renders all release lanes and honest legacy labels in %s', async locale => {
    state.locale = locale; state.rows = fixtures();
    await board({ view: 'kanban' });
    const copy = copies[locale].feedback;
    for (const key of ['status_staging', 'status_production_ready', 'status_production', 'releaseUnverified'] as const) {
      expect(screen.getByRole('region', { name: copy.viewKanban })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: new RegExp(copy[key]) })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: new RegExp('Improve claim receipt uploads') })).toHaveAttribute('href', '/feedback/00000000-0000-0000-0000-000000000000');
    expect(screen.queryByRole('button', { name: /deploy/i })).toBeNull();
    await captureAiReviewScreenshots(document.body.innerHTML, locale, 'feedback-board');
  }, 60000);
  it('keeps status and server order in view-switch/filter links, and scopes a selected lane', async () => {
    state.locale = 'en'; state.rows = fixtures().filter(r => feedbackBoardStatus(r) === 'staging');
    await board({ view: 'kanban', status: 'staging', sort: 'updated_asc' });
    expect(state.query).toHaveBeenLastCalledWith({}, { status: 'staging', sort: 'updated_asc' });
    expect(screen.getByRole('link', { name: 'List' })).toHaveAttribute('href', '/feedback?status=staging&sort=updated_asc');
    const region = screen.getByRole('region', { name: 'Kanban' });
    expect(within(region).getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Deployed to staging 1/ })).toHaveAttribute('href', '/feedback?status=staging&sort=updated_asc&view=kanban');
  });
  it('omits empty all-view lanes and provides working sideways controls', async () => {
    state.locale = 'en'; state.rows = fixtures(); await board({ view: 'kanban' });
    expect(screen.queryByRole('heading', { name: /^Open/ })).toBeNull();
    const region = screen.getByRole('region', { name: 'Kanban' });
    const move = vi.fn(); Object.defineProperty(region, 'scrollBy', { value: move });
    screen.getByRole('button', { name: 'Next stages' }).click();
    expect(move).toHaveBeenLastCalledWith({ left: 304, behavior: 'auto' });
    screen.getByRole('button', { name: 'Previous stages' }).click();
    expect(move).toHaveBeenLastCalledWith({ left: -304, behavior: 'auto' });
  });
  it('retains the list, bulk-review controls and the same environment labels', async () => {
    state.locale = 'en'; state.rows = fixtures(); await board({ view: 'unknown' });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: en.feedback.selectAll })).toBeInTheDocument();
    expect(screen.getAllByText('Deployed to production').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Kanban' })).toHaveAttribute('href', '/feedback?view=kanban');
  });
  it('renders empty stage guidance and reports the server cap without inflating lane counts', async () => {
    state.locale = 'en'; state.rows = []; await board({ view: 'kanban', status: 'staging' });
    expect(screen.getByText('No items in this stage')).toBeInTheDocument(); cleanup();
    state.counts = [{ status: 'staging', count: 201 }];
    state.rows = Array.from({ length: 200 }, (_, i) => ({ ...fixtures()[0], id: `fixture-${i}` }));
    await board({ view: 'kanban', status: 'staging' });
    expect(screen.getByText('Showing 200 of 201.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View this stage' })).toHaveAttribute('href', '/feedback?status=staging&view=kanban');
    expect(screen.getByText(en.feedback.listTruncated.replace('{shown, number}', '200').replace('{total, number}', '201'))).toBeInTheDocument();
    await captureAiReviewScreenshots(document.body.innerHTML, 'en', 'feedback-capped');
    cleanup();
    state.counts = [{ status: 'staging', count: 1 }, { status: 'production', count: 200 }];
    state.rows = Array.from({ length: 200 }, (_, i) => ({ ...fixtures()[2], id: `production-fixture-${i}` }));
    await board({ view: 'kanban' });
    expect(screen.getByText('Showing 0 of 1.')).toBeInTheDocument();
    expect(screen.getByText('Items in this stage are outside the loaded results.')).toBeInTheDocument();
    expect(screen.queryByText('No items in this stage')).toBeNull();
    await captureAiReviewScreenshots(document.body.innerHTML, 'en', 'feedback-unloaded');
  }, 60000);
});
