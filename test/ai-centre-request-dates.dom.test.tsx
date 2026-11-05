/** Owner, 5 November 2026 ("Fix dates first"): a leave or attendance card prepared in chat shows the date the HR date owner
 * worked out from the person's words, with its weekday, and offers the other date those words may mean right under it.
 *
 * Rendered by the real ConversationReply for the employee it serves (their own leave application and their own attendance
 * correction), in English and Chinese. The card's title names the day with its weekday; when the signed proposal carries
 * otherDates, a "Use … instead" button under the card only fills the person's message with that date written out in full
 * (Gregorian, with its year), and nothing is posted to any owner; a card without otherDates offers no switch. Server actions
 * are spies; proposals are signed with a fictional secret. Fictional values only; no database. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import { withAiCentre } from './helpers/ai-centre-messages';
import aiMs from '../messages/ai-centre/ms.json';
import aiZh from '../messages/ai-centre/zh.json';
import aiVi from '../messages/ai-centre/vi.json';
import aiTa from '../messages/ai-centre/ta.json';
import aiTh from '../messages/ai-centre/th.json';

const intl = vi.hoisted(() => ({ locale: 'en' }));
const posts = vi.hoisted(() => ({ confirm: vi.fn(), edit: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('../app/assistant/leave-apply-proposal-actions', () => ({ confirmLeaveApplyProposalAction: posts.confirm, editLeaveApplyProposalAction: posts.edit }));
vi.mock('../app/assistant/attendance-request-proposal-actions', () => ({ confirmAttendanceRequestProposalAction: posts.confirm, editAttendanceRequestProposalAction: posts.edit }));
vi.mock('../app/assistant/own-change-proposal-actions', () => ({ confirmOwnChangeProposalAction: posts.confirm, editOwnChangeProposalAction: posts.edit }));
vi.mock('../app/assistant/toil-request-proposal-actions', () => ({ confirmToilRequestProposalAction: posts.confirm, editToilRequestProposalAction: posts.edit }));
vi.mock('../app/assistant/assigned-decision-proposal-actions', () => ({ confirmAssignedDecisionProposalAction: posts.confirm, editAssignedDecisionProposalAction: posts.edit }));
vi.mock('../app/assistant/letter-request-proposal-actions', () => ({ confirmLetterRequestProposalAction: posts.confirm, editLetterRequestProposalAction: posts.edit }));
vi.mock('../app/assistant/learning-actions', () => ({ recordCardSignalAction: vi.fn(async () => ({ recorded: true })), markAnswerAction: vi.fn() }));
const CATALOGUES: Record<string, Record<string, unknown>> = { en: withAiCentre('en', en as Record<string, unknown>), zh: withAiCentre('zh', zh as Record<string, unknown>) };
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: intl.locale, messages: CATALOGUES[intl.locale] as never, namespace }),
  getFormatter: async () => createFormatter({ locale: intl.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
import { issueProposal, type ProposalDraft } from '../core/proposals/proposal';
import { ConversationReply } from '../components/ai-centre/conversation-reply';
import { AssistantChatBoundary } from '../components/assistant/chat-reply-boundary';

const tenantId = randomUUID(), userId = randomUUID(), personId = randomUUID(), employmentId = randomUUID();
function proposal(action: string, entity: string, route: string, selectors: Record<string, string>, facts: ProposalDraft['facts']) {
  const reference = randomUUID(), created = new Date();
  return issueProposal({ what: { action, contractVersion: 1, entity, effect: 'create', selectors, reviewedDigest: 'b'.repeat(64) },
    forWhom: { tenantId, subject: 'own_employment', subjectId: employmentId }, authority: { kind: 'person', tenantId, userId, personId },
    checks: [{ check: 'actor_current', owner: 'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx', ruleVersion: null, result: 'pass' }],
    review: { route, href: route + '?review=' + reference, reference }, facts,
    createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 600_000).toISOString() });
}
/** Friday 6 November 2026, chosen from "next friday" on Wednesday 4 November; Friday 13 November is the other date. */
const leave = (otherDates?: string[]) => proposal('leave.apply', 'leave_request', '/assistant/leave', { date: '2026-11-06', durationType: 'full_day', leaveTypeId: randomUUID() },
  { leaveType: 'Annual Leave', startDate: '2026-11-06', endDate: '2026-11-06', days: 1, outcome: 'submitted_not_approved', ...(otherDates ? { otherDates } : {}) });
/** Monday 2 November 2026, chosen from "last monday" on Wednesday 4 November; Monday 26 October is the other date. */
const correction = () => proposal('attendance.correction.request', 'attendance_request', '/assistant/attendance', { date: '2026-11-02', corrects: 'check_out', checkOut: '18:10' },
  { startDate: '2026-11-02', endDate: '2026-11-02', checkIn: '08:00', checkOut: '18:10', recordedCheckIn: '08:00', outcome: 'submitted_not_approved', otherDates: ['2026-10-26'] });

