import {randomUUID} from 'node:crypto';
import {listOwnAssistantChats,loadOwnAssistantChat} from '@/core/assistant-threads';
import {assistantBrowserConversationScope} from './conversation-scope';
import {ProtectedAnalysis} from '@/components/assistant/protected-analysis';
import {isAdmin} from '@/lib/authz-model';
import {allowedCompanies} from '@/core/read';
import {getScopeIds} from '@/lib/scope';
import {AssistantHistoryPrivacy} from '../../components/assistant/history-privacy';
import {OwnClearForm,OwnClearStatus} from '../../components/assistant/own-clear';
import {eraseConversationMetadataAction} from './agent-review-actions';
import {NativeOutcomes,NativeOutcomePrivacy} from '@/components/assistant/native-outcomes';
import {ImportPreparationPrivacy} from '@/components/assistant/import-privacy';
import { getTranslations } from 'next-intl/server';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { getSession } from '@/lib/session';
import { loadAiWorkspace } from '@/core/ai-workspace';
import {CanonicalModuleJob,ModuleJobChooser,GovernedModuleJobComposer,GovernedWorkspaceJob} from '@/components/assistant/module-jobs';
import {loadCanonicalModuleJob} from '@/core/workspace-module-jobs';
import {allowedModuleActionEntries} from '@/core/assistant-actions/module-action-entries';
import {ModuleQuestionPlanner} from '@/components/assistant/module-plan';
import {eraseModuleProposalsAction} from './module-plan-actions';
import {SpecialistJobComposer} from '@/components/assistant/module-specialist-review';
import { WorkspaceConversation } from '@/components/assistant/workspace-conversation';
import { ExchangeReply } from '@/components/assistant/exchange-reply';
import Link from 'next/link';
import { isGroupAdmin } from '@/lib/authz';
import { ErrorBanner, PageHeader } from '@/components/ui';
import { viewerIdentity } from '@/lib/viewer';
import { readEmployeeHomeIdentity } from '@/core/employee-home';
import { homeDisplayClock } from '@/lib/employee-home';
import { AssistantHomeTabs } from '@/components/assistant/assistant-home-tabs';
import { HomeTasksCard } from '@/components/employee-home/tasks-card';
import { HomeCalendarCard } from '@/components/employee-home/calendar-card';
import {eraseGovernedJobFeedbackAction} from './job-feedback-actions';
import { eraseAgentFeedbackAction } from './feedback-actions';

