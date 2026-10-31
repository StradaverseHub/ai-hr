/**
 * D-P1-22 (ADR-0150, D5 as amended by APR-022): the review page for the reviewer one level up. When the view says
 * the viewer is the effective reviewer (`reviewer`), the competency review form and the Career Plan review,
 * remark and career-comment forms render with the same actions the stored reviewer uses; the band confirmation
 * and panel management do not (they stay with the stored reviewer, and go to nobody while it is out). The stored
 * reviewer whose unit is out gets no view at all from the service (RLS hides the review: pinned in
 * test/performance-unit-exclusion-leaders.test.ts); with its flags (manager, reviewer and planReviewer all false)
 * the page renders none of these controls.
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
vi.mock('../app/(app)/performance/onehr-actions', () => ({ onehrReviewAction: vi.fn(), careerPlanDraftAction: vi.fn(), applyCareerPlanDraftAction: vi.fn(), developmentSuggestionsAction: vi.fn(), saveAssessmentKpiSettingAction: vi.fn(), saveAssessmentDraftAction: vi.fn(), onehrDraftAction: vi.fn(), assessmentInsightAction: vi.fn(), assessmentIdpFitAction: vi.fn(), assessmentCompetencyInsightAction: vi.fn() }));
vi.mock('../app/(app)/performance/actions', () => ({ uploadAttachmentAction: vi.fn() }));
import { OnehrReviewView } from '../app/(app)/performance/onehr/review-view';

afterEach(cleanup);
type View = Parameters<typeof OnehrReviewView>[0]['v'];
const planYear = Number(todayInKualaLumpur().slice(0, 4)) + 1;
const sharedPlan = { id: 'plan', planYear, revision: 2, status: 'shared', career: { aspiration: 'Lead the regional service desk', mobility: 'stay', mobilityNote: '', targetProfileId: null }, goals: [{ id: crypto.randomUUID(), area: 'Facilitation', dueOn: '', onJob: 'Run the weekly huddle', fromOthers: '', formalLearning: '', status: 'not_started', managerComment: '' }], managerComment: '', conversation: '', conversationHeldOn: null };
const competencies = [
  { id: 'skill-1', principle: 'Technical', text: 'Current skill', future: false, self: 'yes', selfRemark: 'Delivered the agreed work.', manager: null, managerRemark: '' },
  { id: 'skill-2', principle: 'Technical', text: 'Future skill', future: true, self: 'no', selfRemark: 'Still practising.', manager: null, managerRemark: '' },
];
function view(over: Record<string, unknown>): View {
  return { careerRoutes: [], profile: null, profileMatch: null, drafts: [], attachmentLinks: [], kpiLibrary: [], companyId: 'company', anonymousFeedback: null, selfRemark: '', competencySelfRemark: 'My reflection.', competencyManagerRemark: '', calculatedPerformance: 'ME', planReviewer: false, planRemarkWriter: false, reviewId: 'review', name: 'Employee', cycle: { id: 'cycle', name: 'Annual', status: 'open' }, policy: defaultPolicy(framework), grade: '12', revision: 3, self: false, manager: false, reviewer: false, admin: false, moderator: false, mechanism: 'A', viewerUserId: 'viewer', reviewerEmploymentId: 'stored-reviewer', canApproveSettingIds: [], canModerateIds: [], moderators: [], kpis: [], competencies, competencyStatus: 'submitted', competencySelfSections: {}, competencyManagerSections: {}, resultsSubmitted: false, managerPerformance: null, managerScore: null, managerRemark: '', potential: null, finalized: false, result: null, plans: [sharedPlan], planYear, feedbackReport: [], peers: [], choices: [], attachments: [], aiEnabled: false, aiFeatures: { pm: false, tc: false, idp: false, review: false, calib: false, '360': false }, evidence: [], careerProfile: null, planLocked: false, ...over } as unknown as View;
}
const show = async (v: View) => render(<NextIntlClientProvider locale="en" messages={en}>{await OnehrReviewView({ v })}</NextIntlClientProvider>);
const action = (name: string) => document.querySelector(`input[name="action"][value="${name}"]`);
const planRemark = () => document.querySelector<HTMLTextAreaElement>(`textarea[name="comment"][aria-label="${en.onehr.managerComment}"]`);

describe('the review page for the reviewer one level up (D-P1-22)', () => {
  it('renders the competency review as the reviewer\'s own form, submitted as the review step', async () => {
    await show(view({ reviewer: true, planReviewer: true, planRemarkWriter: true }));
    expect(action('competencies')).not.toBeNull();
    expect(document.querySelector('input[name="draftKind"][value="competency_manager"]')).not.toBeNull();
    expect(document.querySelector('input[name="manager"][value="true"]'), 'the action submits the review step, not a self-assessment').not.toBeNull();
    expect(document.querySelector('select[name="answer.skill-1"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: en.onehr.confirmCompetencies })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.onehr.submitCompetencies })).toBeNull();
  });

  it('renders the Career Plan review with a writable overall remark, the close step and the career comment', async () => {
    await show(view({ reviewer: true, planReviewer: true, planRemarkWriter: true }));
    expect(action('plan-review')).not.toBeNull();
    expect(planRemark()).not.toBeNull();
    expect(planRemark()!.readOnly).toBe(false);
    expect(screen.getByRole('button', { name: en.onehr.closePlan })).toBeTruthy();
    expect(screen.getByLabelText(en.onehr.careerConversation)).toBeTruthy();
    expect(action('career-comment')).not.toBeNull();
    expect(action('plan-goal-edit')).not.toBeNull();
  });

  it('gives the reviewer one level up no band confirmation and no panel management', async () => {
    // The service hides PM from an effective-only reviewer (no KPI lines of theirs, no band): the view carries none.
    await show(view({ reviewer: true, planReviewer: true, planRemarkWriter: true, potential: 'Mid' }));
    expect(action('performance')).toBeNull();
    expect(action('panel')).toBeNull();
    expect(screen.queryByRole('heading', { name: en.onehr.feedback360 })).toBeNull();
  });

  it('renders none of these controls with the stored reviewer\'s flags while its unit is out', async () => {
    await show(view({ manager: false, reviewer: false, planReviewer: false, planRemarkWriter: false }));
    // The competency answers stay readable in a read-only draft form; nothing in it is the review step.
    expect(document.querySelector('input[name="manager"][value="true"]')).toBeNull();
    expect(document.querySelector('input[name="draftKind"][value="competency_manager"]')).toBeNull();
    expect(screen.queryByRole('button', { name: en.onehr.confirmCompetencies })).toBeNull();
    expect(document.querySelector('select[name="answer.skill-1"]')).toBeNull();
    expect(action('plan-review')).toBeNull();
    expect(planRemark()).toBeNull();
    expect(action('career-comment')).toBeNull();
    expect(action('plan-goal-edit')).toBeNull();
  });

  it('leaves the stored reviewer who takes part with the same competency form (unchanged)', async () => {
    await show(view({ manager: true, planReviewer: true, planRemarkWriter: true }));
    expect(action('competencies')).not.toBeNull();
    expect(document.querySelector('input[name="manager"][value="true"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: en.onehr.confirmCompetencies })).toBeTruthy();
    expect(action('plan-review')).not.toBeNull();
  });
});
