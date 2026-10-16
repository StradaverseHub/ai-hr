'use client';
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations,useFormatter } from 'next-intl';
import {HR_LOCAL_TZ} from '@/lib/hr-date';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from './ui/button';
import { ConfirmSubmit } from './ui/confirm-submit';
import { registerUnsavedGuard } from '@/lib/unsaved-changes';
import { assistantWorkflowHref } from '@/lib/assistant-routes';
import { CONVERSATION_LIMITS, type AssistantConversationFailure, type AssistantCapabilityReply } from '@/lib/assistant-conversation-model';
import type { ConversationView } from '@/core/assistant-conversation';
import { loadAssistantConversationAction, submitAssistantConversationAction, confirmAssistantProposalAction, newAssistantConversationAction, rateAssistantReplyAction } from '@/app/assistant/actions';
const STATE_KEY: Record<AssistantCapabilityReply['kind'], string> = { guide: 'stateGuide', facts: 'stateFacts', draftHandoff: 'stateDraftHandoff', awaitingConfirmation: 'stateAwaitingConfirmation', completed: 'stateCompleted', refused: 'stateRefused', unavailable: 'stateUnavailable', unsupported: 'stateUnsupported' };
/** Home and AI Responsive mount the same private conversation owner. No transcript or source fact is
 * stored in browser storage. Full replies are plain text: model-authored HTML/Markdown URLs never run. */
