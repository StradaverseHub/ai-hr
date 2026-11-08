'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowUp, ChevronRight, Inbox, Maximize2, Minimize2, Sparkles, X } from 'lucide-react';
import { resolvePageContext, type PageArea } from '@/lib/ai/page-context';
import {AssistantChatBoundary} from './chat-reply-boundary';
import {ThinkingIndicator} from './thinking-indicator';
import { askFromLauncherAction } from '@/app/assistant/launcher-actions';
import { aiCentreName } from '@/lib/ai-centre/brand';
import { ASK_AI_CENTRE_EVENT, unclaimedAskQuestion } from '@/lib/command-bar-events';

type Turn = { id: number; question: string; area: PageArea | null; stale?: true; reply?: { ok: true; exchangeId: string; answer: React.ReactNode; conversationToken?: string; clarificationRequired?:true; chatId?: string } | { ok: false; message: string } };

/** The floating Assistant. Rendered only when the shell decided this login may see it (see
 * core/assistant-launcher.ts); every question still goes through the Assistant's own checks. It opens as a
 * small chat window and can be docked as a right-side panel. It knows the page's AREA and, at most, one
 * record id from the address, never what is on the screen. */
/** `inboxCount` (AI centre): the decision count the shell already read for the notification bell; the
 * launcher links to the Inbox and never reads anything itself. */
