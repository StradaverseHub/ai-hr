import {AssistantHistoryPrivacy} from '../../components/assistant/history-privacy';
import {OwnClearForm,OwnClearStatus} from '../../components/assistant/own-clear';
import {eraseConversationMetadataAction} from './agent-review-actions';
import {NativeOutcomes,NativeOutcomePrivacy} from '@/components/assistant/native-outcomes';
import {ImportPreparationPrivacy} from '@/components/assistant/import-privacy';
import { getTranslations } from 'next-intl/server';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { getSession } from '@/lib/session';
import { loadAiWorkspace } from '@/core/ai-workspace';
import {CanonicalModuleJob,ModuleJobChooser,GroundedWorkspaceReply,GovernedModuleJobComposer,GovernedWorkspaceJob} from '@/components/assistant/module-jobs';
import {loadCanonicalModuleJob} from '@/core/workspace-module-jobs';
import {allowedModuleActionEntries} from '@/core/assistant-actions/module-action-entries';
import {ModuleQuestionPlanner} from '@/components/assistant/module-plan';
import {eraseModuleProposalsAction} from './module-plan-actions';
import {SpecialistJobComposer} from '@/components/assistant/module-specialist-review';
import { WorkspaceComposer } from '@/components/assistant/workspace-composer';
import { MAX_TURNS } from '@/core/assistant';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { askAssistantAction } from './actions';
import {eraseGovernedJobFeedbackAction} from './job-feedback-actions';
import { saveAgentFeedbackAction, eraseAgentFeedbackAction } from './feedback-actions';

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
  searchParams: Promise<{ e?: string; error?: string;job?:string;governed?:string;proposal?:string;planning?:string;importHistory?:string;nativeOutcome?:string;nativeLink?:string;historyPrivacy?:string;ownClear?:string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('assistant');
  const sp = await searchParams;
  const errorMessage=sp.error==='clarification_unavailable'?t('workspace.conversation.unavailable'):
    sp.error&&/^[a-z_]{1,40}$/.test(sp.error)&&t.has(`err_${sp.error}`)?t(`err_${sp.error}`):undefined;
  const workspace = await loadAiWorkspace(s,{includeHistory:sp.job===undefined&&sp.governed===undefined&&sp.proposal===undefined,includeGovernance:false,selectedExchangeId:sp.e,governedJobId:sp.governed,proposalId:sp.proposal});
  const access = workspace.access;

  if (!access.allowed) {
    return (
      <div data-tour="intelligence-assistant" className="mx-auto max-w-5xl space-y-5">
        <PageHeader title={t('title')} description={t('description')} />
      <AssistantHistoryPrivacy status={sp.historyPrivacy}/>
      <OwnClearStatus status={sp.ownClear}/>
        <Card className="p-6">
          {/* Three different reasons, three different next steps. "No" with no route forward is the one
              thing this must not render. */}
          <p className="text-sm text-muted-foreground">{t(`denied_${access.reason}`)}</p>
          <div className="mt-4"><OwnClearForm kind="feedback" action={eraseAgentFeedbackAction} label={t('workspace.feedbackErase')}/></div>
          <OwnClearForm kind="conversation" action={eraseConversationMetadataAction} label={t('workspace.conversationGovernance.erase')}/>
          <OwnClearForm kind="proposals" action={eraseModuleProposalsAction} label={t('workspace.planning.erase')}/>
          <ImportPreparationPrivacy status={sp.importHistory}/><NativeOutcomePrivacy status={sp.nativeOutcome}/>
          <OwnClearForm kind="ratings" action={eraseGovernedJobFeedbackAction} label={t('workspace.governed.eraseSignals')}/>
        </Card>
      </div>
    );
  }

  const { history } = workspace;
  const selectedJob=sp.job===undefined||sp.governed!==undefined?null:await loadCanonicalModuleJob(s,{module:sp.job});
  // Shortcuts are offered only where the target's own authorization rules admit this session.
  const actionEntries=await allowedModuleActionEntries(s,workspace.jobModules);
  const today = todayInKualaLumpur();
  const tasks = workspace.taskIds.map(id => ({
    id, label: t(`workspace.${id}_label`), prompt: t(`workspace.${id}_prompt`, { date: today }),
  }));

  return (
    <div data-tour="intelligence-assistant" className="mx-auto max-w-5xl space-y-5">
      <PageHeader title={t('title')} description={t('description')} />
      <AssistantHistoryPrivacy status={sp.historyPrivacy}/>
      <OwnClearStatus status={sp.ownClear}/>
      <OwnClearForm kind="conversation" action={eraseConversationMetadataAction} label={t('workspace.conversationGovernance.erase')}/>
      <ErrorBanner message={errorMessage} />

      <ModuleJobChooser modules={workspace.jobModules} selected={sp.job} actions={actionEntries}/>
      {selectedJob&&<CanonicalModuleJob view={selectedJob} ctx={s}/>}
      {workspace.governedJob&&<GovernedWorkspaceJob view={workspace.governedJob} ctx={s}/>}
      {workspace.governedJob&&sp.governed&&<NativeOutcomes jobId={sp.governed} status={sp.nativeOutcome} selectedLink={sp.nativeLink}/>}
      <GovernedModuleJobComposer modules={workspace.jobModules}/>
      <SpecialistJobComposer modules={workspace.jobModules}/>
      <ModuleQuestionPlanner permit={workspace.planningPermit} availability={workspace.planningAvailability} view={workspace.proposal} status={sp.planning??(sp.proposal&&!workspace.proposal?'unavailable':undefined)}/>

      <Card className="p-5">
        <WorkspaceComposer action={askAssistantAction} tasks={tasks} labels={{
          tasks: t('workspace.tasks'), taskHint: t('workspace.taskHint'), question: t('workspace.question'),
          placeholder: t('placeholder'), ask: t('ask'), working: t('workspace.working'), scope: t('scopeNote'),
        }} />
      </Card>

      {/* Candidate reviews for group administrators live on AI management › Assistant. */}

      {!selectedJob&&!workspace.governedJob&&history.length > 0 && <section aria-labelledby="assistant-history-heading" className="space-y-5">
      <h2 id="assistant-history-heading" className="text-sm font-medium">{t('workspace.history')}</h2>
      {history.map((h) => (
        <Card key={h.id} className={`p-5 ${h.id === sp.e ? 'ring-1 ring-primary' : ''}`}>
          <p className="text-sm font-medium">{h.question}</p>

          {h.grounded?<GroundedWorkspaceReply reply={h.grounded} ctx={s} exchangeId={h.id}/>:
          h.hasAnswer?<a href={'/assistant?e='+encodeURIComponent(h.id)} className="mt-3 inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('workspace.answers.check')}</a>:
          <p className="mt-2 text-sm text-muted-foreground">{t('noAnswer')}</p>}

          {/* §2.5 — every terminal state that is not `end` is VISIBLE. `refusal` is its own case rather
              than an error: the model declined, which is a real outcome the asker should see as one. */}
          {h.stop && h.stop !== 'end' && (
            <p className="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {h.hitTurnCap ? t('stop_turn_cap', { n: MAX_TURNS }) : t(`stop_${h.stop}`)}
            </p>
          )}

          <form action={saveAgentFeedbackAction} className="mt-4 space-y-2 border-t pt-3">
            <input type="hidden" name="exchangeId" value={h.id} />
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" name="consented" value="yes" required className="mt-0.5" />
              <span>{t('workspace.feedbackConsent')}</span>
            </label>
            <div className="flex flex-wrap gap-2" aria-label={t('workspace.feedbackTitle')}>
              {(['helpful', 'needs_correction', 'incorrect'] as const).map(outcome => <button
                key={outcome} type="submit" name="outcome" value={outcome}
                className="min-h-11 rounded-md border px-3 py-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {t(`workspace.feedback_${outcome}`)}
              </button>)}
            </div>
          </form>

          {h.toolCalls.length > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {t('lookedAt', { tools: [...new Set(h.toolCalls.map((c) => c.name))].join(', ') })}
            </p>
          )}
        </Card>
      ))}

      <OwnClearForm kind="feedback" action={eraseAgentFeedbackAction} label={t('workspace.feedbackErase')}/>
      </section>}
      {!selectedJob&&!workspace.governedJob&&history.length === 0 && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </Card>
      )}
      <ImportPreparationPrivacy status={sp.importHistory}/><NativeOutcomePrivacy status={sp.nativeOutcome}/>
    </div>
  );
}