export function AssistantConversation({ compact = false, canReviewPayroll=false,scopeNames=[] }: {
    compact?: boolean;
    canReviewPayroll?:boolean;
    scopeNames?:readonly string[];
}) {
    const t = useTranslations('assistantConversation'), a=useTranslations('assistant'),formatter=useFormatter(), router = useRouter(), composerId = useId(), Title = compact ? 'h2' : 'h1';
    const [view, setView] = useState<ConversationView | null>(null), [question, setQuestion] = useState(''), [error, setError] = useState<AssistantConversationFailure | null>(null), [notice, setNotice] = useState('');
    const [pending, startTransition] = useTransition(), [leaveOpen, setLeaveOpen] = useState(false);
    const questionRef = useRef(question), continuation = useRef<(() => void) | null>(null), generation = useRef(0), mounted = useRef(true), bottom = useRef<HTMLDivElement>(null);
    questionRef.current = question;
    const accept = useCallback((result: Awaited<ReturnType<typeof loadAssistantConversationAction>>, stamp: number) => {
        if (!mounted.current || stamp !== generation.current)
            return;
        if (result.ok) {
            setView(result.view);
            setError(null);
        }
        else {
            setError(result.code);
            if (['scopeChanged', 'sessionUnavailable', 'notFound', 'expired', 'unavailable'].includes(result.code))
                setView(null);
        }
    }, []);
    const load = useCallback(() => { const stamp = ++generation.current; startTransition(async () => { try {
        accept(await loadAssistantConversationAction(), stamp);
    }
    catch {
        if (stamp === generation.current && mounted.current){setError('unavailable');setView(null);}
    } }); }, [accept]);
    useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; generation.current++; }; }, [load]);
    useEffect(() => { bottom.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' }); }, [view?.revision]);
    useEffect(() => registerUnsavedGuard({ isDirty: () => !!questionRef.current.trim(), prompt: proceed => { continuation.current = proceed; setLeaveOpen(true); } }), []);
    useEffect(() => {
        const unload = (event: BeforeUnloadEvent) => { if (questionRef.current.trim()) {
            event.preventDefault();
            event.returnValue = '';
        } };
        const click = (event: MouseEvent) => {
            if (!questionRef.current.trim() || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
                return;
            const anchor = event.target instanceof Element ? event.target.closest('a') : null;
            if (!anchor || anchor.hasAttribute('download') || anchor.target === '_blank' || anchor.closest('[data-unsaved-guard="ignore"]'))
                return;
            const url = new URL(anchor.href, window.location.href);
            if (url.origin !== window.location.origin || url.pathname === window.location.pathname && url.search === window.location.search)
                return;
            event.preventDefault();
            event.stopImmediatePropagation();
            continuation.current = () => router.push(url.pathname + url.search + url.hash);
            setLeaveOpen(true);
        };
        window.addEventListener('beforeunload', unload);
        document.addEventListener('click', click, true);
        return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true); };
    }, [router]);
    const send = (intent: 'question' | 'prepareCloseFixed' = 'question') => {
        if (!view || pending || view.pending || !question.trim() && intent === 'question')
            return;
        const text = intent === 'question' ? question : t('prepareCloseFixed'), stamp = ++generation.current;
        const input = { conversationId: view.id, revision: view.revision, requestId: crypto.randomUUID(), question: text, intent };
        setNotice('');
        startTransition(async () => { try {
            const result = await submitAssistantConversationAction(input);
            accept(result, stamp);
            if (result.ok && mounted.current && stamp===generation.current && questionRef.current === text)
                setQuestion('');
        }
        catch {
            if (stamp === generation.current && mounted.current){setError('unavailable');setView(null);}
        } });
    };
    const confirm = (reply: Extract<AssistantCapabilityReply, {
        kind: 'awaitingConfirmation';
    }>) => {
        if (!view || pending || view.pending)
            return;
        const stamp = ++generation.current;
        const input = { conversationId: view.id, conversationRevision: view.revision, proposalId: reply.proposalId, proposalRevision: reply.proposalRevision, requestId: crypto.randomUUID() };
        startTransition(async () => { try {
            accept(await confirmAssistantProposalAction(input), stamp);
        }
        catch {
            if (stamp === generation.current && mounted.current){setError('unavailable');setView(null);}
        } });
    };
    const newConversation = () => { if (!view || pending)
        return; const run = () => { const id = view.id, stamp = ++generation.current; startTransition(async () => { try {
        accept(await newAssistantConversationAction(id), stamp);
    }
    catch {
        if (stamp === generation.current && mounted.current){setError('unavailable');setView(null);}
    } }); }; if (questionRef.current.trim()) {
        continuation.current = run;
        setLeaveOpen(true);
    }
    else
        run(); };
    const rate = (exchangeId: string, helpful: boolean) => { if (!view || pending)
        return; const conversationId = view.id, stamp = generation.current; startTransition(async () => { try {
        const result = await rateAssistantReplyAction({ conversationId, exchangeId, helpful });
        if (!mounted.current || stamp !== generation.current)
            return;
        if (result.ok) {
            setView(current => current ? { ...current, messages: current.messages.map(message => message.id === exchangeId ? { ...message, helpful } : message) } : null);
            setNotice(t('feedbackSaved'));
        }
        else {
            setError(result.code);
            setView(null);
        }
    }
    catch {
        if(stamp===generation.current&&mounted.current){setError('unavailable');setView(null);}
    } }); };
    return <section aria-label={t('title')} className={`flex min-w-0 flex-col rounded-xl border border-border bg-card ${compact ? 'max-h-[80dvh]' : 'min-h-[65dvh]'}`}>
  <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6"><div><Title className={compact ? 'text-base font-semibold' : 'text-xl font-semibold'}>{t('title')}</Title><p className="mt-1 max-w-prose text-xs text-muted-foreground">{scopeNames.length?scopeNames.slice(0,3).join(' · '):t('scope')}{scopeNames.length>3&&` · ${t('moreCompanies',{count:scopeNames.length-3})}`}</p></div><div className="flex flex-wrap gap-1"><Button type="button" variant="ghost" className="min-h-11" disabled={!view || pending} onClick={newConversation}>{t('new')}</Button><Button type="button" variant="ghost" className="min-h-11" disabled={pending} onClick={load}>{t('refresh')}</Button></div></header>
  <div className={`min-w-0 flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6 ${compact ? 'min-h-40' : 'min-h-64'}`}>
   {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{t('error')}</p>}
   {!view && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
   {view?.messages.length === 0 && <div className="py-8"><p className="max-w-prose text-muted-foreground">{t('empty')}</p><nav aria-label={t('pages')} className="mt-5 flex flex-wrap gap-2">{(['ownProfile', 'ownAttendance', 'ownLeave'] as const).map(route => <Link key={route} className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-sm hover:bg-accent" href={assistantWorkflowHref(route)}>{t(`routes.${route}`)}</Link>)}</nav></div>}
   {view?.messages.map(message => <article key={message.id} className="space-y-3"><p className="ml-auto max-w-[90%] whitespace-pre-wrap break-words rounded-xl bg-muted px-4 py-3 text-sm">{message.question}</p><div className="space-y-3"><p className="text-xs font-medium text-muted-foreground">{t(message.proposalStatus==='completed'?'stateCompleted':message.proposalStatus==='refused'?'stateRefused':message.proposalStatus==='expired'?'stateUnavailable':STATE_KEY[message.reply.kind])}</p><p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{message.failure?a(`err_${message.failure}`):message.reply.text||t('unavailable')}</p><time dateTime={message.askedAt} className="text-xs text-muted-foreground">{formatter.dateTime(new Date(message.askedAt),{dateStyle:'medium',timeStyle:'short',timeZone:HR_LOCAL_TZ})}</time>
    {message.reply.tables.map((table, index) => <div key={index} className="overflow-x-auto rounded-md border border-border"><table className="min-w-full text-left text-sm"><thead className="bg-muted/50"><tr>{table.columns.map((column, col) => <th key={col} scope="col" className="px-3 py-2 font-medium">{column}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-border">{row.map((cell, col) => <td key={col} className="px-3 py-2">{cell}</td>)}</tr>)}</tbody></table></div>)}
    {!!message.reply.links.length && <nav aria-label={t('pages')} className="flex flex-wrap gap-2">{message.reply.links.map(link => <Link key={link.route} className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-sm text-primary hover:bg-accent" href={assistantWorkflowHref(link.route)}>{link.label}</Link>)}</nav>}
    {!!message.reply.evidence.length && <details className="text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">{t('sources')}</summary><ul className="space-y-2 pb-3">{message.reply.evidence.map((source, index) => <li key={index}>{source.label}{source.asAt && ` · ${source.asAt}`}{source.truncated && ` · ${t('partial')}`}</li>)}</ul></details>}
    {message.reply.kind === 'awaitingConfirmation' && message.proposalStatus==='awaiting' && <form onSubmit={event => { event.preventDefault(); if (message.reply.kind === 'awaitingConfirmation')
            confirm(message.reply); }}><ConfirmSubmit className="min-h-11" variant="default" disabled={pending || view.pending} title={t('confirm')} description={t('review')} confirmLabel={t('confirm')}>{t('confirm')}</ConfirmSubmit></form>}
    <div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" className="min-h-11" aria-pressed={message.helpful === true} disabled={pending} onClick={() => rate(message.id, true)}>{t('helpful')}</Button><Button type="button" variant="ghost" className="min-h-11" aria-pressed={message.helpful === false} disabled={pending} onClick={() => rate(message.id, false)}>{t('notHelpful')}</Button></div>
   </div></article>)}<div ref={bottom}/>
  </div>
  <footer className="border-t border-border p-4 sm:p-6"><form onSubmit={event => { event.preventDefault(); send(); }} className="space-y-3"><label htmlFor={composerId} className="sr-only">{t('title')}</label><textarea id={composerId} value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
    } }} rows={compact ? 2 : 3} maxLength={CONVERSATION_LIMITS.questionChars} disabled={pending || view?.pending} placeholder={t('placeholder')} className="block w-full resize-y rounded-lg border border-input bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"/><div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t('keyboard')}</span><Button type="submit" className="min-h-11" disabled={!view || pending || view.pending || !question.trim()}>{pending || view?.pending ? t('working') : t('send')}</Button></div></form><p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">{notice || t('questionOnly')}</p><p className="mt-2 text-xs text-muted-foreground">{t('private')}</p>{!compact && canReviewPayroll && <Button type="button" variant="ghost" className="mt-2 min-h-11 text-xs" disabled={!view || pending || view.pending} onClick={() => send('prepareCloseFixed')}>{t('prepareCloseFixed')}</Button>}</footer>
  <AlertDialog.Root open={leaveOpen} onOpenChange={setLeaveOpen}><AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40"/><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-lg"><AlertDialog.Title className="font-semibold">{t('discardQuestion')}</AlertDialog.Title><AlertDialog.Description className="mt-2 text-sm text-muted-foreground">{t('questionOnly')}</AlertDialog.Description><div className="mt-5 flex flex-wrap justify-end gap-2"><AlertDialog.Cancel asChild><Button className="min-h-11" variant="outline">{t('keepEditing')}</Button></AlertDialog.Cancel><AlertDialog.Action asChild><Button className="min-h-11" onClick={() => { questionRef.current = ''; setQuestion(''); const run = continuation.current; continuation.current = null; run?.(); }}>{t('discardContinue')}</Button></AlertDialog.Action></div></AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>
 </section>;
}