export function AssistantLauncher({ position, hiddenAreas, inboxCount }: { position: 'bottom-right' | 'bottom-left'; hiddenAreas: readonly PageArea[]; inboxCount?: number }) {
 const chatCopy=useTranslations('assistant.workspace.chat'),privacyNotice=chatCopy('privacy');
  const t = useTranslations('assistant.launcher'), areas = useTranslations('assistant.launcher.areas'), tCentre = useTranslations('aiCentre.launcher'), centreName = aiCentreName(useTranslations('aiCentre')('genericName'));
  const pathname = usePathname() ?? '/';
  const context = resolvePageContext(pathname);
  const [open, setOpen] = React.useState(false), [docked, setDocked] = React.useState(false);
  const [question, setQuestion] = React.useState(''), [turns, setTurns] = React.useState<Turn[]>([]), [pending, setPending] = React.useState(false),[uncertain,setUncertain]=React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null), box = React.useRef<HTMLTextAreaElement>(null), log = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const wasOpen = React.useRef(false);
  const followLatest = React.useRef(true);
  const nextTurnId = React.useRef(0);
  const inFlight = React.useRef(false);
  const pageGeneration = React.useRef(0);
  const awaitingClarification=React.useRef<string|null>(null);
  const previousExchange = React.useRef<{ path: string; id: string; token: string } | null>(null);
  React.useEffect(() => {
    // A new page starts a new context. A response arriving from the previous page may still be shown,
    // but must never silently become the parent of a question about this page.
    pageGeneration.current += 1;
    previousExchange.current = null;
    awaitingClarification.current=null;
    // Earlier turns stay readable (AI centre: one conversation across pages), marked with the page they were
    // asked on and disabled, so none of their cards or follow-ups can act in this page's context.
    setUncertain(false);setTurns(list=>list.slice(-10).map(turn=>turn.stale?turn:{...turn,stale:true}));
  }, [pathname]);
  React.useEffect(() => {
    if (open) box.current?.focus();
    // The button is re-mounted when the window closes, so focus returns after that render.
    else if (wasOpen.current) button.current?.focus();
    wasOpen.current = open;
  }, [open, docked]);
  React.useEffect(() => {
    if (followLatest.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns, open, docked]);
  // Never on the Assistant itself, outside the closed area list, or in an area the administrator hid.
  const hidden = pathname === '/assistant' || pathname.startsWith('/assistant/') || !context || hiddenAreas.includes(context.area);
  // AI v2 W4: a question typed in the command bar (lib/command-bar-events.ts) opens this panel docked and is sent as
  // if typed here, with this page's context and this panel's chat. A panel that cannot continue starts a new chat
  // (as its New chat would); one still answering tells the bar it is busy. Where the panel is hidden it takes nothing.
  const sendRef = React.useRef<(typed: string, fresh: boolean) => void>(() => {});
  const uncertainRef = React.useRef(uncertain); uncertainRef.current = uncertain;
  React.useEffect(() => {
    if (hidden) return;
    const onAsk = (event: Event) => {
      const claim = unclaimedAskQuestion(event);
      if (!claim) return;
      if (inFlight.current) { claim.detail.result = 'busy'; return; }
      claim.detail.result = 'sent';
      const fresh = uncertainRef.current;
      if (fresh) { pageGeneration.current++; previousExchange.current = null; awaitingClarification.current = null; setUncertain(false); setTurns([]); }
      followLatest.current = true; setOpen(true); setDocked(true);
      sendRef.current(claim.question, fresh);
    };
    window.addEventListener(ASK_AI_CENTRE_EVENT, onAsk);
    return () => window.removeEventListener(ASK_AI_CENTRE_EVENT, onAsk);
  }, [hidden]);
  if (hidden) return null;
  const close = () => setOpen(false);
  async function send(clarification?:{id:string;answer:string}, typed?:string, fresh=false) {
    const text = (clarification?.answer??typed??question).trim();
    if (!text || inFlight.current||(uncertain&&!fresh)) return;
    inFlight.current = true;
    const id = ++nextTurnId.current;
    const generation = pageGeneration.current;
    const previous = previousExchange.current?.path === pathname ? previousExchange.current : null;
    const clarificationId=clarification?.id??awaitingClarification.current;
    followLatest.current = true;
    setTurns(list => [...list, { id, question: text, area: context?.area ?? null }]);
    if(!clarification&&typed===undefined)setQuestion(''); setPending(true);
    try {
      const reply = await askFromLauncherAction({ question: text, path: pathname,
        ...(clarificationId?{clarificationExchangeId:clarificationId}:previous ? { previousExchangeId: previous.id, previousConversationToken: previous.token } : {}) });
      if (generation === pageGeneration.current) {
        previousExchange.current = reply.ok && reply.conversationToken ? { path: pathname, id: reply.exchangeId, token: reply.conversationToken } : null;
        awaitingClarification.current=reply.ok&&reply.clarificationRequired?reply.exchangeId:null;
        if(!reply.ok||(!reply.conversationToken&&!reply.clarificationRequired))setUncertain(true);
      }
      setTurns(list => list.map(turn => turn.id === id ? { ...turn, reply } : turn));
    } catch {
      if(generation===pageGeneration.current){previousExchange.current=null;awaitingClarification.current=null;setUncertain(true);}
      setTurns(list => list.map(turn => turn.id === id ? { ...turn, reply: { ok: false, message: t('failed') } } : turn));
    } finally { inFlight.current = false; setPending(false); }
  }
  sendRef.current = (typed, fresh) => { void send(undefined, typed, fresh); };
  const side = position === 'bottom-left' ? 'left-4' : 'right-4';
  return <AssistantChatBoundary value={{pending:pending||uncertain,setQuestionDraft:answer=>{if(inFlight.current||uncertain)return;awaitingClarification.current=null;setQuestion(answer);box.current?.focus();},clarify:async(id,answer)=>{await send({id,answer});},setClarificationDraft:(id,answer)=>{if(inFlight.current||uncertain)return;awaitingClarification.current=id;setQuestion(answer);box.current?.focus();}}}>
    {!open && <button ref={button} type="button" onClick={() => { followLatest.current = true; setOpen(true); }} aria-label={tCentre('open', { name: centreName })} aria-haspopup="dialog"
      className={`fixed bottom-4 ${side} z-40 inline-flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none`}>
      <Sparkles aria-hidden className="size-5"/>
    </button>}
    {open && <section role="dialog" aria-modal="false" aria-labelledby={titleId}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
      className={docked
        ? `fixed inset-y-0 ${position === 'bottom-left' ? 'left-0 border-r' : 'right-0 border-l'} z-40 flex w-full max-w-md flex-col border-border bg-background shadow-xl`
        : `fixed bottom-4 ${side} z-40 flex h-[min(44rem,calc(100dvh-2rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl`}>
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Sparkles aria-hidden className="size-5"/></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold">{centreName}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('identity')}</p>
            {context && <p className="mt-1 text-xs text-muted-foreground">{t('about', { area: areas(context.area) })}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button aria-busy={pending} type="button" disabled={pending} onClick={()=>{pageGeneration.current++;previousExchange.current=null;awaitingClarification.current=null;setUncertain(false);setTurns([]);setQuestion('');followLatest.current=true;box.current?.focus();}} className="min-h-11 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60">{chatCopy('new')}</button>
          <button type="button" onClick={() => setDocked(value => !value)} aria-label={docked ? t('undock') : t('dock')} title={docked ? t('undock') : t('dock')}
            className="inline-flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{docked ? <Minimize2 aria-hidden className="size-4"/> : <Maximize2 aria-hidden className="size-4"/>}</button>
          <button type="button" onClick={close} aria-label={t('close')} className="inline-flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X aria-hidden className="size-4"/></button>
        </div>
      </header>
      {inboxCount !== undefined && <InboxLink count={inboxCount}/>}
      <div ref={log} role="log" aria-label={centreName} aria-live="polite" aria-relevant="additions text" onScroll={event => {
        const element = event.currentTarget;
        followLatest.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 64;
      }} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-5 text-sm">
        <div data-message-role="assistant" className="mr-8 w-fit max-w-full rounded-2xl rounded-tl-sm bg-muted/60 px-4 py-3 leading-relaxed">
          <p>{t('welcome')}</p>
        </div>
        {turns.map((turn, index) => <div key={turn.id} className="space-y-3" data-stale-turn={turn.stale || undefined}>
          {turn.stale && turn.area && turns[index - 1]?.area !== turn.area && <p className="text-center text-xs text-muted-foreground">{t('contextNote', { area: areas(turn.area) })}</p>}
          <p data-message-role="user" className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3 leading-relaxed">{turn.question}</p>
          <fieldset disabled={uncertain || turn.stale} data-message-role="assistant" className={turn.reply?"mr-5 min-w-0 max-w-full break-words px-1 py-2 leading-relaxed":"min-w-0 px-1"}>
            {!turn.reply ? <ThinkingIndicator label={t('working')}/>
              : !turn.reply.ok ? <p role="alert">{turn.reply.message}</p>
              : <div className="space-y-2">{turn.reply.answer ?? <p className="text-muted-foreground">{t('noCard')}</p>}
                  {/* AI Centre issue 18: a stored chat opens in Ask and continues there; a closed-grammar exchange opens as before. */}
                  <Link href={turn.reply.chatId ? `/assistant?chat=${encodeURIComponent(turn.reply.chatId)}` : `/assistant?e=${encodeURIComponent(turn.reply.exchangeId)}`} className="inline-flex min-h-11 items-center text-xs font-medium text-primary hover:underline">{t('openInAssistant')}</Link></div>}
          </fieldset>
        </div>)}
      </div>
      {uncertain&&<p role="status" className="shrink-0 px-4 pb-2 text-xs text-muted-foreground">{chatCopy('readOnlyHistory')}</p>}
      <form onSubmit={event => { event.preventDefault(); void send(); }} className="shrink-0 border-t border-border/70 px-4 pb-3 pt-3">
        <label htmlFor={`${titleId}-question`} className="sr-only">{t('question')}</label>
        <div className="flex items-end gap-2 rounded-2xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <textarea ref={box} id={`${titleId}-question`} rows={2} maxLength={1800} value={question} readOnly={pending||uncertain}
            onChange={event => setQuestion(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
            placeholder={t('placeholder')} className="min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed outline-none"/>
          <button type="submit" disabled={pending || uncertain || !question.trim()} aria-busy={pending} aria-label={pending ? t('working') : t('send')} title={t('send')}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"><ArrowUp aria-hidden className="size-4"/></button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('scope')}</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">{privacyNotice}</p>
      </form>
    </section>}
  </AssistantChatBoundary>;
}

/** AI centre: the floating chat's way to what waits on the person: Today at `/`, which replaced the AI Centre
 * Inbox (AI v2 Phase 1). Its own translations, so a login without the count (a shell that passes none) renders
 * nothing here. */
function InboxLink({ count }: { count: number }) {
  const t = useTranslations('aiCentre.launcher');
  return <Link href="/" className="mx-4 mt-3 flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-primary/10 px-3 text-sm hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Inbox aria-hidden className="size-4 text-primary"/><span className="font-medium">{t('today')}</span>
    {count > 0 && <span className="rounded-full bg-primary px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none tabular-nums text-primary-foreground"><span aria-hidden>{count}</span><span className="sr-only">{t('inboxCount', { count })}</span></span>}
    <ChevronRight aria-hidden className="ml-auto size-4 text-muted-foreground"/></Link>;
}
