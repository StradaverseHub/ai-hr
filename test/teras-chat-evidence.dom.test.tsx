/** @vitest-environment jsdom */
/** ADR-0169 §5.1 wiring — CI component evidence of the live chat for an employee, a manager and an HR
 * administrator, with the Noveri conversation switch on and off. The chat command is the real one
 * (app/assistant/launcher-actions.ts) and the conversation is the real chat component; owners are fictional:
 * the switch and the turn are stubbed with fictional results (the turn itself is proved on the database by
 * test/teras-conversation-turn.test.ts), and the closed grammar's reply is a stand-in for its unchanged screen.
 * No database, no provider, no authenticated server journey. Screenshots are written only on the selected
 * GitHub Actions runner (test/helpers/ai-review-screenshots.ts); each case also asserts what the screen shows. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import { aiReviewDomHtml, captureAiReviewScreenshots } from './helpers/ai-review-screenshots';
import { enWithAiCentre } from './helpers/ai-centre-messages';

const state = vi.hoisted(() => ({ route: vi.fn(), turn: vi.fn(), ask: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: any) => createTranslator({ locale: 'en', messages: enWithAiCentre as never, namespace }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'Asia/Kuala_Lumpur' }),
}));
vi.mock('../lib/session', () => ({ getBrowserCommandSession: async () => ({ tenantId: '00000000-0000-4000-8000-0000000000aa', userId: '00000000-0000-4000-8000-0000000000bb' }) }));
vi.mock('../core/assistant', () => ({ askAssistant: state.ask, AssistantError: class extends Error {} }));
vi.mock('../core/assistant-clarification', () => ({ AssistantClarificationError: class extends Error {} }));
vi.mock('../core/ai-workspace', () => ({ loadAiWorkspace: async () => ({ history: [{ id: 'closed-1', grounded: null }] }) }));
vi.mock('../core/assistant-threads', () => ({ loadOwnAssistantChat: vi.fn(), listOwnAssistantChats: vi.fn() }));
vi.mock('../components/assistant/exchange-reply', () => ({ ExchangeReply: async () => <p data-closed-grammar>Which area would you like help with? Leave, claims, payslips or holidays.</p> }));
vi.mock('../core/read', () => ({ allowedCompanies: async () => [{ id: '00000000-0000-4000-8000-00000000c0aa' }] }));
vi.mock('../lib/scope', () => ({ getScopeIds: async (ids: string[]) => ids }));
vi.mock('../core/teras-wiring/switch', () => ({ conversationRoute: state.route }));
vi.mock('../core/teras-wiring/turn', () => ({ runConversationTurn: state.turn, ConversationTurnError: class extends Error {} }));
import { askFromWorkspaceAction } from '../app/assistant/launcher-actions';
import { WorkspaceConversation } from '../components/assistant/workspace-conversation';
import { AiCentreTabs } from '../components/ai-centre/centre-tabs';

const FICTION = 'real chat command and components; fictional switch, turn and closed-grammar stand-in; no authenticated server journey';
const base = { reads: [] as string[], sensitive: false, refused: false, crisis: false, fallback: false, mode: 'answer', suggestion: null, proposals: [] as unknown[], continuation: 'tc1.fixture.signature' };
const check = (name: string, result: 'pass' | 'needs_review' = 'pass') => ({ check: name, owner: 'core/fixture.ts#fixture', ruleVersion: 'leave_type:fixture@v3', result });
const decideCard = {
  body: { kind: 'teras.proposal', version: 1, id: '00000000-0000-4000-8000-00000000d0aa',
    what: { action: 'approvals.leave.decide', contractVersion: 1, entity: 'leave_request', effect: 'decide', selectors: { decision: 'approved' }, reviewedDigest: 'f'.repeat(64) },
    forWhom: { tenantId: '00000000-0000-4000-8000-0000000000aa', subject: 'assigned_request', subjectId: '00000000-0000-4000-8000-00000000e0aa' },
    authority: { kind: 'person', tenantId: '00000000-0000-4000-8000-0000000000aa', userId: '00000000-0000-4000-8000-0000000000bb', personId: '00000000-0000-4000-8000-0000000000cc' },
    checks: [check('actor_current'), check('assigned_step_current'), check('deduction_and_balance')],
    review: { route: '/assistant/approvals', href: '/assistant/approvals?review=00000000-0000-4000-8000-00000000f0aa', reference: '00000000-0000-4000-8000-00000000f0aa' },
    facts: { leaveType: 'Annual Leave', startDate: '2026-11-13', endDate: '2026-11-14', days: 2, outcome: 'approval_if_native_checks_pass' },
    recommendation: { verdict: 'needs_review', recommenderVersion: 'leave_decision:v1', checks: [], failedRules: [{ check: 'team_coverage', blocking: false, ruleVersion: null }], recordId: null },
    createdAt: '2026-11-02T03:00:00.000Z', expiresAt: '2026-11-05T03:00:00.000Z' },
  signature: { alg: 'HMAC-SHA256', value: 'e'.repeat(64) },
};
const SCENES = {
  employee: [
    { question: 'How much annual leave do I have?', turn: { ...base, turnId: 'e1', reads: ['my_leave_balances'], reply: 'You have 13.25 days of Annual Leave available, after 3 days taken and 1 day waiting for approval.' } },
    { question: 'My manager keeps shouting at me in meetings.', turn: { ...base, turnId: 'e2', sensitive: true, mode: null, reply: 'For this, please contact your HR team directly. A person there can take it forward under your company\'s procedures; the Assistant cannot open a case or act on it.' } },
  ],
  manager: [
    { question: 'Is anything waiting for my approval?', turn: { ...base, turnId: 'm1', mode: 'propose', reads: ['approval_queue'], suggestion: { action: 'approvals.leave.decide', reviewRoute: '/assistant/approvals', inlineCard: true }, proposals: [decideCard],
      reply: 'One leave request is waiting for your decision: Fictional Tan, Annual Leave, Thursday 13 to Friday 14 November (2 days). It is ready for you to review.' } },
  ],
  hr: [
    { question: 'What is still blocking payroll this month?', turn: { ...base, turnId: 'h1', mode: 'guide', reads: ['setup_readiness', 'product_guidance'],
      reply: '1. Add bank details for 3 employees.\n2. Set the EPF contribution rate for 2 new hires.\n3. Close the October attendance period.\nOpen Payroll readiness to see each item.' } },
  ],
} as const;
const roles = Object.keys(SCENES) as (keyof typeof SCENES)[];

async function conversation(role: keyof typeof SCENES, on: boolean) {
  state.route.mockResolvedValue(on ? { route: 'harness', permit: {}, attestedProvider: null, explainers: true } : { route: 'closed' });
  const turns = [];
  for (const [index, scene] of SCENES[role].entries()) {
    state.turn.mockResolvedValueOnce(scene.turn);
    state.ask.mockResolvedValueOnce({ exchangeId: 'closed-1', conversationToken: 'closed-proof' });
    const reply = await askFromWorkspaceAction({ question: scene.question });
    if (!reply.ok) throw Error(reply.message);
    turns.push({ id: `${role}-${index}`, question: scene.question, answer: reply.answer });
  }
  return turns;
}
function show(role: keyof typeof SCENES, turns: { id: string; question: string; answer: React.ReactNode }[]) {
  return render(<NextIntlClientProvider locale="en" messages={enWithAiCentre as never} timeZone="Asia/Kuala_Lumpur">
    <div className="mx-auto max-w-5xl space-y-5 p-6"><AiCentreTabs active="ask" isAdmin={role === 'hr'} />
      <div className="h-[720px]"><WorkspaceConversation tasks={[]} fileImport={false} fullHeight initialTurns={turns} /></div></div>
  </NextIntlClientProvider>);
}
beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() }));
});
afterEach(cleanup);

describe('the live chat with the Noveri conversation switch', () => {
  it.each(roles)('%s, switch on: replies render like the AI centre Ask, with cards that only link to their review page', async role => {
    const view = show(role, await conversation(role, true));
    expect(state.ask).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll('[data-teras-reply]')).toHaveLength(SCENES[role].length);
    expect(view.container.querySelector('[data-closed-grammar]')).toBeNull();
    for (const card of view.container.querySelectorAll('[data-proposal-card]')) {
      expect(card.querySelector('form, button')).toBeNull();
      expect([...card.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['/assistant/approvals?review=00000000-0000-4000-8000-00000000f0aa']);
    }
    if (role === 'manager') {
      expect(view.container.querySelector('[data-recommendation="needs_review"]')).not.toBeNull();
      expect(view.container.textContent).toContain('Leave decision ready to review');
    }
    if (role === 'employee') {
      expect(view.container.querySelector('[data-teras-route="hr_contact"]')).not.toBeNull();
      expect(view.container.textContent).toContain('Read: your leave balances, as you.');
      expect(view.container.textContent).toContain('Why is my leave entitlement this many days?');
    }
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', `ai-centre-chat-${role}-on`, FICTION, 'atelier');
  }, 120000);

  it.each(roles)('%s, switch off: the closed grammar answers and no harness reply renders', async role => {
    const view = show(role, await conversation(role, false));
    expect(state.turn).not.toHaveBeenCalled();expect(state.ask).toHaveBeenCalledTimes(SCENES[role].length);
    expect(view.container.querySelector('[data-teras-reply]')).toBeNull();
    expect(view.container.querySelectorAll('[data-closed-grammar]')).toHaveLength(SCENES[role].length);
    await captureAiReviewScreenshots(aiReviewDomHtml(view.container), 'en', `ai-centre-chat-${role}-off`, FICTION, 'atelier');
  }, 120000);
});
