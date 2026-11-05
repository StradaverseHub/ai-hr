/** @vitest-environment jsdom */
/** AI v2 Phase 1, W4 "Ask everywhere" — rendered evidence on fictional data, per role.
 *
 *  - Ask is chat-only (issue 14): the Chats column (search, New chat, Today / Yesterday / Earlier, a withheld chat as
 *    "Passed to HR · no words kept"), reopen, per-chat Delete with confirmation, the "Chats are kept for N days" footer
 *    and Your data and privacy within two clicks; the old tools moved to More tools; phones get a Chats drawer.
 *  - "Keep chats for" under Administration › Setup: a group administrator can set it, others read it only.
 *  - The command bar: ⌘K / Ctrl+K, "Ask AI Centre" with the page's area, the answer in the side panel continuing its
 *    chat, nothing run from the words; on Ask itself the open chat takes the question.
 *  - Isolation: the page reads chats for the session only and shows nothing else.
 *
 * The page (app/assistant/page.tsx), the column, the conversation, the side panel, the command bar and the retention
 * control are the real components. Owners are fictional stand-ins: the stored-chat owner (core/teras-chats.ts, proved
 * on the database by test/teras-chats.test.ts), the chat commands and the conversation command. No database, provider
 * or authenticated server journey. */
import React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { enWithAiCentre } from './helpers/ai-centre-messages';
import { todayInKualaLumpur } from '../lib/hr-date';

const state = vi.hoisted(() => ({
  session: null as unknown as Record<string, unknown>,
  path: '/assistant',
  push: vi.fn(), refresh: vi.fn(),
  listOwnChats: vi.fn(), readChatRetention: vi.fn(), legacyList: vi.fn(), workspace: vi.fn(),
  listChats: vi.fn(), deleteChat: vi.fn(), setRetention: vi.fn(),
  openStoredChat: vi.fn(), askWorkspace: vi.fn(), askLauncher: vi.fn(),
  groupAdmin: false,
  // AI v2 slice 3: the conversation route and the imports this caller may prepare in chat (the paperclip).
  route: { route: 'closed' } as Record<string, unknown>, importKinds: [] as unknown[],
}));

vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, scroll: _scroll, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => { throw Object.assign(Error('NEXT_REDIRECT'), { url }); }),
  permanentRedirect: vi.fn((url: string) => { throw Object.assign(Error('NEXT_REDIRECT'), { url }); }),
  usePathname: () => state.path, useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: state.push, refresh: state.refresh, replace: vi.fn() }),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator: translator } = await import('next-intl');
  const { enWithAiCentre: messages } = await import('./helpers/ai-centre-messages');
  return { getLocale: async () => 'en', getTranslations: async (namespace: any) => translator({ locale: 'en', messages: messages as never, namespace, onError: error => { throw error; } }) };
});
vi.mock('../lib/session', () => ({ getSession: async () => state.session, getBrowserCommandSession: async () => state.session }));
vi.mock('../lib/authz', () => ({ isGroupAdmin: () => state.groupAdmin, isAdmin: (ctx: any) => (ctx.roles ?? []).some((role: string) => role === 'hr_admin' || role === 'super_admin') }));
vi.mock('../core/teras-chats', () => ({ listOwnChats: state.listOwnChats, readChatRetention: state.readChatRetention }));
vi.mock('../app/assistant/chat-actions', () => ({ listChatsAction: state.listChats, deleteChatAction: state.deleteChat, setChatRetentionAction: state.setRetention }));
vi.mock('../app/assistant/launcher-actions', () => ({
  openStoredChatAction: state.openStoredChat, askFromWorkspaceAction: state.askWorkspace, askFromLauncherAction: state.askLauncher,
  // AI v2 slice 3: the chat command's own answer to "is the paperclip offered" (harness route and an import this caller may prepare).
  chatImportOfferedAction: async () => state.route.route === 'harness' && ((state.session.roles as string[] | undefined) ?? []).includes('hr_admin') && state.importKinds.length > 0,
  loadEarlierChatAction: vi.fn(), loadMoreChatsAction: vi.fn(),
}));
vi.mock('../app/assistant/conversation-scope', () => ({ assistantBrowserConversationScope: async () => '["c0000000-0000-4000-8000-000000000001"]' }));
vi.mock('../core/ai-workspace', () => ({ loadAiWorkspace: state.workspace, loadAiGovernance: async () => ({ access: { allowed: false, reason: 'no_grant' } }) }));
vi.mock('../core/assistant-threads', () => ({ listOwnAssistantChats: state.legacyList, loadOwnAssistantChat: vi.fn() }));
vi.mock('../core/assistant', () => ({ MAX_TURNS: 5 }));
vi.mock('../core/read', () => ({ allowedCompanies: async () => [] }));
vi.mock('../lib/viewer', () => ({ viewerIdentity: async () => ({ name: null }) }));
vi.mock('../core/employee-home', () => ({ readEmployeeHomeIdentity: async () => ({ selectedEmploymentId: null }) }));
vi.mock('../core/assistant-actions/module-action-entries', () => ({ allowedModuleActionEntries: async () => [] }));
vi.mock('../core/workspace-module-jobs', () => ({ loadCanonicalModuleJob: vi.fn() }));
vi.mock('../components/assistant/module-jobs', () => ({ CanonicalModuleJob: () => null, ModuleJobChooser: () => <p data-tool="module-jobs">Module jobs</p>, GroundedWorkspaceReply: () => null, GovernedModuleJobComposer: () => null, GovernedWorkspaceJob: () => null }));
vi.mock('../components/assistant/protected-analysis', () => ({ ProtectedAnalysis: () => <p data-tool="explore-patterns">Explore patterns</p> }));
vi.mock('../components/assistant/module-plan', () => ({ ModuleQuestionPlanner: () => null, HumanPlannerEvaluation: () => null }));
vi.mock('../components/assistant/module-specialist-review', () => ({ SpecialistJobComposer: () => null, ModuleSpecialistReview: () => null }));
vi.mock('../components/assistant/module-agent-review', () => ({ ModuleAgentReview: () => null }));
vi.mock('../components/assistant/personnel-review-navigation', () => ({ PersonnelReviewNavigation: () => <p data-tool="review-an-action">Review an action</p> }));
vi.mock('../components/assistant/history-privacy', () => ({ AssistantHistoryPrivacy: () => <p data-privacy="history">Clear my chat text</p> }));
vi.mock('../components/assistant/own-clear', () => ({ OwnClearForm: ({ kind }: { kind: string }) => <p data-privacy={'own-' + kind}>{kind}</p>, OwnClearStatus: () => null }));
vi.mock('../components/assistant/import-privacy', () => ({ ImportPreparationPrivacy: () => null }));
vi.mock('../components/assistant/native-outcomes', () => ({ NativeOutcomes: () => null, NativeOutcomePrivacy: () => null }));
vi.mock('../components/assistant/exchange-reply', () => ({ ExchangeReply: () => null }));
vi.mock('../components/assistant/assistant-home-tabs', () => ({ AssistantHomeTabs: () => null }));
vi.mock('../components/employee-home/tasks-card', () => ({ HomeTasksCard: () => null }));
vi.mock('../components/employee-home/calendar-card', () => ({ HomeCalendarCard: () => null }));
vi.mock('../components/ai-centre/delegated-jobs', () => ({ AiCentreDelegatedJobs: () => null }));
vi.mock('../components/ai-centre/live-status', () => ({ AiCentreLiveStatus: () => null }));
vi.mock('../app/assistant/agent-review-actions', () => ({ eraseConversationMetadataAction: vi.fn() }));
vi.mock('../app/assistant/module-plan-actions', () => ({ eraseModuleProposalsAction: vi.fn() }));
vi.mock('../app/assistant/job-feedback-actions', () => ({ eraseGovernedJobFeedbackAction: vi.fn() }));
vi.mock('../app/assistant/feedback-actions', () => ({ eraseAgentFeedbackAction: vi.fn() }));
vi.mock('../app/delegations/actions', () => ({ loadDelegationContextAction: vi.fn() }));
vi.mock('../components/delegation-manager', () => ({ DelegationManager: () => null }));
vi.mock('../core/assistant-launcher', async original => ({ ...(await original<object>()), readLauncherSettings: () => ({ enabled: false, position: 'bottom-right', hiddenAreas: [] }) }));
vi.mock('../app/control-tower/agents/launcher-actions', () => ({ setAssistantLauncherAction: vi.fn() }));
vi.mock('../core/entitlements', async original => ({ ...(await original<object>()), isModuleEnabledOrFalse: () => false }));
vi.mock('../lib/scope', () => ({ getScopeIds: async (ids: string[]) => ids }));

import AssistantPage from '../app/assistant/page';
import { AiAssistantSection } from '../app/control-tower/agents/assistant-section';
import { AiCentreTabs } from '../components/ai-centre/centre-tabs';
import { ChatRetentionControl, KEEP_CHAT_OPTIONS } from '../components/ai-centre/chat-retention-control';
import { AiAskAvailability } from '../components/ai-centre/ask-availability';
import { CommandBar } from '../components/command-bar';
import { AssistantLauncher } from '../components/assistant/assistant-launcher';
import { WorkspaceConversation } from '../components/assistant/workspace-conversation';
import { ASK_HANDOFF_KEY } from '../lib/today/ask-handoff';
import { chatGroupOf, groupChats, matchesChatSearch, previousDay } from '../lib/ai-centre/chat-groups';

