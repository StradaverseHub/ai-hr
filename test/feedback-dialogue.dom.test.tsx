import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createTranslator, NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import {FeedbackDialogueForm} from '../components/feedback-dialogue-form';
import type {FeedbackDialogueFormState} from '../lib/feedback-dialogue';
import {aiReviewDomHtml, captureAiReviewScreenshots} from './helpers/ai-review-screenshots';

const fixture = vi.hoisted(() => ({session: {userId: 'reporter', roles: ['employee']}, feedback: {} as Record<string, unknown>, ask: vi.fn(), answer: vi.fn()}));
vi.mock('next/navigation', () => ({notFound: () => {throw Error('not found');}}));
vi.mock('../lib/session', () => ({getSession: async () => fixture.session}));
vi.mock('../core/feedback', () => ({getFeedback: async () => fixture.feedback}));
vi.mock('../core/entitlements', () => ({settingEnabledOrDefault: () => true}));
vi.mock('../app/feedback/board', () => ({feedbackBoardOpen: () => true}));
vi.mock('next-intl/server', () => ({getTranslations: async (namespace: string) => createTranslator({locale: 'en', messages: en, namespace})}));
vi.mock('../app/feedback/actions', () => ({askFeedbackClarificationAction: (...args: unknown[]) => fixture.ask(...args), answerFeedbackClarificationAction: (...args: unknown[]) => fixture.answer(...args),
  answerBlockingQuestionAction: vi.fn(), approveFeedbackPlanAction: vi.fn(), cancelFeedbackAction: vi.fn(), contestFeedbackPlanAction: vi.fn(), generateFeedbackPlanNowAction: vi.fn(), refuteDeploymentAction: vi.fn(), restoreFeedbackAction: vi.fn()}));
import FeedbackDetailPage from '../app/feedback/[id]/page';

const id = '11111111-1111-4111-8111-111111111111';
const questionId = '22222222-2222-4222-8222-222222222222';
const question = 'Is overtime missing from approval or the payroll preview? Which month?';
function show(node: React.ReactNode, locale: 'en' | 'ta' = 'en') {return render(<NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ta}>{node}</NextIntlClientProvider>);}
beforeEach(() => {
  vi.clearAllMocks(); fixture.session = {userId: 'reporter', roles: ['employee']};
  fixture.feedback = {id, title: 'Fictional overtime preview', category: 'issue', description: 'An approved entry is missing.',
    reporterUserId: 'reporter', reporterEmploymentId: null, status: 'open', plan: null, planRevision: 0, reopenedCount: 0,
    release: null, buildRef: null, attachments: [], planHistory: [], blockedBy: null,
    createdAt: new Date('2026-11-17T00:00:00Z'), updatedAt: new Date('2026-11-17T00:00:00Z'),
    blockHistory: [{id: questionId, question, answer: null, resolvedAt: null, askedAt: new Date('2026-11-17T00:00:00Z')}]};
  fixture.answer.mockResolvedValue({sent: true}); fixture.ask.mockResolvedValue({sent: true});
});
afterEach(cleanup);

describe('reporter dialogue on the actual feedback detail', () => {
  it('shows a grouped question and exact reply target, without a plan-generation or approval action', async () => {
    const view = show(await FeedbackDetailPage({params: Promise.resolve({id}), searchParams: Promise.resolve({})}));
    expect(screen.getByRole('heading', {name: en.feedback.dialogueWaitingTitle})).toBeVisible();
    expect(screen.getByLabelText(en.feedback.answerLabel)).toHaveAttribute('maxlength', '8000');
    const button = screen.getByRole('button', {name: en.feedback.answerSubmit});
    expect(button.closest('form')?.querySelector('input[name="questionId"]')).toHaveValue(questionId);
    expect(screen.queryByRole('button', {name: en.feedback.generatePlanNow})).toBeNull();
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', 'feedback-dialogue-waiting', 'Actual feedback detail and answer form; fictional report; source-rendered, not an installed session', 'atelier');
  }, 120000);
  it('does not show reply controls to a different reader', async () => {
    fixture.session.userId = 'another-reader';
    show(await FeedbackDetailPage({params: Promise.resolve({id}), searchParams: Promise.resolve({})}));
    expect(screen.queryByRole('button', {name: en.feedback.answerSubmit})).toBeNull();
    expect(screen.getByText(en.feedback.dialogueWaitingHint)).toBeVisible();
  });
  it('keeps a failed answer editable and surfaces the error next to the form', async () => {
    fixture.answer.mockResolvedValue({error: 'The question changed. Refresh the report before answering.'});
    show(<FeedbackDialogueForm mode="answer" feedbackId={id} questionId={questionId} action={fixture.answer} />);
    const input = screen.getByLabelText(en.feedback.answerLabel);
    fireEvent.change(input, {target: {value: 'November payroll preview.'}});
    fireEvent.submit(screen.getByRole('button', {name: en.feedback.answerSubmit}).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The question changed.');
    expect(input).toHaveValue('November payroll preview.'); expect(input).toBeEnabled();
  });
  it('disables repeated submission while saving, then confirms that investigation can resume', async () => {
    let finish!: (state: FeedbackDialogueFormState) => void;
    fixture.answer.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    show(<FeedbackDialogueForm mode="answer" feedbackId={id} questionId={questionId} action={fixture.answer} />);
    fireEvent.change(screen.getByLabelText(en.feedback.answerLabel), {target: {value: 'November preview.'}});
    fireEvent.submit(screen.getByRole('button', {name: en.feedback.answerSubmit}).closest('form')!);
    await waitFor(() => expect(screen.getByRole('button', {name: en.feedback.dialogueSending})).toBeDisabled());
    finish({sent: true});
    expect(await screen.findByRole('status')).toHaveTextContent(en.feedback.dialogueAnswerSent);
    expect(fixture.answer).toHaveBeenCalledTimes(1);
  });
  it('renders a grouped administrator question in Tamil without fixed-width controls', async () => {
    const view = show(<FeedbackDialogueForm mode="ask" feedbackId={id} questionId={questionId} planRevision={0} action={fixture.ask} />, 'ta');
    expect(screen.getByLabelText(ta.feedback.dialogueQuestionLabel)).toHaveAttribute('maxlength', '4000');
    fireEvent.change(screen.getByLabelText(ta.feedback.dialogueQuestionLabel), {target: {value: 'அங்கீகாரத்திலா அல்லது ஊதிய முன்னோட்டத்திலா கூடுதல் நேரம் விடுபட்டுள்ளது? எந்த மாதம்?'}});
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'ta', 'feedback-dialogue-ask', 'Actual grouped-question component; fictional Tamil question; source-rendered', 'atelier');
  }, 120000);
});
