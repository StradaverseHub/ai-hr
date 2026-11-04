/** AI v2 W2 slice 2 — the Leave Credit request (time off in lieu) card prepared in chat, rendered by the real
 * ConversationReply for the employee it serves (owner decision, 3 November 2026: "Employee ticks consent on card").
 *
 * For a First Schedule employee (the leave service decided it; the signed card says the agreement is asked for), the card
 * shows the Leave Credit form's own agreement sentence word for word with an UNTICKED box, and Confirm stays disabled
 * until the person ticks it themselves; the tick is what is posted, and a server refusal for a missing agreement is shown
 * in place. A card for anyone else shows no box and posts no agreement. The server actions are spies (the owner's DB
 * tests cover what the server checks: test/proposal-toil-request-chat.test.ts); proposals are signed with a fictional
 * secret. Fictional values only; no database. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import { withAiCentre } from './helpers/ai-centre-messages';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const state = vi.hoisted(() => ({ locale: 'en', messages: {} as Record<string, unknown> }));
const posts = vi.hoisted(() => ({ toil: { confirm: vi.fn(), edit: vi.fn() }, other: { confirm: vi.fn(), edit: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: nav.push }) }));
vi.mock('../app/assistant/leave-apply-proposal-actions', () => ({ confirmLeaveApplyProposalAction: posts.other.confirm, editLeaveApplyProposalAction: posts.other.edit }));
vi.mock('../app/assistant/attendance-request-proposal-actions', () => ({ confirmAttendanceRequestProposalAction: posts.other.confirm, editAttendanceRequestProposalAction: posts.other.edit }));
vi.mock('../app/assistant/own-change-proposal-actions', () => ({ confirmOwnChangeProposalAction: posts.other.confirm, editOwnChangeProposalAction: posts.other.edit }));
vi.mock('../app/assistant/toil-request-proposal-actions', () => ({ confirmToilRequestProposalAction: posts.toil.confirm, editToilRequestProposalAction: posts.toil.edit }));
vi.mock('../app/assistant/assigned-decision-proposal-actions', () => ({ confirmAssignedDecisionProposalAction: posts.other.confirm, editAssignedDecisionProposalAction: posts.other.edit }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: state.messages as never, namespace }),
  getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
import { issueProposal } from '../core/proposals/proposal';
import { ConversationReply } from '../components/ai-centre/conversation-reply';

const MESSAGES = { en: withAiCentre('en', en as Record<string, unknown>), ms: withAiCentre('ms', ms as Record<string, unknown>) } as const;
const inline = (locale: keyof typeof MESSAGES) => (MESSAGES[locale] as any).aiCentre.conversation.inline as Record<string, any>;
/** The Leave Credit request form's own sentence (messages/<locale>.json replacementRequest.firstScheduleConsent). */
const AGREEMENT = { en: (en as any).replacementRequest.firstScheduleConsent as string, ms: (ms as any).replacementRequest.firstScheduleConsent as string };

const tenantId = randomUUID(), userId = randomUUID(), personId = randomUUID(), employmentId = randomUUID();
function toilCard(firstSchedule: boolean) {
  const reference = randomUUID(), created = new Date();
  return issueProposal({ what: { action: 'toil.replacement.request', contractVersion: 1, entity: 'leave_credit_request', effect: 'create',
    selectors: { workedDate: '2026-11-01', dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00', ...(firstSchedule ? { firstScheduleAgreement: 'required' } : {}) },
    reviewedDigest: 'b'.repeat(64) },
    forWhom: { tenantId, subject: 'own_employment', subjectId: employmentId },
    authority: { kind: 'person', tenantId, userId, personId },
    checks: [{ check: 'leave_credit_rules', owner: 'packs/leave/service.ts#prepareReviewedReplacementLeaveRequestTx', ruleVersion: null, result: 'pass' }],
    review: { route: '/assistant/toil', href: '/assistant/toil?review=' + reference, reference },
    facts: { startDate: '2026-11-01', endDate: '2026-11-01', plannedStart: '09:00', plannedEnd: '17:00', creditDays: 1, outcome: 'submitted_not_approved' },
    createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 600_000).toISOString() });
}
const turn = (proposals: ReturnType<typeof toilCard>[]) => ({ turnId: randomUUID(), reply: '', mode: 'answer', slot: null, suggestion: null, proposals, reads: [],
  sensitive: false, refused: false, crisis: false, fallback: false, continuation: '', trace: null as never, modelTurn: [] });
