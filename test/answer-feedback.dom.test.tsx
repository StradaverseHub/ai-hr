/** @vitest-environment jsdom */
/** AI v2 Phase 2 P2-6 — "Helpful / Not helpful" under each AI Centre reply (the coordinator's design, 3 November 2026),
 * rendered by the real ConversationReply that both the Ask view and the side panel show.
 *
 * Two icon buttons with no visible text, named "Helpful" and "Not helpful"; "Not helpful" records the mark and offers
 * "Wrong", "Not what I asked" and "Missing something" plus Cancel (the reason is optional); then a quiet "Thanks", with
 * "Change" while the choice may still be changed once. Each press posts to markAnswerAction for this turn. A routed,
 * refused or crisis turn shows no control at all. Six locales. The server action is a spy (its service is covered by
 * test/learning-loops.test.ts); fictional values only; no database. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { withAiCentre } from './helpers/ai-centre-messages';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi_ from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';

type Locale = 'en' | 'ms' | 'zh' | 'vi' | 'ta' | 'th';
const LOCALES = ['en', 'ms', 'zh', 'vi', 'ta', 'th'] as const;
const CATALOGUES = { en, ms, zh, vi: vi_, ta, th };
const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ms' | 'zh' | 'vi' | 'ta' | 'th' }));
const mark = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, prefetch: _prefetch, ...props }: any) => <a {...props}>{children}</a> }));
vi.mock('next/navigation', () => ({ usePathname: () => '/assistant', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const { withAiCentre: merge } = await import('./helpers/ai-centre-messages');
  const all = { en: (await import('../messages/en.json')).default, ms: (await import('../messages/ms.json')).default, zh: (await import('../messages/zh.json')).default,
    vi: (await import('../messages/vi.json')).default, ta: (await import('../messages/ta.json')).default, th: (await import('../messages/th.json')).default };
  return { getTranslations: async (namespace: any) => createTranslator({ locale: state.locale, messages: merge(state.locale, all[state.locale] as any) as any, namespace, onError: error => { throw error; } }),
    getFormatter: async () => createFormatter({ locale: state.locale, timeZone: 'Asia/Kuala_Lumpur' }), getLocale: async () => state.locale };
});
vi.mock('../app/assistant/learning-actions', () => ({ markAnswerAction: mark.action, recordCardSignalAction: vi.fn() }));
import { ConversationReply } from '../components/ai-centre/conversation-reply';

const messagesFor = (locale: Locale) => withAiCentre(locale, CATALOGUES[locale] as Record<string, unknown>) as Record<string, any>;
const turn = (over: Record<string, unknown> = {}) => ({ turnId: randomUUID(), reply: 'You have 12 days of annual leave.', mode: 'answer', slot: null, suggestion: null, proposals: [],
  reads: [], sensitive: false, refused: false, crisis: false, fallback: false, caseRoute: null, continuation: '', trace: null as never, modelTurn: [], ...over });
async function show(shown = turn(), locale: Locale = 'en') {
  state.locale = locale;
  render(<NextIntlClientProvider locale={locale} messages={messagesFor(locale) as never} onError={error => { throw error; }} timeZone="Asia/Kuala_Lumpur">
    {await ConversationReply({ turn: shown as never })}</NextIntlClientProvider>);
  return shown;
}
const copy = (locale: Locale) => messagesFor(locale).aiCentre.feedback as { label: string; helpful: string; notHelpful: string; reasonsLabel: string; cancel: string; thanks: string; change: string;
  reasons: Record<string, string> };
afterEach(() => { cleanup(); mark.action.mockReset(); state.locale = 'en'; });

describe('Helpful / Not helpful under a reply', () => {
  it('shows two icon buttons, with no visible text, named Helpful and Not helpful; nothing posts until a press', async () => {
    await show();
    const group = screen.getByRole('group', { name: 'Was this answer helpful?' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map(button => [button.getAttribute('aria-label'), button.textContent])).toEqual([['Helpful', ''], ['Not helpful', '']]);
    for (const button of buttons) { expect(button).toHaveAttribute('type', 'button'); expect(button.className).toContain('pointer-coarse:min-h-11'); expect(button.querySelector('svg')).toBeTruthy(); }
    expect(mark.action).not.toHaveBeenCalled();
  });

  it('Helpful posts the mark for this turn and gives way to a quiet Thanks, with Change while it may still change', async () => {
    const shown = await show();
    mark.action.mockResolvedValueOnce({ recorded: true, mark: 'helpful', canChange: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Helpful' })); });
    expect(mark.action.mock.calls).toEqual([[{ turnId: shown.turnId, helpful: true }]]);
    const thanks = screen.getByRole('status');
    expect(thanks.textContent).toBe('ThanksChange');
    expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
    // Changed once to Not helpful: the reasons follow, then Thanks with no Change left.
    fireEvent.click(within(thanks).getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute('aria-pressed', 'true');
    mark.action.mockResolvedValueOnce({ recorded: true, mark: 'unhelpful', canChange: false });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Not helpful' })); });
    expect(mark.action.mock.calls[1]).toEqual([{ turnId: shown.turnId, helpful: false }]);
    mark.action.mockResolvedValueOnce({ recorded: true, mark: 'unhelpful', canChange: false });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Missing something' })); });
    expect(mark.action.mock.calls[2]).toEqual([{ turnId: shown.turnId, helpful: false, reason: 'missing_something' }]);
    expect(screen.getByRole('status').textContent).toBe('Thanks');
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('Not helpful records the mark at once and offers three one-tap reasons and Cancel; the reason is optional', async () => {
    const shown = await show();
    mark.action.mockResolvedValue({ recorded: true, mark: 'unhelpful', canChange: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Not helpful' })); });
    expect(mark.action.mock.calls).toEqual([[{ turnId: shown.turnId, helpful: false }]]);
    const reasons = screen.getByRole('group', { name: 'What was wrong with it?' });
    expect(within(reasons).getAllByRole('button').map(button => button.textContent)).toEqual(['Wrong', 'Not what I asked', 'Missing something', 'Cancel']);
    for (const button of within(reasons).getAllByRole('button')) expect(button.className).toContain('pointer-coarse:min-h-11');
    // Cancel keeps the mark, without a reason: nothing more is posted.
    fireEvent.click(within(reasons).getByRole('button', { name: 'Cancel' }));
    expect(mark.action).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('ThanksChange');
    cleanup(); mark.action.mockClear();
    const again = await show();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Not helpful' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Wrong' })); });
    expect(mark.action.mock.calls).toEqual([[{ turnId: again.turnId, helpful: false }], [{ turnId: again.turnId, helpful: false, reason: 'wrong' }]]);
  });

  it.each([['a routed sensitive turn', { sensitive: true }], ['a refused turn', { refused: true }], ['a crisis turn', { crisis: true, sensitive: true }]] as const)(
    'shows no control at all on %s', async (_name, over) => {
      await show(turn(over));
      expect(screen.queryByRole('group', { name: 'Was this answer helpful?' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Helpful' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Not helpful' })).toBeNull();
      expect(document.querySelector('[data-answer-feedback]')).toBeNull();
    });

  it.each(LOCALES)('%s: every label is the locale\'s own and the reasons are its own', async locale => {
    const words = copy(locale);
    await show(turn(), locale);
    const group = screen.getByRole('group', { name: words.label });
    expect(within(group).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([words.helpful, words.notHelpful]);
    mark.action.mockResolvedValueOnce({ recorded: true, mark: 'unhelpful', canChange: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: words.notHelpful })); });
    const reasons = screen.getByRole('group', { name: words.reasonsLabel });
    expect(within(reasons).getAllByRole('button').map(button => button.textContent)).toEqual([words.reasons.wrong, words.reasons.not_what_asked, words.reasons.missing_something, words.cancel]);
    if (locale !== 'en') for (const key of ['helpful', 'notHelpful', 'thanks', 'cancel'] as const) expect(words[key], `${locale} ${key}`).not.toBe(copy('en')[key]);
    expect(document.body.textContent).not.toMatch(/Noveri/);
  });
});
