/**
 * The review page (/performance/review/<id>) renders the person's OWN career plan read-only while the
 * workspace lock holds (getOnehrReview.planLocked = workspace-model ownPlanLocked): a locked notice, no plan
 * form, no Share and no progress form. An unlocked plan and the manager's review side are unchanged.
 */
vi.mock('../app/(app)/performance/assessment-rewrite-actions', () => ({ rewriteAssessmentFieldAction: vi.fn() }));
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { todayInKualaLumpur } from '../lib/hr-date';
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as never }) }));
vi.mock('next/navigation', async importActual => ({ ...await importActual<typeof import('next/navigation')>(), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../app/(app)/performance/onehr-actions', () => ({ onehrReviewAction: vi.fn(), careerPlanDraftAction: vi.fn(), applyCareerPlanDraftAction: vi.fn(), developmentSuggestionsAction: vi.fn(), saveAssessmentKpiSettingAction: vi.fn(), saveAssessmentDraftAction: vi.fn(), onehrDraftAction: vi.fn(), assessmentInsightAction: vi.fn() }));
vi.mock('../app/(app)/performance/actions', () => ({ uploadAttachmentAction: vi.fn() }));
import { OnehrReviewView } from '../app/(app)/performance/onehr/review-view';

afterEach(cleanup);
type View = Parameters<typeof OnehrReviewView>[0]['v'];
const planYear = Number(todayInKualaLumpur().slice(0, 4)) + 1;
const savedDraft = { id: 'plan', planYear, revision: 1, status: 'draft', career: { aspiration: 'Lead the regional service desk', mobility: 'stay', mobilityNote: '', targetProfileId: null }, goals: [{ id: crypto.randomUUID(), area: 'Facilitation', dueOn: '', onJob: 'Run the weekly huddle', fromOthers: '', formalLearning: '', status: 'not_started', managerComment: '' }], managerComment: '', conversation: '', conversationHeldOn: null };
const sharedPlan = { ...savedDraft, status: 'shared' };
function view(over: Record<string, unknown>): View {
  return { careerRoutes: [], profile: null, profileMatch: null, drafts: [], attachmentLinks: [], kpiLibrary: [], companyId: 'company', anonymousFeedback: null, selfRemark: '', competencySelfRemark: '', competencyManagerRemark: '', calculatedPerformance: null, planReviewer: false, planRemarkWriter: false, reviewId: 'review', name: 'Employee', cycle: { id: 'cycle', name: 'Annual', status: 'open' }, policy: defaultPolicy(framework), grade: '12', revision: 1, self: true, manager: false, admin: false, moderator: false, mechanism: 'A', viewerUserId: 'viewer', reviewerEmploymentId: 'manager', canApproveSettingIds: [], canModerateIds: [], moderators: [], kpis: [], competencies: [], competencyStatus: 'pending', competencySelfSections: {}, competencyManagerSections: {}, resultsSubmitted: false, managerPerformance: null, managerScore: null, managerRemark: '', potential: null, finalized: false, result: null, plans: [], planYear, feedbackReport: [], peers: [], choices: [], attachments: [], aiEnabled: false, aiFeatures: { pm: false, tc: false, idp: false, review: false, calib: false, '360': false }, evidence: [], careerProfile: null, planLocked: false, ...over } as unknown as View;
}
const show = async (v: View) => render(<NextIntlClientProvider locale="en" messages={en}>{await OnehrReviewView({ v })}</NextIntlClientProvider>);
const notice = () => screen.queryAllByRole('status').find(node => node.textContent === en.onehr.workspace.planLocked) ?? null;

describe('own career plan on the review page', () => {
  it('shows the locked notice, no plan form and no Share while the own plan is locked', async () => {
    await show(view({ planLocked: true, plans: [savedDraft] }));
    expect(notice()).not.toBeNull();
    expect(notice()!.querySelector('svg')).not.toBeNull();
    expect(document.getElementById('career-aspiration')).toBeNull();
    expect(screen.queryByRole('button', { name: en.onehr.sharePlan })).toBeNull();
    expect(document.querySelector('input[name="action"][value="plan"]')).toBeNull();
    expect(document.querySelector('input[name="action"][value="goal-progress"]')).toBeNull();
    // What was already saved stays readable, as a shared plan reads today.
    expect(screen.getByText(/Lead the regional service desk/).tagName).toBe('P');
  });
  it('shows only the notice when a locked person has saved nothing', async () => {
    await show(view({ planLocked: true }));
    expect(notice()).not.toBeNull();
    expect(document.getElementById('career-aspiration')).toBeNull();
    expect(screen.queryByRole('button', { name: en.onehr.sharePlan })).toBeNull();
  });
  it('keeps the editable plan and Share for an unlocked person', async () => {
    await show(view({ planLocked: false, plans: [savedDraft] }));
    expect(notice()).toBeNull();
    expect(document.getElementById('career-aspiration')).not.toBeNull();
    expect(screen.getByRole('button', { name: en.onehr.sharePlan })).toBeTruthy();
  });
  it('keeps goal progress for an unlocked shared plan', async () => {
    await show(view({ planLocked: false, plans: [sharedPlan] }));
    expect(document.querySelector('input[name="action"][value="goal-progress"]')).not.toBeNull();
  });
  it('leaves the manager review actions on a shared plan untouched', async () => {
    await show(view({ self: false, manager: true, planReviewer: true, planRemarkWriter: true, plans: [sharedPlan] }));
    expect(notice()).toBeNull();
    expect(screen.getByLabelText(en.onehr.careerConversation)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.onehr.closePlan })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.onehr.sharePlan })).toBeNull();
  });
});
