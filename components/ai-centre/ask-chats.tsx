'use client';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {CentreNavigationLink} from './centre-navigation-link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MessageSquareText, Plus, Search, Trash2 } from 'lucide-react';
import { deleteChatAction, listChatsAction } from '@/app/assistant/chat-actions';
import { Drawer } from '@/components/ui/drawer';
import { ConfirmDialog } from '@/components/ui/confirm-submit';
import { groupChats, matchesChatSearch } from '@/lib/ai-centre/chat-groups';
import { cn } from '@/lib/utils';
import { AskChatsContext, type AskChatsLink } from './ask-chats-context';

/** AI v2 Phase 1, W4 (issue 14) — Ask's Chats column, from the approved mock-up (Ask.dc.html): search, New chat,
 * the person's stored chats grouped Today / Yesterday / Earlier, a withheld chat as "Passed to HR · no words
 * kept", the open chat's Delete with a confirmation, and the footer "Chats are kept for N days" with the link
 * to Your data and privacy. On phones the column is a drawer opened from the conversation's header.
 *
 * Everything comes from the stored-chat owner through the existing commands (app/assistant/chat-actions.ts →
 * core/teras-chats.ts): the session decides whose chats these are and the owner re-checks scope and access, so
 * this component never names a user, a tenant or a scope. Reopening is a link to /assistant?chat=<id>, which
 * the page reopens through the owner again. */
export type AskChatSummary = { chatId: string; title: string | null; lastMessageAt: string; turns: number; withheldTurns: number };

type State = {
  chats: AskChatSummary[];
  nextCursor: string | null;
  activeChatId: string | null;
  activeTitle: string | null;
  today: string;
  keepDays: number | null;
  newChatHref: string;
  privacyHref: string;
  toolsHref: string;
  listUnavailable: boolean;
  legacy: ReactNode;
  query: string;
  setQuery: (value: string) => void;
  loadingMore: boolean;
  loadMore: () => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  requestDelete: () => void;
  status: string | null;
};

const AskChatsState = createContext<State | null>(null);
function useAskChats(): State {
  const state = useContext(AskChatsState);
  if (!state) throw new Error('AskChats components need <AskChatsProvider>.');
  return state;
}

const freshNonce = () => {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch { /* fall through */ }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
};

const distinct = (rows: readonly AskChatSummary[]) => {
  const seen = new Set<string>();
  return rows.filter(row => (seen.has(row.chatId) ? false : (seen.add(row.chatId), true)));
};

