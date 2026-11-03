import {SavedChatList} from '@/components/assistant/saved-chat-list';
import {assistantConversationScopeDigest} from '@/core/assistant-conversation-context';
import {randomUUID} from 'node:crypto';
import {listOwnAssistantChats,loadOwnAssistantChat} from '@/core/assistant-threads';
import {assistantBrowserConversationScope} from './conversation-scope';
import {ProtectedAnalysis} from '@/components/assistant/protected-analysis';
import {isAdmin} from '@/lib/authz-model';
import {allowedCompanies} from '@/core/read';
import {getScopeIds} from '@/lib/scope';
import {PersonnelReviewNavigation} from '@/components/assistant/personnel-review-navigation';
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
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { viewerIdentity } from '@/lib/viewer';
import { readEmployeeHomeIdentity } from '@/core/employee-home';
import { homeDisplayClock } from '@/lib/employee-home';
import { AssistantHomeTabs } from '@/components/assistant/assistant-home-tabs';
import { HomeTasksCard } from '@/components/employee-home/tasks-card';
import { HomeCalendarCard } from '@/components/employee-home/calendar-card';
import {eraseGovernedJobFeedbackAction} from './job-feedback-actions';
import { eraseAgentFeedbackAction } from './feedback-actions';
import { isCentreView } from '@/lib/ai-centre/centre-nav';
import { AI_ARCHITECTURE_LABEL, AI_PRODUCT_NAME, aiCentreName } from '@/lib/ai-centre/brand';
import { AiCentreTabs } from '@/components/ai-centre/centre-tabs';
import { AiCentreDelegatedJobs } from '@/components/ai-centre/delegated-jobs';
import { HowItWorks } from '@/components/ai-centre/how-it-works';
import { AiCentreLiveStatus } from '@/components/ai-centre/live-status';
import { permanentRedirect } from 'next/navigation';
import { listOwnChats, readChatRetention } from '@/core/teras-chats';
import { AskChatHeader, AskChatsColumn, AskChatsFooter, AskChatsProvider, type AskChatSummary } from '@/components/ai-centre/ask-chats';
import { todayInboxRedirect } from '@/lib/ai-centre/today-redirect';

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
  searchParams: Promise<{ view?: string; recommend?: string; e?: string; chat?: string; error?: string;job?:string;governed?:string;proposal?:string;planning?:string;importHistory?:string;nativeOutcome?:string;nativeLink?:string;historyPrivacy?:string;ownClear?:string;chatReset?:string;chatCursor?:string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('assistant');
  const sp = await searchParams;
  // AI centre (docs/design/ai-centre/PLAN.md): Delegated jobs and How it works are views of this route, behind
  // the same layout session check. They read nothing that depends on the Assistant grant; the conversation
  // below keeps its own checks. (The Inbox view read native owners as the caller; Today now does.)
  const admin = isAdmin(s);
  // AI v2 Phase 1: the Inbox tab is retired; Today at `/` replaces it. A saved or old Inbox link moves there
  // for good (308), carrying only an approver's recommendation request when it is a well-formed id.
  if (sp.view === 'inbox') permanentRedirect(todayInboxRedirect(sp.recommend));
  if (isCentreView(sp.view)) {
    const tc = await getTranslations('aiCentre.how');
    return (
      <div data-ai-centre={sp.view} className="mx-auto max-w-6xl space-y-6">
        <AiCentreTabs active={sp.view} isAdmin={admin} />
        {sp.view === 'jobs' && <AiCentreDelegatedJobs />}
        {sp.view === 'how' && <><PageHeader title={AI_PRODUCT_NAME ? tc('titleNamed', { name: AI_PRODUCT_NAME }) : tc('title')} description={AI_ARCHITECTURE_LABEL ? tc('taglineNamed', { osName: AI_ARCHITECTURE_LABEL }) : tc('description')} /><HowItWorks adminHref={admin ? '#ai-centre-live-status' : undefined} />{admin && <AiCentreLiveStatus session={s} />}</>}
      </div>
    );
  }
  const a = await getTranslations('aiAsk');
  // AI v2 W4 (issue 14): Ask is chat-only. What sat beside the chat moved, nothing deleted: the own-data controls to
  // Your data and privacy (?view=privacy, ADR-0169 rights), the tools and shortcuts to More tools (?view=tools).
  // Their actions still return to /assistant with their closed status codes, so those addresses open the view
  // that shows the outcome.
  const privacyOutcome = Boolean(sp.historyPrivacy || sp.importHistory || sp.ownClear || (sp.nativeOutcome && !sp.governed));
  const toolsRequested = sp.view === 'tools' || sp.job !== undefined || Boolean(sp.governed || sp.proposal || sp.planning);
  // Your data and privacy works without the Assistant grant: own-data erasure survives access removal.
  const keepDays = await readChatRetention(s).then(value => value.keepDays).catch(() => null);
  const privacyControls = (
    <section id="assistant-privacy" aria-labelledby="assistant-privacy-heading" className="scroll-mt-4 space-y-3">
      <h2 id="assistant-privacy-heading" className="text-base font-semibold">{a('privacy.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('home.privacyHelp')}</p>
      <OwnClearStatus status={sp.ownClear}/>
      <p className="text-sm">{keepDays === null ? a('keptUnknown') : a('keptFor', { days: keepDays })}</p>
      <p className="text-sm text-muted-foreground">{t('workspace.chat.privacy')}</p>
      <AssistantHistoryPrivacy status={sp.historyPrivacy}/>
      <ImportPreparationPrivacy status={sp.importHistory}/><NativeOutcomePrivacy status={sp.nativeOutcome}/>
      <ul className="grid gap-x-6 sm:grid-cols-2">
        <li><OwnClearForm kind="feedback" action={eraseAgentFeedbackAction} label={t('workspace.feedbackErase')}/></li>
        <li><OwnClearForm kind="ratings" action={eraseGovernedJobFeedbackAction} label={t('workspace.governed.eraseSignals')}/></li>
        <li><OwnClearForm kind="proposals" action={eraseModuleProposalsAction} label={t('workspace.planning.erase')}/></li>
        <li><OwnClearForm kind="conversation" action={eraseConversationMetadataAction} label={t('workspace.conversationGovernance.erase')}/></li>
      </ul>
    </section>
  );
  if (sp.view === 'privacy' || (sp.view === undefined && privacyOutcome)) {
    return (
      <div data-ai-centre="privacy" className="mx-auto max-w-6xl space-y-6">
        <AiCentreTabs active={null} isAdmin={admin} />
        <div className="mx-auto max-w-3xl space-y-5">
          <PageHeader title={a('privacy.title')} description={a('privacy.description')} back={{ href: '/assistant', label: a('backToAsk') }} />
          <Card className="p-5">{privacyControls}</Card>
        </div>
      </div>
    );
  }
  const centreTabs = <AiCentreTabs active="ask" isAdmin={admin} />;
  const errorMessage=sp.error==='clarification_unavailable'?t('workspace.conversation.unavailable'):
    sp.error&&/^[a-z_]{1,40}$/.test(sp.error)&&t.has(`err_${sp.error}`)?t(`err_${sp.error}`):undefined;
  const workspace = await loadAiWorkspace(s,{includeHistory:sp.job===undefined&&sp.governed===undefined&&sp.proposal===undefined,includeGovernance:false,selectedExchangeId:sp.e,governedJobId:sp.governed,proposalId:sp.proposal});
  const access = workspace.access;

  // The denied-access fallback retains own work/calendar. The active chat never preloads those
  // unrelated records; More tools links to the dashboard instead.
  const clock = homeDisplayClock(new Date(), 'Asia/Kuala_Lumpur');
  const name = !access.allowed?await viewerIdentity(s).then(viewer => viewer.name?.trim() || null).catch(() => null):null;
  const greeting = clock.hour < 12 ? (name ? t('home.morning', { name }) : t('home.morningNoName'))
    : clock.hour < 18 ? (name ? t('home.afternoon', { name }) : t('home.afternoonNoName'))
    : (name ? t('home.evening', { name }) : t('home.eveningNoName'));
  const employmentId = !access.allowed?await readEmployeeHomeIdentity(s).then(identity => identity.selectedEmploymentId).catch(() => null):null;
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
        {centreTabs}
        <div className="mx-auto max-w-3xl space-y-4 pt-2">
          <PageHeader title={greeting} description={t('description')} />
          <section aria-labelledby="assistant-access-heading" className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <h2 id="assistant-access-heading" className="text-base font-semibold">{t('home.accessTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t(`denied_${access.reason}`)}</p>
            {mayGrant && <Link href="/control-tower/agents/allowances#user-limits" className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t('home.grantSelf')}</Link>}
          </section>
          {homeTabs}
          <PersonnelReviewNavigation ctx={s}/>
        </div>
        <div className="border-t border-border pt-4">{privacyControls}</div>
      </div>
    );
  }

  if (toolsRequested) {
    // More tools: the shortcuts and ways to work that used to sit under Ask's conversation. Each keeps its owner's
    // checks; a job, governed job, proposal or planning outcome address opens here.
    const analysisScope=isAdmin(s)?await allowedCompanies(s).then(rows=>getScopeIds(rows.map(row=>row.id))).catch(()=>[]):[];
    const selectedJob=sp.job===undefined||sp.governed!==undefined?null:await loadCanonicalModuleJob(s,{module:sp.job});
    // Shortcuts are offered only where the target's own authorization rules admit this session.
    const actionEntries=await allowedModuleActionEntries(s,workspace.jobModules);
    return (
      <div data-tour="intelligence-assistant" data-ai-centre="tools" className="mx-auto max-w-6xl space-y-6">
        {centreTabs}
        <PageHeader title={a('tools.title')} description={a('tools.description')} back={{ href: '/assistant', label: a('backToAsk') }} />
        <ErrorBanner message={errorMessage} />
        <section aria-labelledby="ai-ask-shortcuts" className="space-y-3">
          <h2 id="ai-ask-shortcuts" className="text-base font-semibold">{a('tools.shortcuts')}</h2>
          <ul className="flex flex-wrap gap-2">
            <li><Link href="/" className="inline-flex min-h-11 items-center rounded-full border border-border px-4 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('home.tabs')}</Link></li>
            <li><Link href="/assistant?view=privacy" className="inline-flex min-h-11 items-center rounded-full border border-border px-4 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{a('privacyLink')}</Link></li>
          </ul>
          <PersonnelReviewNavigation ctx={s}/>
        </section>
        <div className="space-y-6">
          {analysisScope.length>0&&<ProtectedAnalysis scopeIds={analysisScope}/>}
          <ModuleJobChooser modules={workspace.jobModules} selected={sp.job} actions={actionEntries}/>
          {selectedJob&&<CanonicalModuleJob view={selectedJob} ctx={s}/>}
          {workspace.governedJob&&<GovernedWorkspaceJob view={workspace.governedJob} ctx={s}/>}
          {workspace.governedJob&&sp.governed&&<NativeOutcomes jobId={sp.governed} status={sp.nativeOutcome} selectedLink={sp.nativeLink}/>}
          <GovernedModuleJobComposer modules={workspace.jobModules}/>
          <SpecialistJobComposer modules={workspace.jobModules}/>
          <ModuleQuestionPlanner permit={workspace.planningPermit} availability={workspace.planningAvailability} view={workspace.proposal} status={sp.planning??(sp.proposal&&!workspace.proposal?'unavailable':undefined)}/>
        </div>
      </div>
    );
  }

  const newChatHref='/assistant?chatReset='+randomUUID();
  const conversationScope=await assistantBrowserConversationScope(s);
  const scopeReset=assistantConversationScopeDigest(s,conversationScope);
  const savedChats=await listOwnAssistantChats(s,{cursor:sp.chatCursor},conversationScope).catch(()=>null);
  const selectedChat=sp.e?await loadOwnAssistantChat(s,{exchangeId:sp.e},conversationScope).catch(()=>null):null;
  // AI v2 W4: the Chats column lists the person's stored AI Centre chats (core/teras-chats.ts, re-authorised there).
  const storedChats=await listOwnChats(s,{},conversationScope).catch(()=>null);
  const chatSummaries:AskChatSummary[]=(storedChats?.chats??[]).map(chat=>({chatId:chat.chatId,title:chat.title,lastMessageAt:chat.lastMessageAt.toISOString(),turns:chat.turns,withheldTurns:chat.withheldTurns}));
  // AI Centre issue 18: the floating panel's "Open in AI Centre" opens its stored chat here (?chat=<id>) and, while the
  // Noveri conversation switch admits this caller, the next question continues that same chat.
  const storedChat=sp.chat&&!sp.e?await import('./launcher-actions').then(owner=>owner.openStoredChatAction({chatId:sp.chat})).then(reply=>reply.ok?reply:null).catch(()=>null):null;
  const initialTurns=selectedChat?selectedChat.turns.map(exchange=>({id:exchange.id,question:exchange.question,
    clarificationRequired:exchange.grounded?.conversation?.plan.mode==='clarify'&&exchange.grounded?.conversation?.clarificationAllowed!==false,
    answer:<ExchangeReply exchange={exchange} ctx={s}/>})):storedChat?.turns;
  const storedResume=storedChat?.conversationToken?{exchangeId:'teras-chat-'+storedChat.chatId,conversationToken:storedChat.conversationToken}:undefined;
  // AI v2 slice 3 (issue 16b): the paperclip attaches a file to import, for a caller whose chat runs through the harness
  // and who may import here (core/chat-import/kinds.ts). It replaces the older file preparation, which stays for the
  // closed grammar. Any failure shows no paperclip.
  const chatImport=await import('@/core/teras-wiring/switch').then(owner=>owner.conversationRoute(s))
    .then(async route=>route.route==='harness'&&(await import('@/core/chat-import/kinds').then(owner=>owner.chatImportKindsFor(s))).length>0).catch(()=>false);
  const today = todayInKualaLumpur();
  const tasks = workspace.taskIds.map(id => ({
    id, label: t(`workspace.${id}_label`), prompt: t(`workspace.${id}_prompt`, { date: today }),
  }));
  const legacyChats=(savedChats?.chats??[]).map(({threadId,exchangeId,title})=>({threadId,exchangeId,title}));
  // Saved closed-grammar conversations stay reachable under the stored chats (they are the history while the
  // tenant's Noveri conversation switch is off).
  const legacy=legacyChats.length>0||savedChats?.nextCursor?<details open={chatSummaries.length===0||Boolean(sp.e)} className="border-t border-border pt-1">
    <summary className="flex min-h-11 cursor-pointer items-center px-2 text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{a('earlierSaved')}</summary>
    <SavedChatList key={scopeReset} embedded initialChats={legacyChats} nextCursor={savedChats?.nextCursor??null} scopeDigest={scopeReset} activeThreadId={selectedChat?.threadId} newChatHref={newChatHref}/>
  </details>:null;
  const activeTitle=selectedChat?legacyChats.find(chat=>chat.threadId===selectedChat.threadId)?.title??null:null;

  return (
    <div data-tour="intelligence-assistant" data-ai-centre="ask" className="mx-auto flex h-full min-h-[32rem] max-w-7xl flex-col gap-4">
      {centreTabs}
      <h1 className="sr-only">{aiCentreName((await getTranslations('aiCentre'))('genericName'))}</h1>
      <ErrorBanner message={errorMessage??((sp.e&&!selectedChat)||(sp.chat&&!sp.e&&!storedChat)?t('workspace.conversation.unavailable'):undefined)} />
      <AskChatsProvider initialChats={chatSummaries} nextCursor={storedChats?.nextCursor??null} activeChatId={storedChat?.chatId??null} activeTitle={activeTitle}
        today={today} keepDays={keepDays} newChatHref={newChatHref} privacyHref="/assistant?view=privacy" toolsHref="/assistant?view=tools" listUnavailable={storedChats===null} legacy={legacy}>
        <div className="grid min-h-0 flex-1 items-stretch gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside aria-label={a('chats')} className="flex min-h-0 min-w-0 flex-col max-lg:hidden lg:border-r lg:border-border lg:pr-5">
            <AskChatsColumn/>
          </aside>
          <div data-ask-conversation className="flex min-h-0 min-w-0 flex-col">
            <AskChatHeader/>
            <WorkspaceConversation key={scopeReset+':'+(sp.e??'')+':'+(sp.chat&&!sp.e?'chat-'+sp.chat:'')+':'+(sp.chatReset??'')} fullHeight fill acceptCommandBar resetKey={(sp.chatReset??'')+':'+scopeReset} fileImport={(s.roles??[]).some(role=>role==='hr_admin'||role==='super_admin')} chatImport={chatImport} tasks={tasks}
              initialTurns={initialTurns} acceptHandoff={!sp.e&&!sp.chat} historyReadOnly={Boolean((sp.e&&!selectedChat?.resume)||(storedChat&&!storedResume))} initialResume={selectedChat?.resume??storedResume} historyTailId={sp.e} olderCursor={selectedChat?.olderCursor??undefined}/>
            {/* Phones: the column is a drawer, so its footer also sits under the composer and Your data and privacy
                stays within two clicks of every AI Centre page. */}
            <AskChatsFooter className="shrink-0 pt-1 lg:hidden"/>
          </div>
        </div>
      </AskChatsProvider>
    </div>
  );
}
