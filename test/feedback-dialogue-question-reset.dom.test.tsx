/** A new question must not inherit a previous question's successful answer state during RSC refresh. */
import {afterEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {createTranslator, NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';

const state = vi.hoisted(() => ({questionId: '22222222-2222-4222-8222-222222222222', answer: vi.fn(async () => ({sent: true}))}));
vi.mock('next/navigation', () => ({notFound: () => {throw Error('not found');}}));
vi.mock('../lib/session', () => ({getSession: async () => ({userId: 'reporter', roles: ['employee']})}));
vi.mock('../core/entitlements', () => ({settingEnabledOrDefault: () => false}));
vi.mock('../app/feedback/board', () => ({feedbackBoardOpen: () => true}));
vi.mock('next-intl/server', () => ({getTranslations: async (namespace: string) => createTranslator({locale: 'en', messages: en, namespace})}));
vi.mock('../core/feedback', () => ({getFeedback: async () => ({id: '11111111-1111-4111-8111-111111111111', title: 'Fictional preview report', category: 'issue', description: 'A missing entry.', reporterUserId: 'reporter', status: 'open', plan: null,
  planRevision: 0, reopenedCount: 0, release: null, buildRef: null, attachments: [], planHistory: [], blockedBy: null,
  createdAt: new Date('2026-11-17T00:00:00Z'), updatedAt: new Date('2026-11-17T00:00:00Z'),
  blockHistory: [{id: state.questionId, question: 'Which preview screen?', answer: null, resolvedAt: null, askedAt: new Date('2026-11-17T00:00:00Z')}]})}));
vi.mock('../app/feedback/actions', () => ({answerFeedbackClarificationAction: () => state.answer(), askFeedbackClarificationAction: vi.fn(),
  answerBlockingQuestionAction: vi.fn(), approveFeedbackPlanAction: vi.fn(), cancelFeedbackAction: vi.fn(), contestFeedbackPlanAction: vi.fn(), generateFeedbackPlanNowAction: vi.fn(), refuteDeploymentAction: vi.fn(), restoreFeedbackAction: vi.fn()}));
import FeedbackDetailPage from '../app/feedback/[id]/page';

afterEach(cleanup);
it('shows a fresh empty reply form for a different question without a full page reload', async () => {
  const page = () => FeedbackDetailPage({params: Promise.resolve({id: '11111111-1111-4111-8111-111111111111'}), searchParams: Promise.resolve({})});
  const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;
  const view = render(wrap(await page()));
  expect(screen.queryByText(en.feedback.planPending)).toBeNull(); // Waiting must not promise an imminent automatic plan.
  fireEvent.change(screen.getByLabelText(en.feedback.answerLabel), {target: {value: 'November preview.'}});
  fireEvent.submit(screen.getByRole('button', {name: en.feedback.answerSubmit}).closest('form')!);
  expect(await screen.findByRole('status')).toHaveTextContent(en.feedback.dialogueAnswerSent);
  state.questionId = '33333333-3333-4333-8333-333333333333';
  view.rerender(wrap(await page()));
  expect(screen.getByLabelText(en.feedback.answerLabel)).toHaveValue('');
  const form = screen.getByRole('button', {name: en.feedback.answerSubmit}).closest('form')!;
  expect(form.querySelector('input[name="questionId"]')).toHaveValue(state.questionId);
  expect(screen.queryByText(en.feedback.dialogueAnswerSent)).toBeNull();
});