export function AskChatsProvider({ initialChats, nextCursor, activeChatId, activeTitle = null, today, keepDays, newChatHref, privacyHref, toolsHref, listUnavailable = false, legacy, children }: {
  initialChats: readonly AskChatSummary[];
  nextCursor: string | null;
  /** The stored chat the page opened (?chat=), re-read by the owner; null for a new conversation. */
  activeChatId: string | null;
  /** The title of a conversation the column does not list (a saved closed-grammar chat opened with ?e=). */
  activeTitle?: string | null;
  /** Kuala Lumpur day of the server render (lib/hr-date.ts), so the browser groups as the server did. */
  today: string;
  /** The tenant's "Keep chats for", or null when it could not be read. */
  keepDays: number | null;
  newChatHref: string;
  privacyHref: string;
  toolsHref: string;
  listUnavailable?: boolean;
  /** Earlier saved conversations of the closed grammar (components/assistant/saved-chat-list.tsx), kept reachable. */
  legacy?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('aiAsk');
  const router = useRouter();
  const [chats, setChats] = useState(() => distinct(initialChats));
  const [cursor, setCursor] = useState(nextCursor);
  const [active, setActive] = useState(activeChatId);
  const [query, setQuery] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const alive = useRef(true), epoch = useRef(0), busy = useRef(false);
  // A server render (navigation, a deletion's revalidation) is authoritative: it replaces what the browser holds.
  const signature = JSON.stringify([initialChats, nextCursor, activeChatId, newChatHref]);
  useEffect(() => {
    epoch.current++; busy.current = false; setLoadingMore(false);
    setChats(distinct(initialChats)); setCursor(nextCursor); setActive(activeChatId); setStatus(null); setConfirming(false); setDrawerOpen(false);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);

  // The conversation reports the stored chat its reply joined; the first page is re-read from the owner so a new
  // chat appears at the top with the title the owner keeps (never the words held in the browser).
  const storedChat = useCallback((chatId: string) => {
    setActive(chatId);
    const at = ++epoch.current;
    void listChatsAction({}).then(page => {
      if (!alive.current || at !== epoch.current || !page.ok) return;
      setChats(rows => distinct([...page.chats.map(row => ({ chatId: row.chatId, title: row.title, lastMessageAt: row.lastMessageAt, turns: row.turns, withheldTurns: row.withheldTurns })), ...rows]));
      setCursor(current => current ?? page.nextCursor);
    }).catch(() => { /* The list stays as it was; the reply was already shown. */ });
  }, []);
  const link = useMemo<AskChatsLink>(() => ({ storedChat }), [storedChat]);

  const loadMore = useCallback(() => {
    if (!cursor || busy.current) return;
    busy.current = true; setLoadingMore(true); setStatus(null);
    const at = epoch.current;
    void listChatsAction({ cursor }).then(page => {
      if (!alive.current || at !== epoch.current) return;
      if (!page.ok) { setStatus(t('listUnavailable')); return; }
      setChats(rows => distinct([...rows, ...page.chats.map(row => ({ chatId: row.chatId, title: row.title, lastMessageAt: row.lastMessageAt, turns: row.turns, withheldTurns: row.withheldTurns }))]));
      setCursor(page.nextCursor);
    }).catch(() => { if (alive.current && at === epoch.current) setStatus(t('listUnavailable')); })
      .finally(() => { if (alive.current && at === epoch.current) { busy.current = false; setLoadingMore(false); } });
  }, [cursor, t]);

  async function confirmDelete() {
    const chatId = active;
    setConfirming(false);
    if (!chatId) return;
    try {
      const result = await deleteChatAction({ chatId });
      if (!alive.current) return;
      if (!result.ok) { setStatus(t('deleteFailed')); return; }
      // Deleted now, or already gone: either way the chat is not the person's any more. Ask starts a new chat.
      setChats(rows => rows.filter(row => row.chatId !== chatId));
      setActive(null);
      setStatus(t('deleted'));
      // Always a fresh address: the conversation remounts empty, so nothing of the deleted chat stays on screen or
      // continues it (a continued turn would start a new stored chat under the same id).
      router.push('/assistant?chatReset=' + freshNonce());
    } catch { if (alive.current) setStatus(t('deleteFailed')); }
  }

  const activeSummary = chats.find(chat => chat.chatId === active) ?? null;
  const value: State = {
    chats, nextCursor: cursor, activeChatId: active, activeTitle: activeSummary ? labelOf(activeSummary, key => t(key)) : active ? null : activeTitle,
    today, keepDays, newChatHref, privacyHref, toolsHref, listUnavailable, legacy, query, setQuery, loadingMore, loadMore,
    drawerOpen, setDrawerOpen, requestDelete: () => { setStatus(null); setConfirming(true); }, status,
  };
  return <AskChatsState.Provider value={value}><AskChatsContext.Provider value={link}>
    {children}
    {confirming && <ConfirmDialog title={t('deleteTitle')} description={t('deleteBody')} confirmLabel={t('deleteConfirm')} onConfirm={() => void confirmDelete()} onCancel={() => setConfirming(false)}/>}
  </AskChatsContext.Provider></AskChatsState.Provider>;
}

/** A chat whose every turn was withheld has no words to show: the owner returns no title for it. */
const isWithheld = (chat: AskChatSummary) => chat.title === null && chat.withheldTurns > 0;
function labelOf(chat: AskChatSummary, t: (key: string) => string): string {
  return chat.title ?? (isWithheld(chat) ? t('withheldTitle') : t('untitled'));
}

/** The column's content: used in the desktop column and in the phone drawer. */
function ChatsPanel({ onNavigate }: { onNavigate?: () => void }) {
  const t = useTranslations('aiAsk');
  const s = useAskChats();
  const label = (chat: AskChatSummary) => labelOf(chat, key => t(key));
  const shown = s.chats.filter(chat => matchesChatSearch(label(chat), s.query));
  const groups = groupChats(shown, s.today);
  // One id per panel: the desktop column and the phone drawer each label their own search box.
  const searchId = useId();
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 space-y-2 pb-3">
      <Link href={s.newChatHref} scroll={false} onClick={onNavigate}
        className="inline-flex min-h-11 w-full items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Plus aria-hidden className="size-4"/>{t('newChat')}
      </Link>
      <label htmlFor={searchId} className="sr-only">{t('search')}</label>
      <div className="flex min-h-11 items-center gap-2 rounded-md border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
        <Search aria-hidden className="size-4 shrink-0 text-muted-foreground"/>
        <input id={searchId} type="search" value={s.query} onChange={event => s.setQuery(event.target.value)} placeholder={t('search')}
          className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"/>
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {s.listUnavailable && <p role="status" className="py-2 text-sm text-muted-foreground">{t('listUnavailable')}</p>}
      {!s.listUnavailable && s.chats.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t('noChats')}</p>}
      {s.chats.length > 0 && shown.length === 0 && <p role="status" className="py-2 text-sm text-muted-foreground">{t('noMatches')}</p>}
      {groups.map(({ group, chats }) => <section key={group} aria-labelledby={`${searchId}-${group}`} className="pb-2">
        <h3 id={`${searchId}-${group}`} className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{t(`groups.${group}`)}</h3>
        <ul className="space-y-0.5">{chats.map(chat => <li key={chat.chatId}>
          <Link href={'/assistant?chat=' + encodeURIComponent(chat.chatId)} scroll={false} onClick={onNavigate}
            aria-current={s.activeChatId === chat.chatId ? 'page' : undefined}
            className="flex min-h-11 flex-col justify-center rounded-md px-2 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-muted aria-[current=page]:font-medium">
            <span className="break-words">{label(chat)}</span>
            {isWithheld(chat) && <span className="text-xs text-muted-foreground">{t('withheldNote')}</span>}
          </Link>
        </li>)}</ul>
      </section>)}
      {s.nextCursor && <button type="button" disabled={s.loadingMore} onClick={s.loadMore}
        className="inline-flex min-h-11 items-center px-2 text-xs underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">{t('moreChats')}</button>}
      {s.legacy}
    </div>
    <div className="shrink-0 border-t border-border pt-2">
      <CentreNavigationLink intent={false} href={s.toolsHref} onClick={onNavigate} className="flex min-h-11 items-center px-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('moreTools')}</CentreNavigationLink>
      <AskChatsFooter onNavigate={onNavigate}/>
    </div>
  </div>;
}

/** "Chats are kept for N days, then deleted." and the link to Your data and privacy. */
export function AskChatsFooter({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const t = useTranslations('aiAsk');
  const s = useAskChats();
  return <p data-ask-chats-footer className={cn('px-2 pb-1 text-xs leading-relaxed text-muted-foreground', className)}>
    <span>{s.keepDays === null ? t('keptUnknown') : t('keptFor', { days: s.keepDays })}</span>{' '}
    <CentreNavigationLink intent={false} href={s.privacyHref} onClick={onNavigate} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('privacyLink')}</CentreNavigationLink>
  </p>;
}

/** The desktop Chats column (the page's <aside>). */
export function AskChatsColumn() {
  const t = useTranslations('aiAsk');
  return <div className="flex h-full min-h-0 flex-col">
    <h2 className="shrink-0 py-3 text-sm font-semibold">{t('chats')}</h2>
    <ChatsPanel/>
  </div>;
}

/** The conversation's header: on phones the Chats drawer button; the open chat's title; Delete chat. */
export function AskChatHeader() {
  const t = useTranslations('aiAsk');
  const s = useAskChats();
  const close = () => s.setDrawerOpen(false);
  return <><header className="flex shrink-0 items-center gap-2 border-b border-border pb-2">
    <button type="button" onClick={() => s.setDrawerOpen(true)} aria-haspopup="dialog"
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden">
      <MessageSquareText aria-hidden className="size-4"/>{t('chats')}
    </button>
    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{s.activeTitle ?? t('newConversation')}</h2>
    {s.activeChatId && <button type="button" onClick={s.requestDelete}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Trash2 aria-hidden className="size-4"/>{t('deleteChat')}
    </button>}
    <Drawer open={s.drawerOpen} onOpenChange={s.setDrawerOpen} title={t('chats')} width="narrow">
      <div className="flex h-full min-h-0 flex-col"><ChatsPanel onNavigate={close}/></div>
    </Drawer>
  </header>
  {s.status && <p role="status" className="shrink-0 pt-2 text-xs text-muted-foreground">{s.status}</p>}</>;
}
