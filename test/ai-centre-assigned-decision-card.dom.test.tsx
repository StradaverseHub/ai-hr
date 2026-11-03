/** AI v2 W2 slice 3 — an assigned approver's claim or attendance decision card prepared in chat, rendered by the real
 * ConversationReply for the approver it serves (mirroring approvals.leave.decide).
 *
 * The card names the decision and the request it decides, from the signed card's own facts: the claim type, amount and
 * date, or the overtime window, or the clock time to correct. It shows the checks the custody ran (the assigned approver,
 * not their own request, still pending), what confirming does, and Confirm, Edit and Discard. Nothing posts until a press;
 * Confirm posts this very card with `confirm: true` to the decision owner and shows the recorded decision with the
 * approver's Maker's Mark; a refusal is shown in place; Edit opens the approvals review page. The server actions are
 * spies (test/proposal-assigned-decision-chat.test.ts covers what the server checks); proposals are signed with a
 * fictional secret. Fictional values only; no database. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import { withAiCentre } from './helpers/ai-centre-messages';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const state = vi.hoisted(() => ({ locale: 'en', messages: {} as Record<string, unknown> }));
const posts = vi.hoisted(() => ({ decision: { confirm: vi.fn(), edit: vi.fn() }, other: { confirm: vi.fn(), edit: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: nav.push }) }));
vi.mock('../app/assistant/leave-apply-proposal-actions', () => ({ confirmLeaveApplyProposalAction: posts.other.confirm, editLeaveApplyProposalAction: posts.other.edit }));
vi.mock('../app/assistant/attendance-request-proposal-actions', () => ({ confirmAttendanceRequestProposalAction: posts.other.confirm, editAttendanceRequestProposalAction: posts.other.edit }));
vi.mock('../app/assistant/own-change-proposal-actions', () => ({ confirmOwnChangeProposalAction: posts.other.confirm, editOwnChangeProposalAction: posts.other.edit }));
vi.mock('../app/assistant/toil-request-proposal-actions', () => ({ confirmToilRequestProposalAction: posts.other.confirm, editToilRequestProposalAction: posts.other.edit }));
vi.mock('../app/assistant/assigned-decision-proposal-actions', () => ({ confirmAssignedDecisionProposalAction: posts.decision.confirm, editAssignedDecisionProposalAction: posts.decision.edit }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: state.messages as never, namespace }),
  getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
import { issueProposal, type ProposalDraft } from '../core/proposals/proposal';
import { ConversationReply } from '../components/ai-centre/conversation-reply';

const MESSAGES = { en: withAiCentre('en', en as Record<string, unknown>), ms: withAiCentre('ms', ms as Record<string, unknown>) } as const;
const conversation = (locale: keyof typeof MESSAGES) => (MESSAGES[locale] as any).aiCentre.conversation as Record<string, any>;
const inline = (locale: keyof typeof MESSAGES) => conversation(locale).inline as Record<string, any>;

const tenantId = randomUUID(), userId = randomUUID(), personId = randomUUID();
const CHECKS = {
  claim: [
    { check: 'ai_controls_unpaused', owner: 'core/ai-governance.ts#assertAiActionUnpausedTx' },
    { check: 'assigned_approver_current', owner: 'core/approvals.ts#assertCanDecide' },
    { check: 'not_own_request', owner: 'core/assistant-actions/assigned-decision-sources.ts#withAssignedClaimSubjectTx' },
    { check: 'request_still_pending', owner: 'core/assistant-actions/assigned-decision-sources.ts#prepareAssignedClaimSourceTx' }],
  attendance: [
    { check: 'ai_controls_unpaused', owner: 'core/ai-governance.ts#assertAiActionUnpausedTx' },
    { check: 'assigned_approver_current', owner: 'packs/attendance/service.ts#assertCanDecideAttendanceApplicationTx' },
    { check: 'not_own_request', owner: 'core/assistant-actions/assigned-decision-sources.ts#withAssignedAttendanceSubjectTx' },
    { check: 'request_still_pending', owner: 'core/assistant-actions/assigned-decision-sources.ts#prepareAssignedAttendanceSourceTx' }],
} as const;
function decisionCard(kind: 'claim' | 'attendance', selectors: Record<string, string>, facts: ProposalDraft['facts']) {
  const reference = randomUUID(), created = new Date(), flow = kind === 'claim' ? 'claims' : 'attendance';
  return issueProposal({ what: { action: kind === 'claim' ? 'approvals.claim.decide' : 'approvals.attendance.decide', contractVersion: 1,
    entity: kind === 'claim' ? 'claim_approval_item' : 'attendance_approval_item', effect: 'decide', selectors, reviewedDigest: 'c'.repeat(64) },
    forWhom: { tenantId, subject: 'assigned_request', subjectId: randomUUID() },
    authority: { kind: 'person', tenantId, userId, personId },
    checks: CHECKS[kind].map(check => ({ ...check, ruleVersion: null, result: 'pass' as const })),
    review: { route: '/assistant/approvals', href: `/assistant/approvals?flow=${flow}&review=${reference}`, reference }, facts,
    createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + 600_000).toISOString() });
}
const claim = (decision: 'approved' | 'rejected') => decisionCard('claim', { incurredOn: '2026-10-31', decision },
  { claimType: 'Fictional Travel Claim', claimItem: 'Fictional e-hailing', incurredOn: '2026-10-31', amount: '42.60', decision,
    outcome: decision === 'approved' ? 'approval_if_native_checks_pass' : 'rejection_if_confirmed' });
const overtime = (decision: 'approved' | 'rejected') => decisionCard('attendance', { date: '2026-11-04', kind: 'overtime', decision },
  { startDate: '2026-11-04', endDate: '2026-11-04', plannedStart: '18:00', plannedEnd: '21:00', overtimeMinutes: 180, decision,
    outcome: decision === 'approved' ? 'attendance_decision_if_checks_pass' : 'rejection_if_confirmed' });
const clockOut = (decision: 'approved' | 'rejected') => decisionCard('attendance', { date: '2026-11-03', kind: 'correction', decision },
  { startDate: '2026-11-03', endDate: '2026-11-03', checkOut: '18:10', decision, outcome: decision === 'approved' ? 'attendance_decision_if_checks_pass' : 'rejection_if_confirmed' });

const turn = (proposals: ReturnType<typeof decisionCard>[]) => ({ turnId: randomUUID(), reply: '', mode: 'answer', slot: null, suggestion: null, proposals, reads: [],
  sensitive: false, refused: false, crisis: false, fallback: false, continuation: '', trace: null as never, modelTurn: [] });
async function show(card: ReturnType<typeof decisionCard>, locale: keyof typeof MESSAGES = 'en') {
  state.locale = locale; state.messages = MESSAGES[locale] as Record<string, unknown>;
  const element = await ConversationReply({ turn: turn([card]) as never });
  render(<NextIntlClientProvider locale={locale} messages={MESSAGES[locale] as never} timeZone="Asia/Kuala_Lumpur">{element}</NextIntlClientProvider>);
  return screen.getByRole('article');
}
const button = (card: HTMLElement, label: string) => within(card).getByRole('button', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
const allPosts = () => [posts.decision.confirm, posts.decision.edit, posts.other.confirm, posts.other.edit];
// Independent expected values: dates and times formatted by Intl itself, the sentences from the catalogue.
const claimDate = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
const day = (iso: string) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
const time = (hhmm: string) => new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date('1970-01-01T' + hhmm + ':00Z'));

beforeEach(() => { vi.stubEnv('TERAS_PROPOSAL_SECRET', 'fictional-assigned-decision-card-secret-0123456789'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('an approver\'s claim decision card in chat', () => {
  it('names the decision and the claim, shows the custody\'s checks and what confirming does, and posts nothing until a press', async () => {
    const card = await show(claim('approved'));
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(`Approve: Fictional Travel claim, RM 42.60, ${claimDate('en', '2026-10-31')}`);
    expect(card).toHaveTextContent('Approved if the checks still pass');
    for (const label of ['You are its assigned approver', 'Not your own request', 'Request still pending', 'AI controls allow this']) expect(card).toHaveTextContent(label);
    for (const label of [inline('en').confirm, inline('en').edit, inline('en').discard]) expect(button(card, label)).toBeEnabled();
    // The card carries no link of its own: its buttons replace it.
    expect(within(card).queryAllByRole('link').filter(link => link.getAttribute('href')?.startsWith('/assistant/approvals'))).toEqual([]);
    for (const post of allPosts()) expect(post).not.toHaveBeenCalled();
  });

  it('Confirm posts this very card with confirm: true to the decision owner and shows the recorded approval', async () => {
    const signed = claim('approved');
    const card = await show(signed);
    posts.decision.confirm.mockResolvedValueOnce({ kind: 'decided', action: 'approvals.claim.decide', decision: 'approved', recorded: 'final' });
    await act(async () => { fireEvent.click(button(card, inline('en').confirm)); });
    expect(posts.decision.confirm).toHaveBeenCalledTimes(1);
    expect(posts.decision.confirm).toHaveBeenCalledWith({ proposal: signed, confirm: true });
    expect(within(card).getByRole('status')).toHaveTextContent(`${inline('en').confirmedBy} · ${inline('en').done.decisionApproved}`);
    expect(card.querySelector('[data-makers-mark]')).not.toBeNull();
    for (const post of [posts.decision.edit, posts.other.confirm, posts.other.edit]) expect(post).not.toHaveBeenCalled();
  });

  it('a rejection card says it rejects, and shows the recorded rejection', async () => {
    const card = await show(claim('rejected'));
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(`Reject: Fictional Travel claim, RM 42.60, ${claimDate('en', '2026-10-31')}`);
    expect(card).toHaveTextContent('Rejected if you confirm');
    posts.decision.confirm.mockResolvedValueOnce({ kind: 'decided', action: 'approvals.claim.decide', decision: 'rejected', recorded: 'final' });
    await act(async () => { fireEvent.click(button(card, inline('en').confirm)); });
    expect(within(card).getByRole('status')).toHaveTextContent(inline('en').done.decisionRejected);
  });

  it('shows the owner\'s refusal in place and records nothing', async () => {
    const card = await show(claim('approved'));
    posts.decision.confirm.mockResolvedValueOnce({ kind: 'refused', reason: 'authority_mismatch' });
    await act(async () => { fireEvent.click(button(card, inline('en').confirm)); });
    expect(within(card).getByRole('alert')).toHaveTextContent(inline('en').refused.access);
    expect(within(card).queryByRole('status')).toBeNull();
    expect(button(card, inline('en').confirm)).toBeEnabled();
  });

  it('Edit opens the approvals review page and decides nothing', async () => {
    const signed = claim('approved');
    const card = await show(signed);
    posts.decision.edit.mockResolvedValueOnce({ ok: true, href: signed.body.review.href });
    await act(async () => { fireEvent.click(button(card, inline('en').edit)); });
    expect(posts.decision.edit).toHaveBeenCalledWith({ proposal: signed });
    expect(nav.push).toHaveBeenCalledWith(signed.body.review.href);
    expect(posts.decision.confirm).not.toHaveBeenCalled();
  });

  it('Discard hides the card and sends nothing', async () => {
    const card = await show(claim('approved'));
    await act(async () => { fireEvent.click(button(card, inline('en').discard)); });
    expect(screen.queryByRole('article')).toBeNull();
    for (const post of allPosts()) expect(post).not.toHaveBeenCalled();
  });

  it('speaks Malay to a Malay approver', async () => {
    const card = await show(claim('approved'), 'ms');
    const words = conversation('ms');
    const item = (words.claimSubmitTitle as string).replace('{claimType}', 'Fictional Travel').replace('{amount}', '42.60').replace('{date}', claimDate('ms', '2026-10-31'));
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent((words.decisionApproveTitle as string).replace('{item}', item));
    expect(card).toHaveTextContent(words.checks.assigned_approver_current);
    expect(button(card, inline('ms').confirm)).toBeEnabled();
  });
});

describe('an approver\'s attendance decision card in chat', () => {
  it('names the overtime window and says a later approver may still decide; a level decision says so', async () => {
    const signed = overtime('approved');
    const card = await show(signed);
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(`Approve: Overtime request, ${day('2026-11-04')}, ${time('18:00')} – ${time('21:00')}`);
    expect(card).toHaveTextContent(conversation('en').outcomes.attendance_decision_if_checks_pass);
    posts.decision.confirm.mockResolvedValueOnce({ kind: 'decided', action: 'approvals.attendance.decide', decision: 'approved', recorded: 'level' });
    await act(async () => { fireEvent.click(button(card, inline('en').confirm)); });
    expect(posts.decision.confirm).toHaveBeenCalledWith({ proposal: signed, confirm: true });
    expect(within(card).getByRole('status')).toHaveTextContent(inline('en').done.decisionLevelRecorded);
  });

  it('names a clock-out correction by its day and time', async () => {
    const card = await show(clockOut('rejected'));
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(`Reject: Clock-out correction, ${day('2026-11-03')}, ${time('18:10')}`);
    expect(card).toHaveTextContent('Rejected if you confirm');
    for (const post of allPosts()) expect(post).not.toHaveBeenCalled();
  });
});