const ask = enWithAiCentre.aiAsk;
// The English formatter, for expected sentences with their plural arguments (independent of the components' call).
const format = createTranslator({ locale: 'en', messages: enWithAiCentre as Record<string, unknown> }) as unknown as (key: string, values?: Record<string, number>) => string;
const tr = (key: string, values?: Record<string, number>) => format('aiAsk.' + key, values);
const TENANT = '7a000000-0000-4000-8000-000000000001';
const sessionFor = (role: 'employee' | 'manager' | 'hr_admin', n: number) => ({
  tenantId: TENANT, userId: `7a000000-0000-4000-8000-00000000010${n}`, personId: `7a000000-0000-4000-8000-00000000020${n}`,
  roles: [role], grants: [{ role, companyId: null }],
});
const ROLES = [['employee', sessionFor('employee', 1)], ['manager', sessionFor('manager', 2)], ['hr_admin', sessionFor('hr_admin', 3)]] as const;
const OTHER_PERSON = sessionFor('employee', 9);
const now = Date.now();
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
const chatId = (n: number) => `7a000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;
/** Each login's own chats, as the owner would return them, newest first. The other person's are never asked for. */
function chatsOf(userId: string) {
  if (userId === OTHER_PERSON.userId) return [{ chatId: chatId(99), title: 'OTHER_PERSON_CHAT_TITLE', startedAt: at(1), lastMessageAt: at(0), expiresAt: at(-200), turns: 2, withheldTurns: 0 }];
  return [
    { chatId: chatId(1), title: 'Import leave balances', startedAt: at(2), lastMessageAt: at(0.1), expiresAt: at(-700), turns: 4, withheldTurns: 0 },
    { chatId: chatId(2), title: null, startedAt: at(25), lastMessageAt: at(24), expiresAt: at(-600), turns: 1, withheldTurns: 1 },
    { chatId: chatId(3), title: 'Who is away next week', startedAt: at(26), lastMessageAt: at(24.5), expiresAt: at(-600), turns: 2, withheldTurns: 0 },
    { chatId: chatId(4), title: 'Overtime trend, Penang plant', startedAt: at(130), lastMessageAt: at(120), expiresAt: at(-500), turns: 3, withheldTurns: 0 },
  ];
}
const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" timeZone="Asia/Kuala_Lumpur" messages={enWithAiCentre as never}>{node}</NextIntlClientProvider>;
async function showAsk(searchParams: Record<string, string> = {}) {
  const tree = await AssistantPage({ searchParams: Promise.resolve(searchParams) });
  return render(wrap(tree));
}

beforeEach(() => {
  state.session = ROLES[0][1]; state.path = '/assistant'; state.groupAdmin = false; state.route = { route: 'closed' }; state.importKinds = [];
  for (const fn of [state.push, state.refresh, state.listOwnChats, state.readChatRetention, state.legacyList, state.workspace, state.listChats, state.deleteChat, state.setRetention, state.openStoredChat, state.askWorkspace, state.askLauncher]) fn.mockReset();
  state.legacyList.mockResolvedValue({chats:[],nextCursor:null,scopeDigest:'fixture'});
  state.workspace.mockResolvedValue({access:{allowed:true},history:[],jobModules:[],taskIds:[],planningPermit:null,planningAvailability:'resting',proposal:null,governedJob:null});
  state.listOwnChats.mockImplementation(async (ctx: { userId: string }) => ({ chats: chatsOf(ctx.userId), nextCursor: null }));
  state.readChatRetention.mockResolvedValue({ keepDays: 7, version: 3, changedAt: at(48) });
  state.listChats.mockResolvedValue({ ok: true, chats: [], nextCursor: null });
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/assistant');
});
afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });

describe('Chats grouping (lib/ai-centre/chat-groups.ts)', () => {
  it('groups by Kuala Lumpur day, in the owner order, and searches the visible label', () => {
    expect(previousDay('2026-11-01')).toBe('2026-10-31');
    expect(chatGroupOf('2026-11-03T15:59:00Z', '2026-11-03')).toBe('today'); // 23:59 in Kuala Lumpur
    expect(chatGroupOf('2026-11-02T16:00:00Z', '2026-11-03')).toBe('today'); // 00:00 in Kuala Lumpur
    expect(chatGroupOf('2026-11-02T15:59:00Z', '2026-11-03')).toBe('yesterday');
    expect(chatGroupOf('2026-10-30T01:00:00Z', '2026-11-03')).toBe('earlier');
    expect(chatGroupOf('not a time', '2026-11-03')).toBe('earlier');
    const rows = [{ id: 'a', lastMessageAt: '2026-11-03T01:00:00Z' }, { id: 'b', lastMessageAt: '2026-10-01T01:00:00Z' }, { id: 'c', lastMessageAt: '2026-11-02T03:00:00Z' }];
    expect(groupChats(rows, '2026-11-03').map(group => [group.group, group.chats.map(row => row.id)])).toEqual([['today', ['a']], ['yesterday', ['c']], ['earlier', ['b']]]);
    expect(matchesChatSearch('Overtime trend, Penang plant', '  PENANG ')).toBe(true);
    expect(matchesChatSearch('Overtime trend', 'leave')).toBe(false);
    expect(matchesChatSearch('Anything', '')).toBe(true);
  });
});

describe.each(ROLES)('Ask is chat-only for %s', (_role, session) => {
  beforeEach(() => { state.session = session; });

  it('lists only this person\'s chats, grouped, with a withheld chat that keeps no words', async () => {
    await showAsk();
    // Isolation: the owner is asked once, for the session's own login and scope; nothing posted names anyone else.
    expect(state.listOwnChats).toHaveBeenCalledTimes(1);
    expect(state.listOwnChats.mock.calls[0][0]).toEqual(session);
    expect(state.listOwnChats.mock.calls[0][2]).toBe('["c0000000-0000-4000-8000-000000000001"]');
    expect(document.body.textContent).not.toContain('OTHER_PERSON_CHAT_TITLE');
    const column = screen.getByRole('complementary', { name: ask.chats });
    expect(column.className).toContain('max-lg:hidden');
    const groups = within(column).getAllByRole('heading', { level: 3 }).map(h => h.textContent);
    expect(groups).toEqual([ask.groups.today, ask.groups.yesterday, ask.groups.earlier]);
    const links = within(column).getAllByRole('link').filter(link => link.getAttribute('href')?.startsWith('/assistant?chat='));
    expect(links.map(link => [link.getAttribute('href'), link.textContent])).toEqual([
      [`/assistant?chat=${chatId(1)}`, 'Import leave balances'],
      [`/assistant?chat=${chatId(2)}`, ask.withheldTitle + ask.withheldNote],
      [`/assistant?chat=${chatId(3)}`, 'Who is away next week'],
      [`/assistant?chat=${chatId(4)}`, 'Overtime trend, Penang plant'],
    ]);
    expect(ask.withheldNote).toBe('Passed to HR · no words kept');
    expect(within(column).getByRole('link', { name: ask.newChat }).getAttribute('href')).toMatch(/^\/assistant\?chatReset=[0-9a-f-]{36}$/);
    // Nothing is open, so there is nothing to delete.
    expect(screen.queryByRole('button', { name: ask.deleteChat })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: ask.newConversation })).toBeTruthy();
  });

  it('searches the list and says when nothing matches', async () => {
    await showAsk();
    const column = screen.getByRole('complementary', { name: ask.chats });
    fireEvent.change(within(column).getByRole('searchbox', { name: ask.search }), { target: { value: 'penang' } });
    expect(within(column).getAllByRole('link').filter(link => link.getAttribute('href')?.startsWith('/assistant?chat=')).map(link => link.textContent)).toEqual(['Overtime trend, Penang plant']);
    expect(within(column).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([ask.groups.earlier]);
    fireEvent.change(within(column).getByRole('searchbox', { name: ask.search }), { target: { value: 'payroll close' } });
    expect(within(column).getByRole('status')).toHaveTextContent(ask.noMatches);
  });

  it('pins the composer under a conversation that scrolls on its own, with the footer and More tools', async () => {
    await showAsk();
    const log = screen.getByRole('log');
    expect(log.className).toContain('overflow-y-auto');
    expect(log.className).toContain('flex-1');
    const composer = screen.getByRole('textbox', { name: enWithAiCentre.assistant.workspace.question }).closest('fieldset')!;
    expect(composer.className).toContain('shrink-0');
    expect(log.contains(composer)).toBe(false);
    expect(log.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const column = screen.getByRole('complementary', { name: ask.chats });
    expect(within(column).getByText(tr('keptFor', { days: 7 }))).toBeTruthy();
    expect(tr('keptFor', { days: 7 })).toBe('Chats are kept for 7 days, then deleted.');
    expect(within(column).getByRole('link', { name: ask.privacyLink }).getAttribute('href')).toBe('/assistant?view=privacy');
    expect(within(column).getByRole('link', { name: ask.moreTools }).getAttribute('href')).toBe('/assistant?view=tools');
    // What used to sit on Ask is not on it any more.
    for (const tool of ['module-jobs', 'explore-patterns', 'review-an-action']) expect(document.querySelector(`[data-tool="${tool}"]`)).toBeNull();
    expect(document.querySelector('[data-privacy]')).toBeNull();
    expect(screen.queryByText(enWithAiCentre.assistant.workspace.chat.tools)).toBeNull();
  });

  it('reopens a stored chat from its link, marks it current and offers Delete', async () => {
    state.openStoredChat.mockResolvedValueOnce({ ok: true, chatId: chatId(3), turns: [{ id: `teras-chat-${chatId(3)}-1`, question: 'Who is away next week?', answer: <p>Two people in your team are away next week.</p> }], conversationToken: 'tc1.fixture' });
    await showAsk({ chat: chatId(3) });
    expect(state.openStoredChat).toHaveBeenCalledWith({ chatId: chatId(3) });
    const column = screen.getByRole('complementary', { name: ask.chats });
    expect(within(column).getByRole('link', { name: 'Who is away next week' }).getAttribute('aria-current')).toBe('page');
    expect(within(column).getByRole('link', { name: 'Import leave balances' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Who is away next week' })).toBeTruthy();
    expect(screen.getByRole('log')).toHaveTextContent('Two people in your team are away next week.');
    expect(screen.getByRole('button', { name: ask.deleteChat })).toBeTruthy();
  });

  it('deletes the open chat only after confirmation, then starts a new chat', async () => {
    state.openStoredChat.mockResolvedValue({ ok: true, chatId: chatId(1), turns: [{ id: 't1', question: 'help me import data', answer: <p>Which data is it?</p> }] });
    await showAsk({ chat: chatId(1) });
    fireEvent.click(screen.getByRole('button', { name: ask.deleteChat }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(ask.deleteTitle);
    expect(dialog).toHaveTextContent(ask.deleteBody);
    fireEvent.click(within(dialog).getByRole('button', { name: enWithAiCentre.components.confirmSubmit.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.deleteChat).not.toHaveBeenCalled();
    // A refusal keeps the chat and says so.
    state.deleteChat.mockResolvedValueOnce({ ok: false, code: 'unavailable' });
    fireEvent.click(screen.getByRole('button', { name: ask.deleteChat }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: ask.deleteConfirm }));
    expect(await screen.findByText(ask.deleteFailed)).toBeTruthy();
    expect(state.push).not.toHaveBeenCalled();
    state.deleteChat.mockResolvedValueOnce({ ok: true, deleted: 1 });
    fireEvent.click(screen.getByRole('button', { name: ask.deleteChat }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: ask.deleteConfirm }));
    await waitFor(() => expect(state.push).toHaveBeenCalledTimes(1));
    expect(state.deleteChat).toHaveBeenLastCalledWith({ chatId: chatId(1) });
    expect(state.push.mock.calls[0][0]).toMatch(/^\/assistant\?chatReset=[0-9a-z-]+$/);
    const column = screen.getByRole('complementary', { name: ask.chats });
    expect(within(column).queryByRole('link', { name: 'Import leave balances' })).toBeNull();
  });

  it('shows a chat the conversation just stored, from the owner\'s list, and offers Delete for it', async () => {
    state.askWorkspace.mockResolvedValueOnce({ ok: true, exchangeId: 'teras-turn-1', conversationToken: 'tc1.next', chatId: chatId(7), answer: <p>You have 13.25 days of Annual Leave.</p> });
    state.listChats.mockResolvedValueOnce({ ok: true, nextCursor: null, chats: [{ chatId: chatId(7), title: 'How much leave do I have?', startedAt: at(0).toISOString(), lastMessageAt: at(0).toISOString(), expiresAt: at(-100).toISOString(), turns: 1, withheldTurns: 0 }] });
    await showAsk();
    fireEvent.change(screen.getByRole('textbox', { name: enWithAiCentre.assistant.workspace.question }), { target: { value: 'How much leave do I have?' } });
    fireEvent.click(screen.getByRole('button', { name: enWithAiCentre.assistant.ask }));
    await screen.findByText('You have 13.25 days of Annual Leave.');
    expect(state.askWorkspace).toHaveBeenCalledWith({ question: 'How much leave do I have?' });
    await waitFor(() => expect(state.listChats).toHaveBeenCalledWith({}));
    const column = screen.getByRole('complementary', { name: ask.chats });
    expect((await within(column).findByRole('link', { name: 'How much leave do I have?' })).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: ask.deleteChat })).toBeTruthy();
  });

  it('on phones opens the Chats column as a drawer, and keeps Your data and privacy under the composer', async () => {
    await showAsk();
    const footer = document.querySelector('[data-ask-conversation] [data-ask-chats-footer]')!;
    expect(footer.className).toContain('lg:hidden');
    expect(within(footer as HTMLElement).getByRole('link', { name: ask.privacyLink }).getAttribute('href')).toBe('/assistant?view=privacy');
    const open = screen.getByRole('button', { name: ask.chats });
    expect(open.className).toContain('lg:hidden');
    expect(open.className).toContain('min-h-11');
    fireEvent.click(open);
    const drawer = await screen.findByRole('dialog', { name: ask.chats });
    expect(within(drawer).getByRole('searchbox', { name: ask.search })).toBeTruthy();
    const chat = within(drawer).getByRole('link', { name: 'Who is away next week' });
    expect(chat.className).toContain('min-h-11');
    expect(within(drawer).getByRole('link', { name: ask.privacyLink })).toBeTruthy();
    fireEvent.click(chat);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: ask.chats })).toBeNull(), { timeout: 2000 });
  });

  it('reaches Your data and privacy within two clicks of any AI Centre page', async () => {
    // Click 1: the Ask tab is on every AI Centre page; click 2: the link on Ask (column on desktop, under the composer on phones).
    const tabs = render(wrap(<AiCentreTabs active="how" isAdmin={session.roles[0] === 'hr_admin'} />));
    expect(screen.getByRole('link', { name: enWithAiCentre.aiCentre.tabs.ask }).getAttribute('href')).toBe('/assistant');
    tabs.unmount();
    await showAsk();
    expect(screen.getAllByRole('link', { name: ask.privacyLink }).map(link => link.getAttribute('href'))).toEqual(['/assistant?view=privacy', '/assistant?view=privacy']);
    cleanup();
    await showAsk({ view: 'privacy' });
    expect(screen.getByRole('heading', { level: 2, name: ask.privacy.title })).toBeTruthy();
    expect(document.querySelector('[data-privacy="history"]')).toBeTruthy();
    for (const kind of ['feedback', 'ratings', 'proposals', 'conversation']) expect(document.querySelector(`[data-privacy="own-${kind}"]`)).toBeTruthy();
    expect(screen.getByText(tr('keptFor', { days: 7 }))).toBeTruthy();
    // An erasure's redirect (/assistant?historyPrivacy=…) opens the same view, so its outcome is shown.
    cleanup();
    await showAsk({ historyPrivacy: 'retired', chatReset: 'x' });
    expect(document.querySelector('[data-ai-centre="privacy"]')).toBeTruthy();
  });

  it('moves the shortcuts and tools to More tools', async () => {
    await showAsk({ view: 'tools' });
    expect(state.readChatRetention).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: ask.tools.title })).toBeTruthy();
    expect(document.querySelector('[data-tool="review-an-action"]')).toBeTruthy();
    expect(document.querySelector('[data-tool="module-jobs"]')).toBeTruthy();
    expect(screen.getByRole('link', { name: enWithAiCentre.assistant.home.tabs }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('log')).toBeNull();
  });
});

describe('Keep chats for (Administration › Setup › Assistant)', () => {
  it('uses the owner\'s list of values', () => {
    expect(KEEP_CHAT_OPTIONS).toEqual([1, 7, 30, 90, 180, 365]);
    expect(readFileSync('core/teras-chats.ts', 'utf8')).toContain('export const CHAT_KEEP_DAYS=Object.freeze([1,7,30,90,180,365] as const);');
  });

  it.each([['group administrator', true], ['HR administrator who is not a group administrator', false]] as const)('renders in Setup for a %s', async (_who, groupAdmin) => {
    state.groupAdmin = groupAdmin; state.readChatRetention.mockResolvedValue({ keepDays: 30, version: null, changedAt: null });
    render(wrap(await AiAssistantSection({ session: sessionFor('hr_admin', 3) as never, searchParams: Promise.resolve({}) })));
    const card = document.getElementById('ai-chat-retention')!;
    expect(within(card).getByText(ask.retention.title)).toBeTruthy();
    if (groupAdmin) {
      expect(within(card).getAllByRole('radio').map(radio => (radio as HTMLInputElement).value)).toEqual(['1', '7', '30', '90', '180', '365']);
      expect((within(card).getByRole('radio', { name: '30 days' }) as HTMLInputElement).checked).toBe(true);
    } else {
      expect(within(card).queryByRole('radio')).toBeNull();
      expect(within(card).queryByRole('button')).toBeNull();
      expect(card).toHaveTextContent(tr('retention.readOnly', { days: 30 }));
    }
  });

  it('a group administrator confirms a shorter value, told that older chats are deleted soon', async () => {
    state.setRetention.mockResolvedValueOnce({ ok: true, keepDays: 7, version: 4 });
    render(wrap(<ChatRetentionControl keepDays={30} mayChange />));
    const save = screen.getByRole('button', { name: ask.retention.save });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    fireEvent.click(save);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(tr('retention.confirmShorter', { days: 7 }));
    expect(tr('retention.confirmShorter', { days: 7 })).toContain('deleted soon');
    expect(state.setRetention).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: ask.retention.confirm }));
    expect(await screen.findByRole('status')).toHaveTextContent(tr('retention.saved', { days: 7 }));
    expect(state.setRetention).toHaveBeenCalledExactlyOnceWith({ keepDays: 7 });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('a longer value says it applies from the next message; cancelling or a refusal changes nothing', async () => {
    state.setRetention.mockResolvedValueOnce({ ok: false, code: 'not_administrator' });
    render(wrap(<ChatRetentionControl keepDays={30} mayChange />));
    fireEvent.click(screen.getByRole('radio', { name: '365 days' }));
    fireEvent.click(screen.getByRole('button', { name: ask.retention.save }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(tr('retention.confirmLonger', { days: 365 }));
    fireEvent.click(within(dialog).getByRole('button', { name: enWithAiCentre.components.confirmSubmit.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.setRetention).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: ask.retention.save }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: ask.retention.confirm }));
    expect(await screen.findByRole('alert')).toHaveTextContent(ask.retention.notAdministrator);
    expect(state.refresh).not.toHaveBeenCalled();
  });
});

describe('Ask AI Centre from the command bar', () => {
  const RECORD = '7a000000-0000-4000-8000-0000000004aa';
  const placeholder = enWithAiCentre.commandBar.placeholder;
  const showShell = (available = true, launcher = true) => render(wrap(<>
    <AiAskAvailability available={available}><CommandBar /></AiAskAvailability>
    {launcher && <AssistantLauncher position="bottom-right" hiddenAreas={[]} />}
  </>));
  const type = (value: string) => fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
  const enter = () => fireEvent.keyDown(screen.getByPlaceholderText(placeholder), { key: 'Enter' });

  it('opens with ⌘K and Ctrl+K', () => {
    showShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
    cleanup(); showShell();
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
  });

  it.each(ROLES)('for %s, sends the words with this page\'s area to the side panel, which continues its chat and runs nothing', async (_role, session) => {
    state.session = session; state.path = `/leave/${RECORD}`;
    const confirm = vi.fn();
    state.askLauncher
      .mockResolvedValueOnce({ ok: true, exchangeId: 'teras-1', conversationToken: 'tc1.first', chatId: chatId(11), answer: <div><p>Prepared: Annual Leave, Thu 13 to Fri 14 Nov.</p><button type="button" onClick={confirm}>Confirm</button></div> })
      .mockResolvedValueOnce({ ok: true, exchangeId: 'teras-2', conversationToken: 'tc1.second', chatId: chatId(11), answer: <p>It would leave you 11.25 days.</p> });
    showShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    type('Apply annual leave for 13 and 14 November');
    const row = document.querySelector('[data-command-bar-ask]') as HTMLElement;
    expect(within(row).getByRole('button', { name: new RegExp(ask.commandBar.title) })).toHaveTextContent('Apply annual leave for 13 and 14 November');
    expect(row).toHaveTextContent('On this page: Leave');
    expect(row).toHaveTextContent(ask.commandBar.hint);
    enter();
    // The bar closes; the side panel opens docked and shows the prepared card with its Confirm, which nothing pressed.
    await waitFor(() => expect(screen.queryByPlaceholderText(placeholder)).toBeNull());
    expect(await screen.findByText('Prepared: Annual Leave, Thu 13 to Fri 14 Nov.')).toBeTruthy();
    const panel = screen.getByRole('dialog', { name: enWithAiCentre.aiCentre.genericName });
    expect(panel.className).toContain('inset-y-0');
    expect(state.askLauncher).toHaveBeenCalledExactlyOnceWith({ question: 'Apply annual leave for 13 and 14 November', path: `/leave/${RECORD}` });
    expect(within(panel).getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    expect(within(panel).getByRole('link', { name: enWithAiCentre.assistant.launcher.openInAssistant }).getAttribute('href')).toBe(`/assistant?chat=${chatId(11)}`);
    // A second question from the bar continues the same chat.
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    type('How many days would I have left?');
    enter();
    expect(await screen.findByText('It would leave you 11.25 days.')).toBeTruthy();
    expect(state.askLauncher).toHaveBeenLastCalledWith({ question: 'How many days would I have left?', path: `/leave/${RECORD}`, previousExchangeId: 'teras-1', previousConversationToken: 'tc1.first' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('tells the person when the panel is still answering', async () => {
    state.path = '/leave';
    let finish: (value: unknown) => void = () => {};
    state.askLauncher.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    showShell();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    type('What is my leave balance?'); enter();
    await waitFor(() => expect(state.askLauncher).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    type('And next year?'); enter();
    expect(await screen.findByText(ask.commandBar.busy)).toBeTruthy();
    expect(state.askLauncher).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ ok: true, exchangeId: 'x', answer: <p>12 days.</p> }); });
  });

  it('where no panel takes it, carries the question to a new Ask chat without putting it in the address', async () => {
    state.path = '/performance';
    showShell(true, false);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    type('Who has a review due this month?'); enter();
    expect(state.push).toHaveBeenCalledTimes(1);
    expect(state.push.mock.calls[0][0]).toMatch(/^\/assistant\?chatReset=[0-9a-z]+$/);
    expect(state.push.mock.calls[0][0]).not.toContain('review');
    expect(JSON.parse(window.sessionStorage.getItem(ASK_HANDOFF_KEY)!).q).toBe('Who has a review due this month?');
    expect(state.askLauncher).not.toHaveBeenCalled();
  });

  it('is not offered to a login without the Assistant: the bar is the old search', () => {
    state.path = '/leave';
    showShell(false);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    type('Apply annual leave for tomorrow');
    expect(document.querySelector('[data-command-bar-ask]')).toBeNull();
    enter();
    expect(state.askLauncher).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(ASK_HANDOFF_KEY)).toBeNull();
  });

  it('on Ask, sends the question into the open chat', async () => {
    state.path = '/assistant';
    state.askWorkspace.mockResolvedValueOnce({ ok: true, exchangeId: 'teras-9', conversationToken: 'tc1.ask', answer: <p>Payroll closes on 25 November.</p> });
    render(wrap(<>
      <AiAskAvailability available><CommandBar /></AiAskAvailability>
      <AssistantLauncher position="bottom-right" hiddenAreas={[]} />
      <WorkspaceConversation tasks={[]} fileImport={false} fullHeight fill acceptCommandBar />
    </>));
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    type('When does payroll close?');
    expect(document.querySelector('[data-command-bar-ask]')).not.toHaveTextContent('On this page');
    enter();
    expect(await screen.findByText('Payroll closes on 25 November.')).toBeTruthy();
    expect(state.askWorkspace).toHaveBeenCalledExactlyOnceWith({ question: 'When does payroll close?' });
    expect(state.askLauncher).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
  });
});

describe('AI v2 slice 3: the paperclip in Ask (imports inside the chat)', () => {
  const attach = (enWithAiCentre as unknown as { chatImport: { attach: string } }).chatImport.attach;
  it('is there for an HR administrator whose chat runs through the harness and who may import here, and for no one else', async () => {
    state.route = { route: 'harness', permit: {}, attestedProvider: null, explainers: false };
    state.importKinds = [{ kind: 'leave_balances' }];
    for (const [role, session] of ROLES) {
      cleanup(); state.session = session;
      await showAsk();
      if (role === 'hr_admin') expect(screen.getByLabelText(attach, { selector: 'input' }), role).toHaveAttribute('type', 'file');
      else expect(screen.queryByLabelText(attach), role).toBeNull();
    }
    // The closed grammar keeps its own file preparation; the chat import's paperclip is not offered there.
    cleanup(); state.session = ROLES[2][1]; state.route = { route: 'closed' };
    await showAsk();
    expect(screen.queryByLabelText(attach, { selector: 'input[accept*=".txt"]' })).toBeNull();
  });
});

// Ask keeps its displayed retention setting, without a second unused history payload.
it('Ask keeps the visible retention setting and loads history through its chat owners', async()=>{
 await AssistantPage({searchParams:Promise.resolve({})});
 expect(state.readChatRetention).toHaveBeenCalledTimes(1);
 expect(state.workspace).toHaveBeenCalledWith(state.session,expect.objectContaining({includeHistory:false,includeGovernance:false}));
 expect(state.listOwnChats).toHaveBeenCalledTimes(1);
});
it('starts the stored chat list while the independent legacy list is still pending', async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 state.legacyList.mockImplementation(async()=>{await gate;return {chats:[],nextCursor:null};});
 const page=AssistantPage({searchParams:Promise.resolve({})});
 try{await vi.waitFor(()=>expect(state.listOwnChats).toHaveBeenCalledTimes(1));}
 finally{release();}
 await page;
});
