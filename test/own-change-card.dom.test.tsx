/** AI v2 W2 — the chat card of an own claim or profile change, rendered by the real ConversationReply for the employee
 * it serves, in all six languages: the title names the claim type, amount and date (or what changes), the outcome says
 * what confirming does, and the card confirms in place (Confirm and submit, Edit, Discard; AI v2 Phase 1) instead of
 * linking to its review page. A bank card names the bank and last four digits only.
 * Fictional values only; proposals are signed with a fictional secret; no database. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import { withAiCentre } from './helpers/ai-centre-messages';
const state = vi.hoisted(() => ({ locale: 'en', messages: {} as Record<string, unknown> }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// The card's server actions: rendering a card posts nothing (each is asserted untouched below).
const posts = vi.hoisted(() => ({ confirm: vi.fn(), edit: vi.fn() }));
vi.mock('../app/assistant/leave-apply-proposal-actions', () => ({ confirmLeaveApplyProposalAction: posts.confirm, editLeaveApplyProposalAction: posts.edit }));
vi.mock('../app/assistant/attendance-request-proposal-actions', () => ({ confirmAttendanceRequestProposalAction: posts.confirm, editAttendanceRequestProposalAction: posts.edit }));
vi.mock('../app/assistant/own-change-proposal-actions', () => ({ confirmOwnChangeProposalAction: posts.confirm, editOwnChangeProposalAction: posts.edit }));
vi.mock('../app/assistant/toil-request-proposal-actions', () => ({ confirmToilRequestProposalAction: posts.confirm, editToilRequestProposalAction: posts.edit }));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: state.messages as never, namespace }),
  getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }),
}));
import { issueProposal, type ProposalDraft } from '../core/proposals/proposal';
import { OWN_CHANGE_TITLE_DATE } from '../lib/ai-centre/own-change-title';
import { ConversationReply } from '../components/ai-centre/conversation-reply';

const BASES: Record<string, Record<string, unknown>> = { en, ms, zh, vi: viCopy, ta, th };
const tenantId = randomUUID(), userId = randomUUID(), personId = randomUUID(), employmentId = randomUUID();
const created = new Date(), expires = new Date(created.getTime() + 600_000);
function proposal(action: string, route: string, facts: ProposalDraft['facts'], href = route + '?review=' + randomUUID()) {
  const reference = href.slice(-36);
  return issueProposal({ what: { action, contractVersion: 1, entity: action.startsWith('claims') ? 'claim_request' : 'profile_change_request', effect: action === 'claims.cancel' ? 'withdraw' : 'create', selectors: {}, reviewedDigest: 'a'.repeat(64) },
    forWhom: { tenantId, subject: 'own_employment', subjectId: employmentId }, authority: { kind: 'person', tenantId, userId, personId },
    checks: [{ check: 'actor_current', owner: 'core/assistant-actions/own-leave-actor.ts#readOwnLeaveActorTx', ruleVersion: null, result: 'pass' }],
    review: { route, href, reference }, facts, createdAt: created.toISOString(), expiresAt: expires.toISOString() });
}
const turn = (proposals: ReturnType<typeof proposal>[]) => ({ turnId: randomUUID(), reply: '', mode: 'answer', slot: null, suggestion: null, proposals, reads: [],
  sensitive: false, refused: false, crisis: false, fallback: false, continuation: '', trace: null as never, modelTurn: [] });

beforeEach(() => { vi.stubEnv('TERAS_PROPOSAL_SECRET', 'fictional-proposal-signing-secret-0123456789abcdef'); });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('an own claim or profile change card in chat, for the employee', () => {
  it.each(['en', 'ms', 'zh', 'vi', 'ta', 'th'])('%s', async locale => {
    state.locale = locale; state.messages = withAiCentre(locale, BASES[locale]);
    const translate = createTranslator({ locale, messages: state.messages as never, namespace: 'aiCentre.conversation' as never }) as unknown as (key: string, values?: Record<string, string>) => string;
    const t = (key: string, values?: Record<string, string>) => translate(key, values);
    const day = new Intl.DateTimeFormat(locale, OWN_CHANGE_TITLE_DATE).format(new Date('2026-10-31T00:00:00.000Z'));
    const claim = proposal('claims.submit', '/assistant/claims', { claimType: 'Fictional Travel', incurredOn: '2026-10-31', amount: '42.60', outcome: 'claim_submitted_if_checks_pass' });
    const cancel = proposal('claims.cancel', '/assistant/claims', { claimType: 'Fictional Travel', incurredOn: '2026-10-31', amount: '42.60', outcome: 'claim_cancelled_now' }, '/assistant/claims?flow=cancel&review=' + randomUUID());
    const bank = proposal('ess.profile.request', '/assistant/profile', { profileChange: 'bank', fieldCount: 2, bankName: 'Maybank', accountEnding: '5678', outcome: 'hr_verification_required' });
    const address = proposal('ess.profile.request', '/assistant/profile', { profileChange: 'address', fieldCount: 3, outcome: 'hr_approval_required' });
    const element = await ConversationReply({ turn: turn([claim, cancel, bank, address]) as never });
    render(<NextIntlClientProvider locale={locale} messages={state.messages as never} timeZone="Asia/Kuala_Lumpur">{element}</NextIntlClientProvider>);
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(4);
    const titles = [t('claimSubmitTitle', { claimType: 'Fictional Travel', amount: '42.60', date: day }), t('claimCancelTitle', { claimType: 'Fictional Travel', amount: '42.60', date: day }),
      t('profileBankTitle', { bankName: 'Maybank', ending: '5678' }), t('profileAddressTitle')];
    const outcomes = [t('outcomes.claim_submitted_if_checks_pass'), t('outcomes.claim_cancelled_now'), t('outcomes.hr_verification_required'), t('outcomes.hr_approval_required')];
    const inline = (key: string) => t(`inline.${key}`);
    cards.forEach((card, index) => {
      expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent(titles[index]);
      expect(card).toHaveTextContent(outcomes[index]);
      // AI v2 Phase 1: the three inline buttons replace the review link.
      expect(within(card).queryAllByRole('link')).toHaveLength(0);
      const buttons = [...card.querySelectorAll('button')];
      expect(buttons.map(button => button.textContent)).toEqual([`${inline('confirm')} · ${titles[index]}`, `${inline('edit')} · ${titles[index]}`, `${inline('discard')} · ${titles[index]}`]);
      expect(card.textContent).not.toMatch(/[{}]/);
    });
    expect(titles[0]).toContain('42.60');expect(titles[0]).toContain(day);expect(titles[2]).toContain('5678');
    // The card never shows more of an account than its last four digits, and no raw check identifier.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) expect(node.textContent).not.toMatch(/\d{5,}/);
    expect(document.body.textContent).not.toContain('actor_current');
    expect(posts.confirm).not.toHaveBeenCalled();expect(posts.edit).not.toHaveBeenCalled();
  });
});