/**
 * ADR-0082 slice 4 — THE ASSISTANT'S FIRST SCREEN, and the first time any of it is reachable.
 *
 * Slices 1-3 built the gateway's conversation support (r221), the access-scoped tool registry (r223) and
 * the loop (r229). None of it had a caller a person could reach: production carries ZERO grants and ZERO
 * exchanges. This is the door.
 *
 * WHAT THIS SCREEN IS CAREFUL ABOUT, IN ORDER OF HOW BADLY IT WOULD GO WRONG:
 *
 *  1. IT NEVER PRESENTS A NON-ANSWER AS AN ANSWER. `stop` has five members and only `end` means the model
 *     finished. A refusal, a truncation, a provider oddity or the turn cap each get their own sentence,
 *     because an assistant that quietly stops looking is indistinguishable from one that finished
 *     (ADR-0082 §2.5) — and on HR data the difference is "there is nothing" versus "I stopped early".
 *  2. IT SHOWS WHAT WAS LOOKED AT. The tools used are listed under the answer. Every one ran inside this
 *     user's own session, so the list is also the honest statement of scope: it could only read what the
 *     asker can already see.
 *  3. IT NEVER RENDERS A REASON THE USER CANNOT ACT ON. `mayUseAssistant` distinguishes module-off,
 *     no-user and no-grant; each says who to ask rather than showing an empty box.
 *
 * The answer is read back from `assistant_exchange` rather than passed through the redirect: the audit row
 * is the record, and a second copy in a query string could differ from it.
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; error?: string;job?:string;governed?:string;proposal?:string;planning?:string;importHistory?:string;nativeOutcome?:string;nativeLink?:string;historyPrivacy?:string;ownClear?:string;chatReset?:string;chatCursor?:string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('assistant');
  const sp = await searchParams;
  const errorMessage=sp.error==='clarification_unavailable'?t('workspace.conversation.unavailable'):
    sp.error&&/^[a-z_]{1,40}$/.test(sp.error)&&t.has(`err_${sp.error}`)?t(`err_${sp.error}`):undefined;
  const workspace = await loadAiWorkspace(s,{includeHistory:sp.job===undefined&&sp.governed===undefined&&sp.proposal===undefined,includeGovernance:false,selectedExchangeId:sp.e,governedJobId:sp.governed,proposalId:sp.proposal});
  const access = workspace.access;

  // Home: a greeting, the question box, then "My work" and "Calendar". Both panels are the existing home
  // cards, each reading its own authorized facts for the signed-in person's selected employment. A login
  // with no employment (or an unreadable one) simply sees a short note instead of the two panels.
  const clock = homeDisplayClock(new Date(), 'Asia/Kuala_Lumpur');
  const name = await viewerIdentity(s).then(viewer => viewer.name?.trim() || null).catch(() => null);
  const greeting = clock.hour < 12 ? (name ? t('home.morning', { name }) : t('home.morningNoName'))
    : clock.hour < 18 ? (name ? t('home.afternoon', { name }) : t('home.afternoonNoName'))
    : (name ? t('home.evening', { name }) : t('home.eveningNoName'));
  const employmentId = await readEmployeeHomeIdentity(s).then(identity => identity.selectedEmploymentId).catch(() => null);
  const homeTabs = employmentId ? <AssistantHomeTabs labels={{tabs:t('home.tabs'),work:t('home.myWork'),calendar:t('home.calendar')}}
    work={<HomeTasksCard employmentId={employmentId}/>}
    calendar={<HomeCalendarCard employmentId={employmentId} initialMonth={clock.date.slice(0,7)}/>}/>
    : <p className="text-center text-sm text-muted-foreground">{t('home.noEmployment')}</p>;

  if (!access.allowed) {
    // Same home as the full view, without the question box: why the Assistant is unavailable and who can
    // change it (three reasons, three next steps), the person's own work and calendar, and every own-data
    // control, which stays usable after access is removed.
    const mayGrant = access.reason === 'no_grant' && isGroupAdmin(s);
    return (
      <div data-tour="intelligence-assistant" className="mx-auto max-w-5xl space-y-6">
        <div className="mx-auto max-w-3xl space-y-4 pt-2">
          <PageHeader title={greeting} description={t('description')} />
          <OwnClearStatus status={sp.ownClear}/>
          <section aria-labelledby="assistant-access-heading" className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <h2 id="assistant-access-heading" className="text-base font-semibold">{t('home.accessTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t(`denied_${access.reason}`)}</p>
            {mayGrant && <Link href="/control-tower/agents/allowances#user-limits" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t('home.grantSelf')}</Link>}
          </section>
          {homeTabs}
        </div>
        <section id="assistant-privacy" aria-labelledby="assistant-privacy-heading" className="scroll-mt-4 space-y-2 border-t border-border pt-4">
          <h2 id="assistant-privacy-heading" className="text-sm font-medium">{t('home.privacy')}</h2>
          <p className="text-xs text-muted-foreground">{t('home.privacyHelp')}</p>
          <AssistantHistoryPrivacy status={sp.historyPrivacy}/>
          <ImportPreparationPrivacy status={sp.importHistory}/><NativeOutcomePrivacy status={sp.nativeOutcome}/>
          <ul className="grid gap-x-6 sm:grid-cols-2">
            <li><OwnClearForm kind="feedback" action={eraseAgentFeedbackAction} label={t('workspace.feedbackErase')}/></li>
            <li><OwnClearForm kind="ratings" action={eraseGovernedJobFeedbackAction} label={t('workspace.governed.eraseSignals')}/></li>
            <li><OwnClearForm kind="proposals" action={eraseModuleProposalsAction} label={t('workspace.planning.erase')}/></li>
            <li><OwnClearForm kind="conversation" action={eraseConversationMetadataAction} label={t('workspace.conversationGovernance.erase')}/></li>
          </ul>
        </section>
      </div>
    );
  }

  const analysisScope=isAdmin(s)?await allowedCompanies(s).then(rows=>getScopeIds(rows.map(row=>row.id))).catch(()=>[]):[];
  const newChatHref='/assistant?chatReset='+randomUUID();
  const conversationScope=await assistantBrowserConversationScope(s);
  const savedChats=await listOwnAssistantChats(s,{cursor:sp.chatCursor},conversationScope).catch(()=>null);
  const selectedChat=sp.e?await loadOwnAssistantChat(s,{exchangeId:sp.e},conversationScope).catch(()=>null):null;
  const initialTurns=selectedChat?.turns.map(exchange=>({id:exchange.id,question:exchange.question,
    clarificationRequired:exchange.grounded?.conversation?.plan.mode==='clarify'&&exchange.grounded?.conversation?.clarificationAllowed!==false,
    answer:<ExchangeReply exchange={exchange} ctx={s}/>}));
  const selectedJob=sp.job===undefined||sp.governed!==undefined?null:await loadCanonicalModuleJob(s,{module:sp.job});
  // Shortcuts are offered only where the target's own authorization rules admit this session.
  const actionEntries=await allowedModuleActionEntries(s,workspace.jobModules);
  const today = todayInKualaLumpur();
  const tasks = workspace.taskIds.map(id => ({
    id, label: t(`workspace.${id}_label`), prompt: t(`workspace.${id}_prompt`, { date: today }),
  }));

  return (
    <div data-tour="intelligence-assistant" className="mx-auto max-w-7xl space-y-5">
      <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <section className="min-w-0 space-y-3 lg:order-2">
          <PageHeader title={t('title')} />
          <OwnClearStatus status={sp.ownClear}/>
          <ErrorBanner message={errorMessage??(sp.e&&!selectedChat?t('workspace.conversation.unavailable'):undefined)} />
          <WorkspaceConversation key={(savedChats?.scopeDigest??'')+':'+(sp.e??'')+':'+(sp.chatReset??'')} fullHeight resetKey={(sp.chatReset??'')+':'+(savedChats?.scopeDigest??'')} fileImport={(s.roles??[]).some(role=>role==='hr_admin'||role==='super_admin')} tasks={tasks}
            initialTurns={initialTurns} historyReadOnly={Boolean(selectedChat&&!selectedChat.resume)} initialResume={selectedChat?.resume??undefined} historyTailId={sp.e} olderCursor={selectedChat?.olderCursor??undefined}/>

        </section>
        <aside aria-label={t('workspace.chat.tools')} className="min-w-0 space-y-1 border-t border-border lg:order-1 lg:border-r lg:border-t-0 lg:pr-5">
          <nav aria-label={t('workspace.chat.chats')} className="pb-3">
            <h2 className="py-3 text-sm font-medium">{t('workspace.chat.chats')}</h2>
            <Link href={newChatHref} scroll={false} className="mb-2 inline-flex min-h-11 items-center rounded-md px-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('workspace.chat.new')}</Link>
            <ul className="max-h-80 space-y-1 overflow-y-auto overscroll-contain">{(savedChats?.chats??[]).map(chat=><li key={chat.threadId}><Link href={'/assistant?e='+encodeURIComponent(chat.exchangeId)} scroll={false} aria-current={selectedChat?.threadId===chat.threadId?'page':undefined} className="block break-words rounded-md px-2 py-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary aria-[current=page]:bg-muted">{chat.title}</Link></li>)}</ul>
            {savedChats?.nextCursor&&<Link href={'/assistant?'+(sp.e?'e='+encodeURIComponent(sp.e)+'&':'')+'chatCursor='+encodeURIComponent(savedChats.nextCursor)} scroll={false} className="inline-flex min-h-11 items-center px-2 text-xs underline">{t('workspace.chat.moreChats')}</Link>}
          </nav>
          <details className="border-t border-border">
            <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('home.tabs')}</summary>
            <div className="pb-3">{homeTabs}</div>
          </details>
          <details open={Boolean(sp.historyPrivacy||sp.importHistory||sp.nativeOutcome||sp.ownClear)} className="border-t border-border">
            <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('home.privacy')}</summary>
            <section id="assistant-privacy" aria-labelledby="assistant-privacy-heading" className="scroll-mt-4 space-y-3 pb-3">
              <h2 id="assistant-privacy-heading" className="sr-only">{t('home.privacy')}</h2>
              <AssistantHistoryPrivacy status={sp.historyPrivacy}/>
              <OwnClearForm kind="conversation" action={eraseConversationMetadataAction} label={t('workspace.conversationGovernance.erase')}/>
              <ImportPreparationPrivacy status={sp.importHistory}/><NativeOutcomePrivacy status={sp.nativeOutcome}/>
            </section>
          </details>
        </aside>
      </div>

      <details open={Boolean(sp.job||sp.governed||sp.proposal||sp.planning)} className="border-t border-border pt-2">
        <summary className="min-h-11 cursor-pointer py-3 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('workspace.chat.tools')}</summary>
        <div className="space-y-6 pt-3">
          {analysisScope.length>0&&<ProtectedAnalysis scopeIds={analysisScope}/>}
          <ModuleJobChooser modules={workspace.jobModules} selected={sp.job} actions={actionEntries}/>
          {selectedJob&&<CanonicalModuleJob view={selectedJob} ctx={s}/>}
          {workspace.governedJob&&<GovernedWorkspaceJob view={workspace.governedJob} ctx={s}/>}
          {workspace.governedJob&&sp.governed&&<NativeOutcomes jobId={sp.governed} status={sp.nativeOutcome} selectedLink={sp.nativeLink}/>}
          <GovernedModuleJobComposer modules={workspace.jobModules}/>
          <SpecialistJobComposer modules={workspace.jobModules}/>
          <ModuleQuestionPlanner permit={workspace.planningPermit} availability={workspace.planningAvailability} view={workspace.proposal} status={sp.planning??(sp.proposal&&!workspace.proposal?'unavailable':undefined)}/>
        </div>
      </details>
    </div>
  );
}
