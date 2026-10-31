/**
 * D-P1-32 PT-X2: the REAL workspace screen under a tab route versus the old workspace URL.
 *
 * Scoped to My Assessments, the rail holds only that tab's items, every link and the cycle switch stay on the
 * tab's route, and the requested item is the one opened. The old `/performance/workspace?…` URL for the same
 * item still lands on it, with the old link shape. Services are mocked at the facade; the screen's own
 * selection code (resolveWorkspaceSelection and the rail) is real.
 *
 * Non-vacuity: dropping workspaceTabItems from the screen puts "My review" and "Chong" in the scoped rail;
 * dropping basePath from href() sends the scoped links to /performance/workspace.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';

const mock = vi.hoisted(() => ({ feedback: vi.fn(async (..._args: unknown[]) => null), review: vi.fn(async (..._args: unknown[]) => null) }));
const ITEMS = vi.hoisted(() => {
  const base = { cycleId: 'c1', cycle: 'Annual 2026', periodEnd: '2026-12-31', locked: false };
  return [
    { ...base, key: 'f1', id: 'f1', kind: 'feedback', view: 'mine', module: 'tm', stage: 'feedback', state: 'open', title: 'Aisyah' },
    { ...base, key: 'f2', id: 'f2', kind: 'feedback', view: 'mine', module: 'tm', stage: 'feedback', state: 'done', title: 'Badrul' },
    { ...base, key: 'r1.pm', id: 'r1', kind: 'review', view: 'mine', module: 'pm', stage: 'results', state: 'open', title: 'My review' },
    { ...base, key: 'r2.pm', id: 'r2', kind: 'review', view: 'team', module: 'pm', stage: 'setting', state: 'open', title: 'Chong' },
  ];
});
vi.mock('next/navigation', () => ({ notFound: () => { throw Error('NOT_FOUND'); }, usePathname: () => '/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next-intl/server', async () => { const { createTranslator } = await import('next-intl'); return { getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages, namespace: namespace as never }) }; });
vi.mock('../packs/performance/service', () => ({
  performanceWorkspace: async () => ITEMS, hasDepartmentView: async () => false,
  getOnehrFeedback: mock.feedback, getOnehrReview: mock.review, getOnehrCalibration: vi.fn(async () => null), getAssessmentPersonalRecord: vi.fn(async () => null),
  getReviewConversation: vi.fn(async () => null), getFeedbackConversation: vi.fn(async () => null), getCalibrationConversation: vi.fn(async () => null),
}));
vi.mock('../app/(app)/performance/workspace/performance-guide', () => ({ PerformanceGuide: () => null }));
vi.mock('../app/(app)/performance/workspace/review-conversation', () => ({ ReviewConversation: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock('../app/(app)/performance/workspace/personal-record', () => ({ PersonalRecord: () => null }));
vi.mock('../app/(app)/performance/workspace/record-drawer', () => ({ RecordDrawer: () => null }));
vi.mock('../app/(app)/performance/onehr/review-view', () => ({ OnehrReviewView: () => null }));
vi.mock('../app/(app)/performance/onehr/feedback-view', () => ({ FeedbackView: () => null }));
vi.mock('../app/(app)/performance/onehr/calibration-view', () => ({ AssessmentCalibrationView: () => null }));

import { PerformanceWorkspaceScreen } from '../app/(app)/performance/workspace/workspace-screen';
import { WORKSPACE_TAB_SCOPES } from '../packs/performance/onehr/tab-route-model';

// jsdom has no matchMedia; the workspace rail (workspace-rail.tsx) listens for the desktop breakpoint.
beforeEach(() => { vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const s = { tenantId: 'tenant', userId: 'viewer', personId: 'person' } as never;
async function draw(node: Promise<React.ReactNode>) {
  return render(<NextIntlClientProvider locale="en" messages={messages}>{await node}</NextIntlClientProvider>);
}
/** The rail link for an item (found in the DOM: a closed "Done" group still holds its links). */
const railLink = (title: string) => { const found = [...document.querySelectorAll('a')].filter(link => link.textContent?.includes(title)); expect(found).toHaveLength(1); return found[0]; };
const href = (title: string) => railLink(title).getAttribute('href');

describe('My Assessments tab route over the real workspace', () => {
  it('holds only the 360 requests, keeps every link and the cycle switch on the route, and opens the requested one', async () => {
    const { container } = await draw(PerformanceWorkspaceScreen({ s, query: { feedback: 'f2' }, scope: WORKSPACE_TAB_SCOPES['feedback.assessments'] }));
    expect(href('Aisyah')).toBe('/performance/assessments?cycle=c1&feedback=f1');
    expect(href('Badrul')).toBe('/performance/assessments?cycle=c1&feedback=f2');
    expect(railLink('Badrul').getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText('My review')).toBeNull();
    expect(screen.queryByText('Chong')).toBeNull();
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/performance/assessments');
    expect(mock.feedback).toHaveBeenCalledWith(s, 'f2');
    expect(mock.review).not.toHaveBeenCalled();
    expect([...document.querySelectorAll('a')].map(link => link.getAttribute('href') ?? '').filter(link => link.startsWith('/performance/workspace'))).toEqual([]);
  });
  it('ignores a crafted view or module and stays inside the tab', async () => {
    await draw(PerformanceWorkspaceScreen({ s, query: { view: 'team', module: 'pm', review: 'r2' }, scope: WORKSPACE_TAB_SCOPES['feedback.assessments'] }));
    expect(screen.queryByText('Chong')).toBeNull();
    expect(mock.review).not.toHaveBeenCalled();
    expect(mock.feedback).toHaveBeenCalledWith(s, 'f1');
  });
});

describe('the old workspace URL for the same item (D8)', () => {
  it('lands on the same request with the old link shape', async () => {
    await draw(PerformanceWorkspaceScreen({ s, query: { cycle: 'c1', view: 'mine', module: 'tm', stage: 'feedback', feedback: 'f2' } }));
    expect(href('Badrul')).toBe('/performance/workspace?cycle=c1&view=mine&module=tm&stage=feedback&feedback=f2');
    expect(railLink('Badrul').getAttribute('aria-current')).toBe('page');
    expect(mock.feedback).toHaveBeenCalledWith(s, 'f2');
  });
});
