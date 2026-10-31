/** The same authorized answer and visible terminal state in home and floating chat. */
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '../../db/client';
import type {loadAiWorkspace} from '../../core/ai-workspace';
import {toolsFor} from '../../core/assistant-tools';
import {workspaceTasksFor,type AiWorkspaceTaskId} from '../../lib/ai/workspace-tasks';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {ConversationSuggestions} from './chat-reply-boundary';
import {MAX_TURNS} from '../../core/assistant';
import {GroundedWorkspaceReply} from './module-jobs';
import {saveAgentFeedbackAction} from '../../app/(app)/assistant/feedback-actions';
type Exchange=Awaited<ReturnType<typeof loadAiWorkspace>>['history'][number];
export async function ExchangeReply({exchange:h,ctx}:{exchange:Exchange;ctx:SessionContext}){
 const t=await getTranslations('assistant');
 const checked=[...new Set((h.grounded?.tools??[]).filter(name=>t.has(`workspace.answers.tool_${name}`)))];
 const plan=h.grounded?.conversation?.plan;
 let offered:AiWorkspaceTaskId[]=[];try{offered=workspaceTasksFor(toolsFor(ctx).map(tool=>tool.spec.name));}catch{/* Optional suggestions never suppress the checked answer. */}
 const candidates:readonly AiWorkspaceTaskId[]=plan?.mode==='social'&&plan.code==='help'?['module_overview','leave_available']:
  checked.includes('my_leave_balances')?['leave_requests','holidays']:checked.includes('my_leave_requests')?['leave_available','holidays']:
  checked.includes('my_module_work')?['leave_available','claim_statuses']:[];
 const suggestions=(h.stop==='end'&&plan&&(plan.mode==='answer'||plan.mode==='social')?candidates:[]).filter(id=>offered.includes(id)).slice(0,2).map(id=>({label:t(`workspace.${id}_label`),prompt:t(`workspace.${id}_prompt`,{date:todayInKualaLumpur()})}));
 return <div className="space-y-3">
  {h.grounded?<GroundedWorkspaceReply reply={h.grounded} ctx={ctx} exchangeId={h.id}/>:<p role="status" className="text-sm text-muted-foreground">{t('workspace.conversation.unavailable')}</p>}
  {h.stop&&h.stop!=='end'&&<p role="status" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">{h.hitTurnCap?t('stop_turn_cap',{n:MAX_TURNS}):t(`stop_${h.stop}`)}</p>}
  {checked.length>0&&<details className="text-xs text-muted-foreground"><summary className="min-h-11 w-fit cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('workspace.chat.activity',{n:checked.length})}</summary><ul className="space-y-2 pb-3">{checked.map(name=><li key={name}>{t(`workspace.answers.tool_${name}`)}</li>)}</ul></details>}
  <ConversationSuggestions suggestions={suggestions} label={t('workspace.chat.suggested')}/>
  <details className="text-xs text-muted-foreground">
   <summary className="w-fit min-h-11 cursor-pointer py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('workspace.chat.rate')}</summary>
   <form action={saveAgentFeedbackAction} className="space-y-3 pb-3">
    <input type="hidden" name="exchangeId" value={h.id}/>
    <label className="flex items-start gap-2"><input type="checkbox" name="consented" value="yes" required className="mt-0.5"/><span>{t('workspace.feedbackConsent')}</span></label>
    <div className="flex flex-wrap gap-2" aria-label={t('workspace.feedbackTitle')}>
     {(['helpful','needs_correction','incorrect'] as const).map(outcome=><button key={outcome} type="submit" name="outcome" value={outcome} className="min-h-11 rounded-md border px-3 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t(`workspace.feedback_${outcome}`)}</button>)}
    </div>
   </form>
  </details>
 </div>;
}
