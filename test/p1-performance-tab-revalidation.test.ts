/**
 * D-P1-32 PT-X2: a save made on a Performance & Talent tab route refreshes that tab, not only the workspace.
 *
 * Form actions return to the validated `returnTo` (assessmentReturnPath) and revalidate its path; actions a
 * client widget calls without a return path refresh every route that renders the workspace
 * (revalidateAssessmentWorkspace). Pattern: test/letter-field-actions.test.ts (session, service, next/cache
 * and redirect mocked; the action itself is real).
 *
 * Non-vacuity: removing `revalidatePath(url.split('?')[0])` from onehrReviewAction, the returnTo line from
 * uploadAttachmentAction, or the tab loop from revalidateAssessmentWorkspace turns a case red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), revalidate: vi.fn(), evidence: vi.fn(), keep: vi.fn(), attach: vi.fn(), lock: vi.fn() }));
vi.mock('../lib/session', () => ({ getSession: mocks.session }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('../packs/performance/service', () => ({ changeOnehrEvidenceState: mocks.evidence, keepCompetencyReflection: mocks.keep, lockOnehrCalibration: mocks.lock }));
vi.mock('../core/performance', () => ({ addPerformanceAttachment: mocks.attach, ALL_STAGE_KINDS: [] }));

import { keepCompetencyReflectionAction, onehrCalibrationAction, onehrReviewAction } from '../app/(app)/performance/onehr-actions';
import { uploadAttachmentAction } from '../app/(app)/performance/actions';
import { WORKSPACE_TAB_PATHS } from '../packs/performance/onehr/tab-route-model';

const reviewId = '0f9b4c1e-2d3a-4b5c-8d7e-6f5a4b3c2d1e';
const ctx = { tenantId: 'tenant', userId: 'viewer' };
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(ctx); mocks.evidence.mockResolvedValue(undefined); mocks.keep.mockResolvedValue({ ok: true }); mocks.attach.mockResolvedValue(undefined); mocks.lock.mockResolvedValue(undefined); });

function evidenceForm(returnTo: string) {
  const f = new FormData();
  for (const [key, value] of Object.entries({ reviewId, revision: '3', action: 'evidence-state', evidenceId: 'e-1', state: 'shared', returnTo })) f.set(key, value);
  return f;
}
const revalidated = () => mocks.revalidate.mock.calls.map(call => call.join(' '));

describe('a form save returns to, and refreshes, the tab it came from', () => {
  it.each(WORKSPACE_TAB_PATHS)('%s', async route => {
    await expect(onehrReviewAction(evidenceForm(`${route}?cycle=c1&review=${reviewId}`))).rejects.toThrow(`REDIRECT:${route}?cycle=c1&review=${reviewId}`);
    expect(mocks.evidence).toHaveBeenCalledWith(ctx, 'e-1', 'shared');
    expect(revalidated()).toContain(route);
    expect(revalidated()).toContain('/performance/workspace');
  });
  it('Team PM per-review route', async () => {
    await expect(onehrReviewAction(evidenceForm(`/performance/team/${reviewId}?`))).rejects.toThrow(`REDIRECT:/performance/team/${reviewId}?`);
    expect(revalidated()).toContain(`/performance/team/${reviewId}`);
  });
  it('an unaccepted returnTo falls back to the review page and refreshes no foreign path', async () => {
    await expect(onehrReviewAction(evidenceForm('/performance/calibration?axis=performance'))).rejects.toThrow(`REDIRECT:/performance/review/${reviewId}`);
    expect(revalidated()).toContain(`/performance/review/${reviewId}`);
    expect(revalidated()).not.toContain('/performance/calibration');
  });
  it('a lock on the standalone Talent Box returns to, and refreshes, the same session\'s board', async () => {
    const sessionId = '5d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
    const f = new FormData();
    for (const [key, value] of Object.entries({ sessionId, revision: '2', action: 'lock', reason: '', returnTo: `/performance/calibration/talent-box?session=${sessionId}&review=x&unsafe=y` })) f.set(key, value);
    await expect(onehrCalibrationAction(f)).rejects.toThrow(`REDIRECT:/performance/calibration/talent-box?session=${sessionId}`);
    expect(mocks.lock).toHaveBeenCalledWith(ctx, sessionId, 2, '', 'both', undefined, undefined);
    expect(revalidated()).toContain('/performance/calibration/talent-box');
  });
  it('an attachment upload refreshes the tab it returns to', async () => {
    const f = new FormData();
    f.set('reviewId', reviewId); f.set('returnTo', `/performance/team/${reviewId}?`); f.set('file', new File(['x'], 'evidence.pdf', { type: 'application/pdf' }));
    await expect(uploadAttachmentAction(f)).rejects.toThrow(`REDIRECT:/performance/team/${reviewId}?`);
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    expect(revalidated()).toContain(`/performance/team/${reviewId}`);
  });
});

describe('a client-called save with no return path refreshes every workspace route', () => {
  it('keepCompetencyReflectionAction', async () => {
    expect(await keepCompetencyReflectionAction(reviewId, 'm-1')).toEqual({ ok: true });
    expect(revalidated().sort()).toEqual(['/performance/workspace', ...WORKSPACE_TAB_PATHS, '/performance/team/[reviewId] page', '/performance/calibration/talent-box'].sort());
  });
});
