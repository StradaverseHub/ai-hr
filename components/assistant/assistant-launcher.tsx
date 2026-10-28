'use client';
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Maximize2, Minimize2, Sparkles, X } from 'lucide-react';
import { resolvePageContext, type PageArea } from '@/lib/ai/page-context';
import { askFromLauncherAction } from '@/app/assistant/launcher-actions';

type Turn = { id: number; question: string; area: PageArea | null; reply?: { ok: true; exchangeId: string; answer: React.ReactNode } | { ok: false; message: string } };

/** The floating Assistant. Rendered only when the shell decided this login may see it (see
 * core/assistant-launcher.ts); every question still goes through the Assistant's own checks. It opens as a
 * small chat window and can be docked as a right-side panel. It knows the page's AREA and, at most, one
 * record id from the address, never what is on the screen. */
export function AssistantLauncher({ position, hiddenAreas }: { position: 'bottom-right' | 'bottom-left'; hiddenAreas: readonly PageArea[] }) {
  const t = useTranslations('assistant.launcher'), areas = useTranslations('assistant.launcher.areas');
  const pathname = usePathname() ?? '/';
  const context = resolvePageContext(pathname);
  const [open, setOpen] = React.useState(false), [docked, setDocked] = React.useState(false);
  const [question, setQuestion] = React.useState(''), [turns, setTurns] = React.useState<Turn[]>([]), [pending, setPending] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null), box = React.useRef<HTMLTextAreaElement>(null), log = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  React.useEffect(() => { if (open) box.current?.focus(); }, [open, docked]);
  React.useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [turns]);
  // Never on the Assistant itself, outside the closed area list, or in an area the administrator hid.
  if (pathname === '/assistant' || pathname.startsWith('/assistant/') || !context || hiddenAreas.includes(context.area)) return null;
  const close = () => { setOpen(false); button.current?.focus(); };
  async function send() {
    const text = question.trim();
    if (!text || pending) return;
    const id = Date.now();
    setTurns(list => [...list, { id, question: text, area: context?.area ?? null }]);
    setQuestion(''); setPending(true);
    try {
      const reply = await askFromLauncherAction({ question: text, path: pathname });
      setTurns(list => list.map(turn => turn.id === id ? { ...turn, reply } : turn));
    } catch {
      setTurns(list => list.map(turn => turn.id === id ? { ...turn, reply: { ok: false, message: t('failed') } } : turn));
    } finally { setPending(false); }
  }
  const side = position === 'bottom-left' ? 'left-4' : 'right-4';
  return <>
    {!open && <button ref={button} type="button" onClick={() => setOpen(true)} aria-label={t('open')} aria-haspopup="dialog"
      className={`fixed bottom-4 ${side} z-40 inline-flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none`}>
      <Sparkles aria-hidden className="size-5"/>
    </button>}
    {open && <section role="dialog" aria-modal="false" aria-labelledby={titleId}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
      className={docked
        ? 'fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-background shadow-xl'
        : `fixed bottom-4 ${side} z-40 flex h-[min(34rem,calc(100dvh-2rem))] w-[min(24rem,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-background shadow-xl`}>
      <header className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-sm font-semibold">{t('title')}</h2>
          {context && <p className="mt-1 inline-flex rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('about', { area: areas(context.area) })}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setDocked(value => !value)} aria-label={docked ? t('undock') : t('dock')} title={docked ? t('undock') : t('dock')}
            className="inline-flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{docked ? <Minimize2 aria-hidden className="size-4"/> : <Maximize2 aria-hidden className="size-4"/>}</button>
          <button type="button" onClick={close} aria-label={t('close')} className="inline-flex size-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X aria-hidden className="size-4"/></button>
        </div>
      </header>
      <div ref={log} aria-live="polite" className="flex-1 space-y-4 overflow-y-auto p-3 text-sm">
        {turns.length === 0 && <p className="text-muted-foreground">{t('intro')}</p>}
        {turns.map(turn => <div key={turn.id} className="space-y-2">
          <p className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2">{turn.question}</p>
          {!turn.reply ? <p role="status" className="text-muted-foreground">{t('working')}</p>
            : !turn.reply.ok ? <p role="alert">{turn.reply.message}</p>
            : <div className="space-y-2">{turn.reply.answer ?? <p className="text-muted-foreground">{t('noCard')}</p>}
                <Link href={`/assistant?e=${encodeURIComponent(turn.reply.exchangeId)}`} className="inline-flex min-h-11 items-center text-xs font-medium text-primary hover:underline">{t('openInAssistant')}</Link></div>}
        </div>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); void send(); }} className="border-t border-border p-3">
        <label htmlFor={`${titleId}-question`} className="sr-only">{t('question')}</label>
        <div className="flex items-end gap-2">
          <textarea ref={box} id={`${titleId}-question`} rows={2} maxLength={1800} value={question} readOnly={pending}
            onChange={event => setQuestion(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
            placeholder={t('placeholder')} className="min-h-11 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"/>
          <button type="submit" disabled={pending || !question.trim()} aria-busy={pending}
            className="inline-flex min-h-11 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60">{pending ? t('working') : t('send')}</button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('scope')}</p>
      </form>
    </section>}
  </>;
}
