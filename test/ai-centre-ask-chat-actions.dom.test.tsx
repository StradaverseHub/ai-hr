/** @vitest-environment jsdom */
/** AI v2 Phase 1, W4 — isolation at the stored-chat commands the Ask Chats column and "Keep chats for" call
 * (app/assistant/chat-actions.ts). Whatever a browser posts, the commands act for the session's own login only and
 * pass nothing posted but the chat id, cursor or value; refusals come back as closed codes. The owner's own row-level
 * isolation is proved on the database by test/teras-chats.test.ts. Fictional stand-ins for the session and owner. */
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: { tenantId: '7b000000-0000-4000-8000-000000000001', userId: '7b000000-0000-4000-8000-000000000002', roles: ['employee'], grants: [] },
  list: vi.fn(), remove: vi.fn(), set: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../lib/session', () => ({ getBrowserCommandSession: async () => state.session }));
vi.mock('../app/assistant/conversation-scope', () => ({ assistantBrowserConversationScope: async () => '["7b000000-0000-4000-8000-0000000000c1"]' }));
vi.mock('../core/teras-chats', () => {
  class ChatRetentionRefused extends Error { constructor(readonly reason: 'not_administrator' | 'invalid') { super(reason); } }
  return { ChatRetentionRefused, listOwnChats: state.list, deleteOwnChat: state.remove, setChatRetention: state.set, eraseOwnChats: vi.fn(), readChatRetention: vi.fn() };
});
import { deleteChatAction, listChatsAction, setChatRetentionAction } from '../app/assistant/chat-actions';
import { ChatRetentionRefused } from '../core/teras-chats';

const OTHER = { userId: '7b000000-0000-4000-8000-000000000099', tenantId: '7b000000-0000-4000-8000-000000000098', scope: '["other"]' };
beforeEach(() => { state.list.mockReset(); state.remove.mockReset(); state.set.mockReset(); });

it('lists the session\'s own chats only, ignoring any posted login, tenant or scope', async () => {
  state.list.mockResolvedValueOnce({ chats: [{ chatId: '7b000000-0000-4000-8000-0000000000a1', title: 'Mine', startedAt: new Date('2026-11-03T01:00:00Z'), lastMessageAt: new Date('2026-11-03T02:00:00Z'), expiresAt: new Date('2026-12-03T02:00:00Z'), turns: 2, withheldTurns: 0 }], nextCursor: null });
  const page = await listChatsAction({ cursor: undefined, ...OTHER } as never);
  expect(state.list).toHaveBeenCalledExactlyOnceWith(state.session, { cursor: undefined }, '["7b000000-0000-4000-8000-0000000000c1"]');
  expect(page).toEqual({ ok: true, nextCursor: null, chats: [{ chatId: '7b000000-0000-4000-8000-0000000000a1', title: 'Mine', startedAt: '2026-11-03T01:00:00.000Z', lastMessageAt: '2026-11-03T02:00:00.000Z', expiresAt: '2026-12-03T02:00:00.000Z', turns: 2, withheldTurns: 0 }] });
});

it('deletes for the session only; an owner failure is a closed code, never its message', async () => {
  state.remove.mockResolvedValueOnce(0);
  expect(await deleteChatAction({ chatId: '7b000000-0000-4000-8000-0000000000a2', ...OTHER } as never)).toEqual({ ok: true, deleted: 0 });
  expect(state.remove).toHaveBeenCalledExactlyOnceWith(state.session, '7b000000-0000-4000-8000-0000000000a2');
  state.remove.mockRejectedValueOnce(new Error('relation "teras_chat" secret detail'));
  expect(await deleteChatAction({ chatId: '7b000000-0000-4000-8000-0000000000a2' })).toEqual({ ok: false, code: 'unavailable' });
});

it('"Keep chats for" passes only the value; the owner\'s refusal comes back as its reason', async () => {
  state.set.mockRejectedValueOnce(new ChatRetentionRefused('not_administrator'));
  expect(await setChatRetentionAction({ keepDays: 7, userId: OTHER.userId } as never)).toEqual({ ok: false, code: 'not_administrator' });
  expect(state.set).toHaveBeenCalledExactlyOnceWith(state.session, { keepDays: 7 });
  state.set.mockRejectedValueOnce(new Error('connection reset'));
  expect(await setChatRetentionAction({ keepDays: 7 })).toEqual({ ok: false, code: 'unavailable' });
});
