/** AI v2 Phase 1 — Confirm, Edit and Discard on the cards prepared in chat (approved mock-ups Ask.dc.html and
 * TodayEmployee.dc.html), rendered by the real ConversationReply for the employee they serve.
 *
 * For every prepared kind (leave application, attendance correction, overtime request, claim, claim cancellation,
 * profile change, Leave Credit request, letter request): nothing posts until a press; Confirm posts the very card it shows with `confirm: true` to its own
 * owner's server action and shows the owner's outcome with the person's Maker's Mark; a refusal is shown in place
 * (the owner's own sentence when it gave one); Edit and a "use the form" answer open the owner's prefilled form;
 * Discard only hides the card. The buttons are native, keyboard-reachable and disabled while one is pending. An
 * approver's decision card keeps its one review link. The server actions are replaced by spies (each owner's own
 * tests cover what they check); proposals are signed with a fictional secret. Fictional values only; no database. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { withAiCentre } from './helpers/ai-centre-messages';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const posts = vi.hoisted(() => ({
  leave: { confirm: vi.fn(), edit: vi.fn() }, attendance: { confirm: vi.fn(), edit: vi.fn() }, own_change: { confirm: vi.fn(), edit: vi.fn() },
  toil: { confirm: vi.fn(), edit: vi.fn() }, decision: { confirm: vi.fn(), edit: vi.fn() }, letter_request: { confirm: vi.fn(), edit: vi.fn() },
}));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: nav.push }) }));
vi.mock('../app/assistant/leave-apply-proposal-actions', () => ({ confirmLeaveApplyProposalAction: posts.leave.confirm, editLeaveApplyProposalAction: posts.leave.edit }));
vi.mock('../app/assistant/attendance-request-proposal-actions', () => ({ confirmAttendanceRequestProposalAction: posts.attendance.confirm, editAttendanceRequestProposalAction: posts.attendance.edit }));
vi.mock('../app/assistant/own-change-proposal-actions', () => ({ confirmOwnChangeProposalAction: posts.own_change.confirm, editOwnChangeProposalAction: posts.own_change.edit }));
vi.mock('../app/assistant/toil-request-proposal-actions', () => ({ confirmToilRequestProposalAction: posts.toil.confirm, editToilRequestProposalAction: posts.toil.edit }));
// AI v2 W2 slice 3: the assigned claim and attendance decision cards (test/ai-centre-assigned-decision-card.dom.test.tsx).
vi.mock('../app/assistant/assigned-decision-proposal-actions', () => ({ confirmAssignedDecisionProposalAction: posts.decision.confirm, editAssignedDecisionProposalAction: posts.decision.edit }));
vi.mock('../app/assistant/letter-request-proposal-actions', () => ({ confirmLetterRequestProposalAction: posts.letter_request.confirm, editLetterRequestProposalAction: posts.letter_request.edit }));
const messages = withAiCentre('en', en as Record<string, unknown>);
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: messages as never, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' }),
}));
import { issueProposal, type ProposalDraft } from '../core/proposals/proposal';
import { ConversationReply } from '../components/ai-centre/conversation-reply';

// The English copy, read from the catalogue itself so a changed sentence fails here only if the card stops showing it.
const copy = (messages as any).aiCentre.conversation.inline as Record<string, any>;
const awaiting = (messages as any).aiCentre.card.awaiting as string;

const tenantId = randomUUID(), userId = randomUUID(), personId = randomUUID(), employmentId = randomUUID();
function proposal(action: string, entity: string, effect: 'create' | 'withdraw' | 'decide', route: string, facts: ProposalDraft['facts'], query = '?review=') {
  const reference = randomUUID(), created = new Date();
  return issueProposal({ what: { action, contractVersion: 1, entity, effect, selectors: {}, reviewedDigest: 'b'.repeat(64) },
    forWhom: { tenantId, subject: effect === 'decide' ? 'assigned_request' : 'own_employment', subjectId: employmentId },
    authority: { kind: 'person', tenantId, userId, personId },
    checks: [{ check: 'actor_current', owner: 'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx', ruleVersion: null, result: 'pass' }],
    review: { route, href: route + query + reference, reference }, facts,
    createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 600_000).toISOString() });
}
const turn = (proposals: ReturnType<typeof proposal>[]) => ({ turnId: randomUUID(), reply: '', mode: 'answer', slot: null, suggestion: null, proposals, reads: [],
  sensitive: false, refused: false, crisis: false, fallback: false, continuation: '', trace: null as never, modelTurn: [] });
async function show(card: ReturnType<typeof proposal>) {
  const element = await ConversationReply({ turn: turn([card]) as never });
  render(<NextIntlClientProvider locale="en" messages={messages as never} timeZone="Asia/Kuala_Lumpur">{element}</NextIntlClientProvider>);
  return screen.getByRole('article');
}
const buttons = (card: HTMLElement) => [...card.querySelectorAll<HTMLButtonElement>('button')];
const button = (card: HTMLElement, label: string) => within(card).getByRole('button', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const allPosts = () => Object.values(posts).flatMap(owner => [owner.confirm, owner.edit]);

type Kind = keyof typeof posts;
const CASES: readonly { name: string; kind: Kind; make: () => ReturnType<typeof proposal>; success: unknown; done: string; doneLink?: string; refusal: unknown; refusalText: string; refusalLink?: string; editHref: string }[] = [
  { name: 'leave application', kind: 'leave', make: () => proposal('leave.apply', 'leave_request', 'create', '/assistant/leave', { leaveType: 'Fictional Annual Leave', startDate: '2026-11-05', endDate: '2026-11-05', days: 1, outcome: 'submitted_not_approved' }),
    success: { kind: 'submitted', leaveRequestId: randomUUID() }, done: copy.done.leaveSubmitted,
    refusal: { kind: 'refused', reason: 'expired' }, refusalText: copy.refused.expired, editHref: '/leave?apply=1&type=fictional' },
  { name: 'attendance correction', kind: 'attendance', make: () => proposal('attendance.correction.request', 'attendance_request', 'create', '/assistant/attendance', { startDate: '2026-11-02', checkOut: '18:10', recordedCheckIn: '09:00' }),
    success: { kind: 'submitted', action: 'attendance.correction.request', requestId: randomUUID() }, done: copy.done.attendanceSubmitted,
    refusal: { kind: 'refused', reason: 'retired' }, refusalText: copy.refused.retired, editHref: '/attendance/my-records?date=2026-11-02' },
  { name: 'overtime request', kind: 'attendance', make: () => proposal('attendance.overtime.request', 'attendance_request', 'create', '/assistant/attendance', { startDate: '2026-11-07', plannedStart: '09:00', plannedEnd: '13:00', overtimeMinutes: 240 }, '?flow=overtime&review='),
    success: { kind: 'submitted', action: 'attendance.overtime.request', requestId: randomUUID() }, done: copy.done.attendanceSubmitted,
    refusal: { kind: 'refused', reason: 'authority_mismatch' }, refusalText: copy.refused.access, editHref: '/attendance/plan-ot/apply?date=2026-11-07' },
  { name: 'claim', kind: 'own_change', make: () => proposal('claims.submit', 'claim_request', 'create', '/assistant/claims', { claimType: 'Fictional Travel', incurredOn: '2026-10-31', amount: '42.60', outcome: 'claim_submitted_if_checks_pass' }),
    success: { kind: 'submitted', action: 'claims.submit', claimId: randomUUID() }, done: copy.done.claimSubmitted,
    // The claims service's own sentence is shown as it gave it, with the page where the person can fix it.
    refusal: { kind: 'refused', reason: 'service_refused', message: 'Fictional claims rule: this claim type needs a project code.', href: '/claims?draft=fictional' },
    refusalText: 'Fictional claims rule: this claim type needs a project code.', refusalLink: '/claims?draft=fictional', editHref: '/claims?draft=fictional' },
  { name: 'claim needing a receipt', kind: 'own_change', make: () => proposal('claims.submit', 'claim_request', 'create', '/assistant/claims', { claimType: 'Fictional Meals', incurredOn: '2026-10-30', amount: '18.00', outcome: 'claim_draft_receipt_needed' }),
    success: { kind: 'draft_saved', action: 'claims.submit', href: '/claims?draft=fictional-receipt' }, done: copy.done.claimDraftSaved, doneLink: '/claims?draft=fictional-receipt',
    refusal: { kind: 'refused', reason: 'unavailable' }, refusalText: copy.refused.unavailable, editHref: '/claims?draft=fictional-receipt' },
  { name: 'claim cancellation', kind: 'own_change', make: () => proposal('claims.cancel', 'claim_request', 'withdraw', '/assistant/claims', { claimType: 'Fictional Parking', incurredOn: '2026-10-29', amount: '6.00', outcome: 'claim_cancelled_now' }, '?flow=cancel&review='),
    success: { kind: 'cancelled', action: 'claims.cancel', claimId: randomUUID() }, done: copy.done.claimCancelled,
    refusal: { kind: 'refused', reason: 'signature' }, refusalText: copy.refused.invalid, editHref: '/claims' },
  { name: 'profile change', kind: 'own_change', make: () => proposal('ess.profile.request', 'profile_change_request', 'create', '/assistant/profile', { profileChange: 'address', fieldCount: 3, outcome: 'hr_approval_required' }),
    success: { kind: 'requested', action: 'ess.profile.request', requestId: randomUUID() }, done: copy.done.profileRequested,
    refusal: { kind: 'refused', reason: 'expired' }, refusalText: copy.refused.expired, editHref: '/me?tab=address' },
  // AI v2 W2 slice 2: a Leave Credit request for a person outside the First Schedule asks for no agreement on the card.
  { name: 'Leave Credit request', kind: 'toil', make: () => proposal('toil.replacement.request', 'leave_credit_request', 'create', '/assistant/toil', { startDate: '2026-11-01', endDate: '2026-11-01', plannedStart: '09:00', plannedEnd: '17:00', creditDays: 1, outcome: 'submitted_not_approved' }),
    success: { kind: 'submitted', action: 'toil.replacement.request', requestId: randomUUID() }, done: copy.done.toilSubmitted,
    refusal: { kind: 'refused', reason: 'changed' }, refusalText: copy.refused.invalid, editHref: '/leave?credit=1&creditDate=2026-11-01&creditStart=09%3A00&creditEnd=17%3A00' },
  // AI v2 Phase 1 slice 3: an own letter request; an open request for the same letter type is refused in place.
  { name: 'letter request', kind: 'letter_request', make: () => proposal('letters.request.submit', 'letter_request', 'create', '/me/letters', { letterType: 'Fictional Employment Confirmation Letter', outcome: 'letter_requested_hr_prepares' }, '?template='),
    success: { kind: 'submitted', action: 'letters.request.submit', requestId: randomUUID() }, done: copy.done.letterRequested,
    refusal: { kind: 'refused', reason: 'duplicate' }, refusalText: copy.refused.duplicate, editHref: '/me/letters?request=1&template=fictional#request-letter' },
];

beforeEach(() => { vi.stubEnv('TERAS_PROPOSAL_SECRET', 'fictional-inline-proposal-secret-0123456789abcdef'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe.each(CASES)('the $name card in chat, for the employee', row => {
  it('shows Confirm and submit, Edit and Discard, still awaiting the person, and posts nothing until a press', async () => {
    const card = await show(row.make());
    expect(buttons(card).map(item => item.textContent?.split(' · ')[0])).toEqual([copy.confirm, copy.edit, copy.discard]);
    for (const item of buttons(card)) { expect(item).toHaveAttribute('type', 'button'); expect(item).toBeEnabled(); expect(item.className).toContain('pointer-coarse:min-h-11'); }
    expect(within(card).getByRole('group', { name: copy.actionsLabel })).toBeInTheDocument();
    // The dashed ring: prepared, nobody has signed. No review link: the card confirms in place.
    expect(within(card).getByRole('img', { name: awaiting })).toHaveClass('atelier-unmarked');
    expect(within(card).queryAllByRole('link')).toHaveLength(0);
    expect(card.querySelector('[data-makers-mark]')).toBeNull();
    for (const post of allPosts()) expect(post).not.toHaveBeenCalled();
  });

  it('Confirm posts this card with confirm: true to its own owner and shows the outcome with the Maker\'s Mark', async () => {
    const signed = row.make();
    const card = await show(signed);
    const pending = deferred<unknown>();
    posts[row.kind].confirm.mockReturnValueOnce(pending.promise);
    fireEvent.click(button(card, copy.confirm));
    // Pending: every button is disabled, Confirm says it is submitting, and the group is busy.
    expect(posts[row.kind].confirm).toHaveBeenCalledTimes(1);
    expect(posts[row.kind].confirm).toHaveBeenCalledWith({ proposal: signed, confirm: true });
    expect(buttons(card).every(item => item.disabled)).toBe(true);
    expect(button(card, copy.confirming)).toBeDisabled();
    expect(within(card).getByRole('group', { name: copy.actionsLabel })).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button(card, copy.confirming));
    expect(posts[row.kind].confirm).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(row.success); });
    const outcome = within(card).getByRole('status');
    expect(outcome).toHaveTextContent(`${copy.confirmedBy} · ${row.done}`);
    expect(outcome.querySelector('[data-makers-mark]')).toHaveClass('atelier-mark');
    expect(outcome).toHaveFocus();
    expect(buttons(card)).toHaveLength(0);
    expect(within(card).queryByRole('img', { name: awaiting })).toBeNull();
    if (row.doneLink) expect(within(outcome).getByRole('link', { name: copy.openClaims })).toHaveAttribute('href', row.doneLink);
    else expect(within(outcome).queryAllByRole('link')).toHaveLength(0);
    // Only this card's owner was asked, once; no other owner and no Edit.
    for (const post of allPosts()) if (post !== posts[row.kind].confirm) expect(post).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('Confirm shows the owner\'s refusal in place and keeps the card to try again', async () => {
    const card = await show(row.make());
    posts[row.kind].confirm.mockResolvedValueOnce(row.refusal);
    await act(async () => { fireEvent.click(button(card, copy.confirm)); });
    const alert = within(card).getByRole('alert');
    expect(alert).toHaveTextContent(row.refusalText);
    if (row.refusalLink) expect(within(alert).getByRole('link', { name: copy.fixIt })).toHaveAttribute('href', row.refusalLink);
    expect(within(card).queryByRole('status')).toBeNull();
    expect(card.querySelector('[data-makers-mark]')).toBeNull();
    expect(button(card, copy.confirm)).toBeEnabled();
    expect(within(card).getByRole('img', { name: awaiting })).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('Edit opens the owner\'s prefilled form and submits nothing', async () => {
    const signed = row.make();
    const card = await show(signed);
    posts[row.kind].edit.mockResolvedValueOnce({ ok: true, href: row.editHref });
    await act(async () => { fireEvent.click(button(card, copy.edit)); });
    expect(posts[row.kind].edit).toHaveBeenCalledWith({ proposal: signed });
    expect(nav.push).toHaveBeenCalledWith(row.editHref);
    for (const post of allPosts()) if (post !== posts[row.kind].edit) expect(post).not.toHaveBeenCalled();
  });

  it('Discard hides the card and sends nothing', async () => {
    const card = await show(row.make());
    fireEvent.click(button(card, copy.discard));
    expect(card).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    for (const post of allPosts()) expect(post).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('the inline buttons, beyond one kind', () => {
  const claim = () => CASES.find(row => row.name === 'claim')!.make();

  it('are reached and pressed from the keyboard alone', async () => {
    const user = userEvent.setup();
    const card = await show(claim());
    posts.own_change.confirm.mockResolvedValueOnce({ kind: 'submitted', action: 'claims.submit', claimId: randomUUID() });
    await user.tab();
    // "How this was prepared" comes after the buttons; the first stop in the card is Confirm.
    expect(button(card, copy.confirm)).toHaveFocus();
    await user.tab();expect(button(card, copy.edit)).toHaveFocus();
    await user.tab();expect(button(card, copy.discard)).toHaveFocus();
    await user.tab({ shift: true });await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    expect(posts.own_change.confirm).toHaveBeenCalledTimes(1);
    const outcome = await within(card).findByRole('status');
    expect(outcome).toHaveTextContent(copy.done.claimSubmitted);expect(outcome).toHaveFocus();
  });

  it('a "use the form" answer opens the prefilled form', async () => {
    const card = await show(CASES[0].make());
    posts.leave.confirm.mockResolvedValueOnce({ kind: 'use_form', href: '/leave?apply=1&type=fictional' });
    await act(async () => { fireEvent.click(button(card, copy.confirm)); });
    expect(nav.push).toHaveBeenCalledWith('/leave?apply=1&type=fictional');
    expect(within(card).queryByRole('status')).toBeNull();
    expect(button(card, copy.confirm)).toBeEnabled();
  });

  it('a failed post or an outside address shows an error, never follows it', async () => {
    const card = await show(claim());
    posts.own_change.confirm.mockRejectedValueOnce(new Error('network'));
    await act(async () => { fireEvent.click(button(card, copy.confirm)); });
    expect(within(card).getByRole('alert')).toHaveTextContent(copy.error);
    posts.own_change.edit.mockResolvedValueOnce({ ok: true, href: '//fictional.example/phish' });
    await act(async () => { fireEvent.click(button(card, copy.edit)); });
    expect(nav.push).not.toHaveBeenCalled();
    expect(within(card).getByRole('alert')).toHaveTextContent(copy.refused.unavailable);
    posts.own_change.edit.mockResolvedValueOnce({ ok: false, reason: 'authority_mismatch' });
    await act(async () => { fireEvent.click(button(card, copy.edit)); });
    expect(within(card).getByRole('alert')).toHaveTextContent(copy.refused.access);
  });

  it('names a letter request card by its letter type and what confirming does, with no letter content', async () => {
    const card = await show(CASES.find(row => row.name === 'letter request')!.make());
    expect(within(card).getAllByRole('heading')[0]).toHaveTextContent('Fictional Employment Confirmation Letter request');
    expect(card).toHaveTextContent((messages as any).aiCentre.conversation.outcomes.letter_requested_hr_prepares);
  });

  it('leave an approver\'s decision card with its one review link', async () => {
    const decide = proposal('approvals.leave.decide', 'leave_approval', 'decide', '/assistant/approvals', { decision: 'approved', outcome: 'approval_if_native_checks_pass' });
    const card = await show(decide);
    expect(buttons(card)).toHaveLength(0);
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(1);expect(links[0]).toHaveAttribute('href', decide.body.review.href);
  });
});