async function show(card: ReturnType<typeof toilCard>, locale: keyof typeof MESSAGES = 'en') {
  state.locale = locale; state.messages = MESSAGES[locale] as Record<string, unknown>;
  const element = await ConversationReply({ turn: turn([card]) as never });
  render(<NextIntlClientProvider locale={locale} messages={MESSAGES[locale] as never} timeZone="Asia/Kuala_Lumpur">{element}</NextIntlClientProvider>);
  return screen.getByRole('article');
}
const button = (card: HTMLElement, label: string) => within(card).getByRole('button', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
const allPosts = () => [posts.toil.confirm, posts.toil.edit, posts.other.confirm, posts.other.edit];

beforeEach(() => { vi.stubEnv('TERAS_PROPOSAL_SECRET', 'fictional-toil-agreement-secret-0123456789abcdef'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('a First Schedule employee\'s Leave Credit card in chat', () => {
  it('names the date worked, the window and the leave service\'s credit, and shows the form\'s agreement sentence with an unticked box', async () => {
    const card = await show(toilCard(true));
    // Independent expected values: the date and the times formatted by Intl itself, the template from the catalogue.
    const date = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date('2026-11-01T00:00:00Z'));
    const time = (hhmm: string) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date('1970-01-01T' + hhmm + ':00Z'));
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(`Leave Credit request, ${date}, ${time('09:00')} – ${time('17:00')}`);
    expect(card).toHaveTextContent('1 day credited if approved');
    const box = within(card).getByRole('checkbox', { name: AGREEMENT.en });
    expect(AGREEMENT.en.length).toBeGreaterThan(80);
    expect(box).not.toBeChecked();
    expect(box.closest('label')).toHaveTextContent(AGREEMENT.en);
    expect(button(card, inline('en').confirm)).toBeDisabled();
    expect(button(card, inline('en').edit)).toBeEnabled();
    expect(button(card, inline('en').discard)).toBeEnabled();
    for (const post of allPosts()) expect(post).not.toHaveBeenCalled();
  });

  it('keeps Confirm disabled until the person ticks the box, and posts the tick with the card', async () => {
    const user = userEvent.setup();
    const signed = toilCard(true);
    const card = await show(signed);
    const confirm = button(card, inline('en').confirm);
    fireEvent.click(confirm);
    expect(posts.toil.confirm).not.toHaveBeenCalled();
    const box = within(card).getByRole('checkbox', { name: AGREEMENT.en });
    await user.click(box);
    expect(box).toBeChecked();
    expect(confirm).toBeEnabled();
    // Unticking takes Confirm away again.
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(confirm).toBeDisabled();
    await user.click(box);
    posts.toil.confirm.mockResolvedValueOnce({ kind: 'submitted', action: 'toil.replacement.request', requestId: randomUUID() });
    await act(async () => { fireEvent.click(confirm); });
    expect(posts.toil.confirm).toHaveBeenCalledTimes(1);
    expect(posts.toil.confirm).toHaveBeenCalledWith({ proposal: signed, confirm: true, firstScheduleConsent: true });
    expect(within(card).getByRole('status')).toHaveTextContent(`${inline('en').confirmedBy} · ${inline('en').done.toilSubmitted}`);
    for (const post of [posts.toil.edit, posts.other.confirm, posts.other.edit]) expect(post).not.toHaveBeenCalled();
  });

  it('shows the server\'s refusal for a missing agreement in place, and the box can still be ticked', async () => {
    const user = userEvent.setup();
    const card = await show(toilCard(true));
    await user.click(within(card).getByRole('checkbox', { name: AGREEMENT.en }));
    posts.toil.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'consent_required' });
    await act(async () => { fireEvent.click(button(card, inline('en').confirm)); });
    expect(within(card).getByRole('alert')).toHaveTextContent(inline('en').refused.consent);
    expect(within(card).queryByRole('status')).toBeNull();
    expect(within(card).getByRole('checkbox', { name: AGREEMENT.en })).toBeEnabled();
  });

  it('Edit opens the Leave Credit form and posts no agreement', async () => {
    const signed = toilCard(true);
    const card = await show(signed);
    posts.toil.edit.mockResolvedValueOnce({ ok: true, href: '/leave?credit=1&creditDate=2026-11-01&creditStart=09%3A00&creditEnd=17%3A00' });
    await act(async () => { fireEvent.click(button(card, inline('en').edit)); });
    expect(posts.toil.edit).toHaveBeenCalledWith({ proposal: signed });
    expect(nav.push).toHaveBeenCalledWith('/leave?credit=1&creditDate=2026-11-01&creditStart=09%3A00&creditEnd=17%3A00');
    expect(posts.toil.confirm).not.toHaveBeenCalled();
  });

  it('shows the Malay form\'s own sentence to a Malay reader, unticked', async () => {
    const card = await show(toilCard(true), 'ms');
    expect(AGREEMENT.ms).not.toBe(AGREEMENT.en);
    const box = within(card).getByRole('checkbox', { name: AGREEMENT.ms });
    expect(box).not.toBeChecked();
    expect(button(card, inline('ms').confirm)).toBeDisabled();
  });
});

describe('a Leave Credit card for an employee outside the First Schedule', () => {
  it('shows no agreement box, confirms at once and posts no agreement', async () => {
    const signed = toilCard(false);
    const card = await show(signed);
    expect(within(card).queryByRole('checkbox')).toBeNull();
    expect(card.querySelector('[data-inline-agreement]')).toBeNull();
    const confirm = button(card, inline('en').confirm);
    expect(confirm).toBeEnabled();
    posts.toil.confirm.mockResolvedValueOnce({ kind: 'submitted', action: 'toil.replacement.request', requestId: randomUUID() });
    await act(async () => { fireEvent.click(confirm); });
    expect(posts.toil.confirm).toHaveBeenCalledWith({ proposal: signed, confirm: true });
    expect(within(card).getByRole('status')).toHaveTextContent(inline('en').done.toilSubmitted);
  });
});