const setQuestionDraft = vi.fn(), clarify = vi.fn();
async function show(card: ReturnType<typeof proposal>, locale = 'en') {
  intl.locale = locale;
  const turn = { turnId: randomUUID(), reply: '', mode: 'answer', slot: null, suggestion: null, proposals: [card], reads: [], sensitive: false, refused: false, crisis: false,
    fallback: false, continuation: '', trace: null as never, modelTurn: [] };
  const element = await ConversationReply({ turn: turn as never });
  render(<NextIntlClientProvider locale={locale} messages={CATALOGUES[locale] as never} timeZone="Asia/Kuala_Lumpur">
    <AssistantChatBoundary value={{ pending: false, clarify, setQuestionDraft }}>{element}</AssistantChatBoundary></NextIntlClientProvider>);
  return screen.getByRole('article');
}
const conversation = (locale: string) => ((CATALOGUES[locale] as any).aiCentre.conversation) as Record<string, string>;
beforeEach(() => { vi.stubEnv('TERAS_PROPOSAL_SECRET', 'fictional-proposal-signing-secret-0123456789abcdef'); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('the employee\'s own leave card names the chosen day with its weekday and offers the other one',() => {
  it('shows "Annual Leave, Fri, Nov 6 (1 day)" and a switch to Friday 13 November that only fills the message', async () => {
    const card = await show(leave(['2026-11-13']));
    expect(within(card).getByText('Annual Leave, Fri, Nov 6 (1 day)')).toBeTruthy();
    const group = screen.getByLabelText('Another date you may have meant');
    const use = within(group).getByRole('button', { name: 'Use Fri, Nov 13 instead' });
    expect(card.contains(use)).toBe(false);
    fireEvent.click(use);
    expect(setQuestionDraft).toHaveBeenCalledExactlyOnceWith('Make it Friday, November 13, 2026 instead.');
    // Choosing the other date sends nothing to any owner: the person reads and sends the message themselves.
    expect(posts.confirm).not.toHaveBeenCalled(); expect(posts.edit).not.toHaveBeenCalled();
  });
  it('offers no switch when the person\'s words named one day only', async () => {
    const card = await show(leave());
    expect(within(card).getByText('Annual Leave, Fri, Nov 6 (1 day)')).toBeTruthy();
    expect(screen.queryByLabelText('Another date you may have meant')).toBeNull();
    expect(screen.queryByRole('button', { name: /instead$/ })).toBeNull();
  });
  it('names the weekday and writes the other date out in Chinese', async () => {
    const card = await show(leave(['2026-11-13']), 'zh');
    const day = (iso: string) => new Intl.DateTimeFormat('zh', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00.000Z'));
    expect(day('2026-11-06')).toMatch(/周五/);
    expect(card.textContent).toContain(day('2026-11-06'));
    const words = conversation('zh');
    fireEvent.click(within(screen.getByLabelText(words.otherDatesLabel)).getByRole('button', { name: words.otherDate.replace('{date}', day('2026-11-13')) }));
    const long = new Intl.DateTimeFormat('zh', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date('2026-11-13T00:00:00.000Z'));
    expect(long).toContain('2026');
    expect(setQuestionDraft).toHaveBeenCalledExactlyOnceWith(words.otherDatePrompt.replace('{date}', long));
  });
});

describe('the employee\'s own attendance correction card',() => {
  it('shows "Clock-out correction, Mon, Nov 2, 6:10 PM" and a switch to Monday 26 October', async () => {
    const card = await show(correction());
    const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date('1970-01-01T18:10:00.000Z'));
    expect(within(card).getByText(`Clock-out correction, Mon, Nov 2, ${time}`)).toBeTruthy();
    fireEvent.click(within(screen.getByLabelText('Another date you may have meant')).getByRole('button', { name: 'Use Mon, Oct 26 instead' }));
    expect(setQuestionDraft).toHaveBeenCalledExactlyOnceWith('Make it Monday, October 26, 2026 instead.');
    expect(posts.confirm).not.toHaveBeenCalled();
  });
  it('defines the switch\'s three strings in all six AI Centre catalogues, each its own translation', () => {
    const english = conversation('en');
    for (const [locale, messages] of Object.entries({ ms: aiMs, zh: aiZh, vi: aiVi, ta: aiTa, th: aiTh })) {
      const catalogue = (messages as any).aiCentre.conversation as Record<string, string>;
      for (const key of ['otherDatesLabel', 'otherDate', 'otherDatePrompt']) {
        expect(typeof catalogue[key], locale + ' ' + key).toBe('string'); expect(catalogue[key], locale + ' ' + key).not.toBe(english[key]);
        if (key !== 'otherDatesLabel') expect(catalogue[key], locale + ' ' + key).toContain('{date}');
      }
    }
  });
});
