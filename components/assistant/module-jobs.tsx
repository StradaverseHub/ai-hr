import {personnelReviewTitleKey} from '../../lib/ai/personnel-review-labels';
import {assistantReadableModules} from '../../core/assistant-readable-modules';
import {todayInKualaLumpur} from '../../lib/hr-date';
/** Canonical typed facts only. A model answer, copied receipt or arbitrary JSON cannot render here. */
import type {ReactNode} from 'react';
import {conversationFactLayout} from '../../lib/ai/assistant-answer-layout';
import {assistantFactSentenceKey} from '../../lib/ai/assistant-fact-sentences';
import {randomUUID} from 'node:crypto';
import {ConversationClarification,ConversationActionProposal} from './chat-reply-boundary';
import {saveGovernedJobFeedbackAction,eraseGovernedJobFeedbackAction} from '../../app/assistant/job-feedback-actions';
import {runGovernedPlanAction} from '../../app/assistant/governed-job-actions';
import type {GovernedWorkspaceJobView} from '../../core/workspace-module-jobs';
import {getLocale,getTranslations} from 'next-intl/server';
import {Card} from '../ui';
import type {SessionContext} from '../../db/client';
import {assertCanonicalModuleJobView,type CanonicalModuleJobView} from '../../core/workspace-module-jobs';
import type {AgentModuleCode} from '../../lib/ai/module-agents';
import type {JobFact,JobCard} from '../../lib/ai/module-jobs';
import type {GroundedWorkspaceAnswer,AssistantConversationSegment} from '../../core/workspace-grounded-answers';
import {MODULE_JOBS} from '../../lib/ai/module-jobs';
import type {ModuleActionEntry} from '../../lib/assistant-actions/module-action-entries';
import {ConversationReviewLinks} from './conversation-review-links';
import {moduleHumanActionHandoffs} from '../../lib/ai/module-human-handoffs';
import {ASSISTANT_PROPOSAL_MODULE,isAssistantProposableAction} from '../../lib/ai/assistant-action-proposal-hints';
import {ConversationExplanation} from './conversation-explanation';
import {AssistantCatalogueSummary} from './assistant-catalogue-summary';
import {ModuleSpecialistFindings} from './module-specialist-findings';
import {OwnClearForm} from './own-clear';
const knownStates=new Set(['active','probation','resigned','terminated','pending','approved','rejected','cancelled','draft','paid','closed','completed','in_progress','not_tested','passed','failed','skipped','annual','offcycle','regular','day','hour','not_started','self_review','manager_review','submitted','acknowledged','present','absent','late','half_day','active_serving_notice','blacklisted','withhold','full_day','half_day_am','half_day_pm','hourly','administrative','functional','taken','converted_to_pay','lapsed','reversed','pass','fail','blocked','partial','manager','report']);
/** Gated native-action shortcuts render only when the caller passes them in `actions` (server-computed
 * from the target's own authorization rules). Missing means hidden. Targets still refuse on their own. */
export async function ModuleJobChooser({modules,selected,actions=[]}:{modules:readonly AgentModuleCode[];selected?:string;actions?:readonly ModuleActionEntry[]}){
 const annualReturn=await getTranslations('assistant.workspace.rewardsAnnualReturn'),calendar=await getTranslations('assistant.workspace.rewardsCalendar'),cancellation=await getTranslations('assistant.workspace.rewardsCancellation'),t=await getTranslations('assistant.workspace.jobs'),leave=await getTranslations('ownLeaveReview.workflow'),notifications=await getTranslations('assistant.workspace.moduleActions'),profile=await getTranslations('assistant.workspace.profileActions'),performance=await getTranslations('assistant.workspace.performanceActions'),claims=await getTranslations('assistant.workspace.claimActions'),testing=await getTranslations('assistant.workspace.testingActions'),org=await getTranslations('assistant.workspace.orgActions'),knowledge=await getTranslations('assistant.workspace.knowledgeActions'),lifecycle=await getTranslations('assistant.workspace.lifecycleActions'),toil=await getTranslations('assistant.workspace.toilActions'),approvals=await getTranslations('assistant.workspace.approvalActions'),attendance=await getTranslations('assistant.workspace.attendanceActions'),payComponents=await getTranslations('assistant.workspace.payComponentActions'),rewards=await getTranslations('assistant.workspace.rewardsActions'),employeeImport=await getTranslations('people.import'),payrollClose=await getTranslations('assistant.workspace.payrollCloseActions'),countryStatutory=await getTranslations('assistant.workspace.countryStatutoryActions'),multiCycleRun=await getTranslations('assistant.workspace.multiCycleRunActions');
 return <section aria-labelledby="assistant-canonical-jobs" className="space-y-3">
  <div><h2 id="assistant-canonical-jobs" className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p></div>
  <div className="grid gap-2 sm:grid-cols-2">{MODULE_JOBS.filter(([module])=>modules.includes(module)).map(([module])=><div key={module} className="space-y-1"><a
   href={'/assistant?job='+encodeURIComponent(module)} aria-current={selected===module?'page':undefined}
   className={`block min-h-20 rounded-lg border p-3 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none ${selected===module?'border-primary bg-primary/5':'border-border bg-card'}`}>
   <span className="block text-sm font-medium">{t(`module_${module}`)}</span><span className="mt-1 block text-xs text-muted-foreground">{t(`help_${module}`)}</span>
  </a>{module==='multi_cycle_payroll'&&actions.includes('multi_cycle_run')&&<a href="/assistant/payroll-runs" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{multiCycleRun('title')}</a>}{module==='country-my'&&actions.includes('country_statutory')&&<a href="/assistant/statutory" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{countryStatutory('title')}</a>}{module==='payroll'&&actions.includes('payroll_close')&&<a href="/assistant/payroll-close" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{payrollClose('title')}</a>}{module==='employees'&&actions.includes('employee_import')&&<a href="/admin/personnel/import" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{employeeImport('title')}</a>}{module==='rewards'&&actions.includes('rewards_return')&&<a href="/assistant/rewards/return" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{annualReturn('title')}</a>}{module==='rewards'&&actions.includes('rewards_calendar')&&<a href="/assistant/rewards/calendar" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{calendar('title')}</a>}{module==='rewards'&&actions.includes('rewards_cancel')&&<a href="/assistant/rewards/cancel" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{cancellation('title')}</a>}{module==='rewards'&&actions.includes('rewards')&&<a href="/assistant/rewards" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{rewards('title')}</a>}{module==='typed_pay_components'&&actions.includes('pay_component')&&<a href="/assistant/pay-codes" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{payComponents('title')}</a>}{module==='attendance'&&<a href="/assistant/attendance" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{attendance('title')}</a>}{module==='approvals'&&actions.includes('assigned_leave')&&<a href="/assistant/approvals" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{approvals('title')}</a>}{module==='leave'&&<a href="/assistant/leave" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{leave('title')}</a>}{module==='notifications'&&<a href="/assistant/notifications" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{notifications('title')}</a>}{module==='ess'&&<a href="/assistant/profile" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{profile('title')}</a>}{module==='performance'&&<a href="/assistant/performance" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{performance('title')}</a>}{module==='claims'&&<a href="/assistant/claims" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{claims('title')}</a>}{module==='system_testing'&&<a href="/assistant/testing" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{testing('title')}</a>}{module==='org'&&actions.includes('org')&&<a href="/assistant/org" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{org('title')}</a>}{module==='knowledge_base'&&actions.includes('knowledge')&&<a href="/assistant/knowledge-base" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{knowledge('title')}</a>}{module==='lifecycle'&&<a href="/assistant/lifecycle" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{lifecycle('title')}</a>}{module==='toil'&&<a href="/assistant/toil" className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{toil('title')}</a>}</div>)}</div>
 </section>;
}
async function canonicalJobText(){
 const[t,answers,gap,rewardStage,rewardKind,locale,reviewTitles]=await Promise.all([getTranslations('assistant.workspace.jobs'),getTranslations('assistant.workspace.answers'),getTranslations('controlTower.readinessScreen.gap'),getTranslations('rewards.stages'),getTranslations('rewards.kinds'),getLocale(),getTranslations()]);
 const safeLocale=['en','ms','zh','ta','th','vi'].includes(locale)?locale:'en';return{t,answers,gap,rewardStage,rewardKind,safeLocale,reviewTitles};
}
type CanonicalJobText=Awaited<ReturnType<typeof canonicalJobText>>;
function displayCanonicalFact(fact:JobFact,module:AgentModuleCode,text:CanonicalJobText){
 const{t,rewardStage,rewardKind,safeLocale}=text;
  if(fact.value===null)return t('unknown');
  if(fact.format==='boolean'&&typeof fact.value==='boolean')return t(fact.value?'yes':'no');
  if(fact.format==='module'&&typeof fact.value==='string'&&MODULE_JOBS.some(([module])=>module===fact.value))return t(`module_${fact.value}`);
 if(fact.format==='performanceFramework'&&typeof fact.value==='string'&&['standard','onehr'].includes(fact.value))return t(`framework_${fact.value}`);
 if(fact.format==='performanceArtifact'&&typeof fact.value==='string'&&['review','plan'].includes(fact.value))return t(`artifact_${fact.value}`);
  if(fact.format==='blocks'&&typeof fact.value==='string')return t(`blocks_${fact.value}`);
  if(module==='rewards'&&fact.field==='status'&&typeof fact.value==='string'&&['draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn'].includes(fact.value))return rewardStage(fact.value);
  if(module==='rewards'&&fact.field==='rewardKind'&&typeof fact.value==='string'&&['annual','adhoc','midyear'].includes(fact.value))return rewardKind(fact.value);
  if(fact.format==='testingStatus'&&typeof fact.value==='string'&&['not_started','in_progress','passed','failed','blocked','retest_required','not_applicable','partial'].includes(fact.value))return t(`testing_state_${fact.value}`);
  if(fact.format==='status'&&typeof fact.value==='string'&&knownStates.has(fact.value))return t(`state_${fact.value}`);
  if(fact.format==='date'&&typeof fact.value==='string'){
   const date=new Date(fact.value.length===10?fact.value+'T00:00:00Z':fact.value);
   if(Number.isFinite(date.getTime()))return new Intl.DateTimeFormat(safeLocale,{dateStyle:'medium',timeZone:fact.value.length===10?'UTC':'Asia/Kuala_Lumpur'}).format(date);
  }
  // Monetary decimals are copied verbatim: no currency substitution, arithmetic or display rounding.
  return String(fact.value);
}

function canonicalHeading(card:JobCard,{t,gap,reviewTitles}:CanonicalJobText){const key=card.title.kind==='module'&&card.linkPurpose==='human_review'?personnelReviewTitleKey(card.title.module,card.href):null;if(key)return reviewTitles(key);return card.title.kind==='text'?card.title.value:card.title.kind==='gap'?gap(card.title.code):card.title.kind==='module'?t(`module_${card.title.module}`):t('record',{n:card.title.number});}
export async function CanonicalModuleJob({view,ctx}:{view:CanonicalModuleJobView;ctx:SessionContext}){
 const text=await canonicalJobText(),{t,answers,safeLocale}=text;
 try{assertCanonicalModuleJobView(view,ctx);}catch{return <Card className="p-5"><p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p></Card>;}
 if(view.state==='unavailable')return <Card className="p-5"><p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p></Card>;
 const presentation=view.presentation,headingId='assistant-job-'+view.viewId;
 return <section aria-labelledby={headingId} className="space-y-3">
  <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={headingId} className="text-lg font-semibold">{view.toolName?answers(`tool_${view.toolName}`):t(`module_${presentation.module}`)}</h2>
   <p className="mt-1 text-xs text-muted-foreground">{t('canonicalNote')}</p></div><form action="/assistant" method="get"><input type="hidden" name="job" value={presentation.module}/><button type="submit" className="min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('refresh')}</button></form></header>
  <p className="text-xs text-muted-foreground">{t('checkedAt',{time:new Intl.DateTimeFormat(safeLocale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(view.checkedAt))})}</p>
  {presentation.cards.length===0&&<Card className="p-5"><p className="text-sm text-muted-foreground">{t(presentation.hasEmployment===false?'noEmployment':'noData')}</p></Card>}
  <div className="grid gap-3 sm:grid-cols-2">{presentation.cards.map((card,index)=><Card key={index} className="min-w-0 p-4">
   <h3 className="break-words text-sm font-semibold">{canonicalHeading(card,text)}</h3>
   {card.title.kind==='module'&&<p className="mt-2 text-xs text-muted-foreground">{card.linkPurpose==='human_review'?t('humanReviewNote'):t(`help_${card.title.module}`)}</p>}
   {card.facts.length>0&&<dl className="mt-3 space-y-2">{card.facts.map((fact,i)=><div key={i} className="flex items-start justify-between gap-4 text-sm">
    <dt className="min-w-0 text-muted-foreground">{t(`field_${fact.field}`)}</dt><dd className="max-w-[65%] break-words text-right tabular-nums">{displayCanonicalFact(fact,presentation.module,text)}</dd>
   </div>)}</dl>}
   {card.withheld&&<p className="mt-3 text-xs text-muted-foreground">{t('withheld')}</p>}
   {card.title.kind==='module'&&card.linkPurpose!=='human_review'&&<a href={'/assistant?job='+card.title.module} className="mt-3 inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('open')}</a>}
   {card.href&&<a href={card.href} className="mt-3 inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{card.linkPurpose==='human_review'&&card.title.kind==='module'&&personnelReviewTitleKey(card.title.module,card.href)?text.reviewTitles(personnelReviewTitleKey(card.title.module,card.href)!):t(card.linkPurpose==='human_review'?'reviewAction':'original')}</a>}
  </Card>)}</div>
  {presentation.truncated&&<p className="text-sm text-muted-foreground">{t('truncated')}</p>}
  {view.specialist&&<ModuleSpecialistFindings assessment={view.specialist} selection={view.specialistVersion}/>}
  {['payroll','typed_pay_components'].includes(presentation.module)&&<p className="text-xs text-muted-foreground">{t('moneyNote')}</p>}
  {presentation.module==='notifications'&&<p className="text-xs text-muted-foreground">{t('notificationNote')}</p>}
 </section>;
}

type ConversationReply=NonNullable<GroundedWorkspaceAnswer['conversation']>;
const closedConversationFields=(value:object,fields:readonly string[])=>JSON.stringify(Object.keys(value).sort())===JSON.stringify([...fields].sort());
/** Selection/order comes from the checked plan; every displayed value still comes from an original
 * fresh canonical view. Unknown plans, hidden/null facts and unsupported explanations refuse. */
async function ConversationReplyBody({conversation,ctx,exchangeId}:{conversation:ConversationReply;ctx:SessionContext;exchangeId?:string}){
 const[copy,text,workspaceCopy]=await Promise.all([getTranslations('assistant.workspace.conversation'),canonicalJobText(),getTranslations('assistant.workspace')]);
 const unavailable=()=> <p role="status" className="text-sm text-muted-foreground">{copy('unavailable')}</p>;
 try{
  const plan=conversation.plan;if(!closedConversationFields(conversation,['plan','facts',...(conversation.clarificationAllowed===undefined?[]:['clarificationAllowed']),...(conversation.segments===undefined?[]:['segments']),...(conversation.proposalStale===undefined?[]:['proposalStale']),...(conversation.proposalUnverified===undefined?[]:['proposalUnverified'])])||!Array.isArray(conversation.facts)||(conversation.clarificationAllowed!==undefined&&conversation.clarificationAllowed!==false)||(conversation.proposalStale!==undefined&&(conversation.proposalStale!==true||plan?.mode!=='propose'))||(conversation.proposalUnverified!==undefined&&(conversation.proposalUnverified!==true||plan?.mode!=='propose'||conversation.proposalStale!==undefined))||!plan||plan.version!==1)return unavailable();
  if(plan.mode!=='answer'&&conversation.segments!==undefined)return unavailable();
  if(plan.mode==='social'){
   if(!closedConversationFields(plan,['version','mode','code'])||!['greeting','thanks','help'].includes(plan.code)||conversation.facts.length!==0)return unavailable();
   return <p className="text-sm leading-relaxed">{copy(`social_${plan.code}`)}</p>;
  }
  if(plan.mode==='clarify'){
   if(!closedConversationFields(plan,['version','mode','slot'])||!['employment','leave_type','period','module'].includes(plan.slot)||conversation.facts.length!==0)return unavailable();
   const taskModules={leave_available:'leave',leave_requests:'leave',claim_statuses:'claims',holidays:'org',reporting_line:'org',work_profile:'employees',payslip:'payroll',module_overview:'assistant'} as const;
   // Optional shortcuts cannot suppress the existing owned reply form or exhausted-context notice.
   // An absent offering snapshot grants nothing; the actual command reauthorizes every reply.
   const choices=plan.slot==='module'&&conversation.clarificationAllowed!==false?(()=>{try{const readable=assistantReadableModules(ctx);return Object.entries(taskModules).filter(([,module])=>readable.includes(module)).map(([task])=>({label:workspaceCopy(`${task}_label`),prompt:workspaceCopy(`${task}_prompt`,{date:todayInKualaLumpur()})}));}catch{return [];}})():undefined;
   const bound=typeof exchangeId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(exchangeId),labelId=bound?'assistant-clarification-'+exchangeId:'assistant-clarification-unavailable';
   return <section aria-labelledby={labelId} className="space-y-3"><h2 id={labelId} className="text-base font-medium">{copy(`clarify_${plan.slot}`)}</h2>
    {conversation.clarificationAllowed===false?<p role="status" className="text-sm text-muted-foreground">{copy('contextLimit')}</p>:bound?<ConversationClarification exchangeId={exchangeId!} replyLabel={copy('replyLabel')} continueLabel={copy('continue')} choices={choices}/>:<p role="status" className="text-sm text-muted-foreground">{copy('reopenBeforeReply')}</p>}
   </section>;
  }
  // ADR-0151 §4.3: an adjudicated proposal renders the inline review card. It is a suggestion only: the
  // card's panels read the caller's own fresh choices, and only the person's own click prepares anything.
  if(plan.mode==='propose'){
   if(!closedConversationFields(plan,['version','mode','action','hints'])||conversation.facts.length!==0||!isAssistantProposableAction(plan.action))return unavailable();
   if(!moduleHumanActionHandoffs(ASSISTANT_PROPOSAL_MODULE[plan.action]).some(handoff=>handoff.action===plan.action))return unavailable();
   // Review R6: a sealed proposal the caller's current catalogue no longer offers is refused with a refresh;
   // one that could not be checked right now gets a neutral retry. Neither can be prepared from.
   return <ConversationActionProposal action={plan.action} hints={plan.hints} availability={conversation.proposalStale===true?'stale':conversation.proposalUnverified===true?'unverified':'current'}/>;
  }
  if(plan.mode==='insufficient'||plan.mode==='refuse'){
   const codes=plan.mode==='insufficient'?['no_verified_facts','unsupported_explanation']:['unsupported_request','human_review_required'];
   if(!closedConversationFields(plan,['version','mode','code'])||!codes.includes(plan.code)||conversation.facts.length!==0)return unavailable();
   return <p role="status" className="text-sm">{copy(`${plan.mode}_${plan.code}`)}</p>;
  }
  if(plan.mode!=='answer'||!closedConversationFields(plan,['version','mode','blocks'])||!Array.isArray(plan.blocks)||plan.blocks.length===0||plan.blocks.length>16||plan.blocks.filter(block=>block.kind==='fact').length!==conversation.facts.length)return unavailable();
  const segments=conversation.segments??conversation.facts.map(fact=>({kind:'fact' as const,...fact}));
  if(!Array.isArray(segments)||segments.length!==plan.blocks.length)return unavailable();
  const renderedFacts:{view:Extract<CanonicalModuleJobView,{state:'ready'}>;card:number;fact:number;value:string;content:ReactNode}[]=[];
  let factIndex=0;const views:CanonicalModuleJobView[]=[],lines=await Promise.all(plan.blocks.map(async(block,index)=>{
   const selected:AssistantConversationSegment=segments[index];
   if(!selected||!Number.isSafeInteger(block.read)||block.read<0||block.read>=128)throw Error();
   assertCanonicalModuleJobView(selected.view,ctx);if(selected.view.state!=='ready')throw Error();
   if(!views.includes(selected.view))views.push(selected.view);
   if(block.kind==='explanation'){
    if(selected.kind!=='explanation'||!closedConversationFields(block,['kind','read','card','code'])||!closedConversationFields(selected,['kind','view','explanation'])||selected.explanation.card!==block.card||selected.explanation.code!==block.code||!selected.view.answerExplanations?.includes(selected.explanation))throw Error();
    const card=selected.explanation.card===null?null:selected.view.presentation.cards[selected.explanation.card];
    const company=card?.facts.find(fact=>fact.field==='company'&&typeof fact.value==='string')?.value;
    const heading=card?canonicalHeading(card,text):text.t(`module_${selected.view.presentation.module}`);
    return <div key={index} className="space-y-1 break-words text-sm leading-relaxed">{card&&<p className="text-xs text-muted-foreground">{heading}{typeof company==='string'&&company!==heading?` (${company})`:''}</p>}{await ConversationExplanation({view:selected.view,explanation:selected.explanation,ctx})}</div>;
   }
   const paired=conversation.facts[factIndex++];
   if(selected.kind!=='fact'||!closedConversationFields(selected,['kind','view','card','fact'])||!paired||paired.view!==selected.view||paired.card!==selected.card||paired.fact!==selected.fact)throw Error();
   if(block.kind!=='fact'||!closedConversationFields(block,['kind','read','card','fact'])||!Number.isSafeInteger(block.read)||block.read<0||!selected||selected.card!==block.card||selected.fact!==block.fact||!Number.isSafeInteger(selected.card)||selected.card<0||!Number.isSafeInteger(selected.fact)||selected.fact<0)throw Error();
   assertCanonicalModuleJobView(selected.view,ctx);if(selected.view.state!=='ready')throw Error();
   const card=selected.view.presentation.cards[selected.card],fact=card?.facts[selected.fact];if(!card||(card.withheld&&selected.view.presentation.module!=='leave')||!fact||fact.value===null||typeof fact.value==='string'&&fact.value.trim()===''||typeof fact.value==='number'&&!Number.isFinite(fact.value))throw Error();
   let value=displayCanonicalFact(fact,selected.view.presentation.module,text);
   if(fact.format==='money'){
    const units=card.facts.filter(row=>row.field==='currency');if(units.length!==1||typeof units[0].value!=='string'||!/^[A-Z]{3}$/.test(units[0].value))throw Error();
    value=String(value)+' '+units[0].value;
   }
   const progress=fact.field==='progressPercent'&&typeof fact.value==='number'&&fact.value>=0&&fact.value<=100
    ? <progress aria-label={text.t('field_progressPercent')} value={fact.value} max={100} className="mt-2 block h-2 w-full max-w-sm accent-primary">{fact.value}%</progress>:null;
   const sentence=copy(`natural.${assistantFactSentenceKey(selected.view.presentation.module,card,fact,selected.view.toolName)}`,{record:canonicalHeading(card,text),field:text.t(`field_${fact.field}`),value:String(value)});
   const content=<><span className="tabular-nums">{sentence}</span>{progress}{card.withheld&&<span className="block text-xs text-muted-foreground">{text.t('withheld')}</span>}</>;
   renderedFacts.push({view:selected.view,card:selected.card,fact:selected.fact,value:String(value),content});
   return <p key={index} className="break-words text-sm leading-relaxed">{content}</p>;
  }));
  const factOnly=plan.blocks.every(block=>block.kind==='fact');
  const layout=factOnly?conversationFactLayout(renderedFacts.map(row=>({sourceKey:row.view.viewId,presentation:row.view.presentation,card:row.card,fact:row.fact}))):{kind:'list' as const};
  const answerBody=layout.kind==='comparison'?<div role="region" aria-label={copy('comparison')} tabIndex={0} className="max-w-full overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
   <table className="w-full text-left text-sm"><caption className="px-3 py-2 text-left text-xs text-muted-foreground">{copy('comparison')}</caption>
    <thead className="bg-muted/40"><tr><th scope="col" className="px-3 py-2 font-medium">{copy('recordColumn')}</th>{layout.columns.map(column=><th key={column.field} scope="col" className="px-3 py-2 font-medium">{text.t(`field_${column.field}`)}</th>)}</tr></thead>
    <tbody>{layout.rows.map(row=>{const first=renderedFacts[row.positions[0]],card=first.view.presentation.cards[first.card],heading=canonicalHeading(card,text),company=card.facts.find(fact=>fact.field==='company'&&typeof fact.value==='string')?.value;
     return <tr key={row.sourceKey+':'+row.card} className="border-t"><th scope="row" className="max-w-xs break-words px-3 py-2 align-top font-medium">{heading}{typeof company==='string'&&company!==heading?` (${company})`:''}</th>{row.positions.map((position,index)=><td key={index} className="break-words px-3 py-2 align-top tabular-nums">{renderedFacts[position].value}</td>)}</tr>;
    })}</tbody>
   </table></div>:factOnly&&renderedFacts.length===1?<p className="break-words text-sm leading-relaxed">{renderedFacts[0].content}</p>:
    <div data-conversation-paragraphs="" className="space-y-3">{lines}</div>;
  const sources=await Promise.all(views.map(async view=>({id:view.viewId,card:await CanonicalModuleJob({view,ctx})})));
  return <section aria-label={copy('answerLabel')} className="space-y-3">{answerBody}
   {renderedFacts.some(row=>row.view.presentation.module==='assistant'&&['backgroundAgentsTotal','backgroundAgentSwitchesOn','backgroundAgentEffectiveSwitchesOn'].includes(String(row.view.presentation.cards[row.card].facts[row.fact].field)))&&<p className="text-xs text-muted-foreground">{copy('backgroundSwitchNote')}</p>}
   {renderedFacts.some(row=>row.view.presentation.module==='assistant'&&row.view.presentation.cards[row.card].href==='/control-tower/agents/features#ai-features')&&<a href="/control-tower/agents/features#ai-features" className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{copy('manageAgentSwitches')}</a>}
   {views.some(view=>view.state==='ready'&&view.presentation.truncated)&&<p className="text-xs text-muted-foreground">{text.t('truncated')}</p>}
   <details className="text-muted-foreground"><summary className="min-h-11 w-fit cursor-pointer py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{copy('sources')}</summary><div className="mt-2 space-y-4 rounded-lg border border-border p-3"><p className="text-xs">{copy('canonicalNote')}</p>{sources.map(source=><div key={source.id}>{source.card}</div>)}</div></details>
  </section>;
 }catch{return unavailable();}
}
/** No arbitrary model prose is rendered. Clarification/refusal precede legacy grounded/generic mode. */
export async function GroundedWorkspaceReply({reply,ctx,exchangeId}:{reply:GroundedWorkspaceAnswer;ctx:SessionContext;exchangeId?:string}){
 const[t,copy]=await Promise.all([getTranslations('assistant.workspace.answers'),getTranslations('assistant.workspace.conversation')]),conversation=reply.conversation??null;
 let catalogue:ReactNode=null;
 if(conversation===null&&reply.mode==='grounded'&&reply.views.length===1)catalogue=await AssistantCatalogueSummary({view:reply.views[0],ctx});
 const legacySources=conversation===null&&reply.mode==='grounded'?await Promise.all(reply.views.map(async view=>({id:view.viewId,card:await CanonicalModuleJob({view,ctx})}))):[];
 return <div className="mt-3 space-y-4">
  {conversation!==null?await ConversationReplyBody({conversation,ctx,exchangeId}):reply.mode==='grounded'?<>{catalogue??<p className="text-sm">{t('grounded')}</p>}
   <details className="text-muted-foreground"><summary className="min-h-11 w-fit cursor-pointer py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{copy('sources')}</summary><div className="mt-2 space-y-4 rounded-lg border border-border p-3">{legacySources.map(source=><div key={source.id}>{source.card}</div>)}</div></details>
   {reply.partial&&<p className="text-xs text-muted-foreground">{t('partial')}</p>}</>:
   <p className="text-sm text-muted-foreground">{t(reply.mode==='generic'?'generic':'unavailable')}</p>}
  {conversation?.plan.mode==='refuse'&&conversation.plan.code==='human_review_required'&&await ConversationReviewLinks({views:reply.views,ctx})}
  {conversation?.plan.mode==='answer'&&reply.partial&&<p className="text-xs text-muted-foreground">{t('partial')}</p>}
  {reply.fallbackModules.filter(module=>MODULE_JOBS.some(([code])=>code===module)).map(module=><a key={module} href={'/assistant?job='+encodeURIComponent(module)}
   className="mr-3 inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('openTask')}</a>)}
 </div>;
}

/** The GET chooser stays read-only. Only an explicit human POST can consume a governed job permit. */
export async function GovernedModuleJobComposer({modules}:{modules:readonly AgentModuleCode[]}){
 const t=await getTranslations('assistant.workspace.governed'),jobs=await getTranslations('assistant.workspace.jobs');
 return <Card className="p-5"><h2 className="text-base font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('intro')}</p>
  <form action={runGovernedPlanAction} className="mt-4 space-y-3"><input type="hidden" name="commandNonce" value={randomUUID()}/>
   <div className="grid gap-3 sm:grid-cols-2">{[0,1,2,3].map(index=><label key={index} className="text-sm">{t('task',{n:index+1})}
    <select name="module" required={index===0} defaultValue="" className="mt-1 min-h-11 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
     <option value="">{t(index===0?'choose':'optional')}</option>{MODULE_JOBS.filter(([module])=>modules.includes(module)).map(([module])=><option key={module} value={module}>{jobs(`module_${module}`)}</option>)}
    </select></label>)}</div>
   <button type="submit" className="min-h-11 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('run')}</button>
  </form></Card>;
}
export async function GovernedWorkspaceJob({view,ctx}:{view:GovernedWorkspaceJobView;ctx:SessionContext}){
 const t=await getTranslations('assistant.workspace.governed');
 if(view.state!=='ready')return <Card className="p-5"><p role="status" className="text-sm text-muted-foreground">{t('unavailable')}</p></Card>;
 return <section className="space-y-4" aria-label={t('result')}><p className="text-sm text-muted-foreground">{t(view.mode==='promoted'?'promoted':'baseline')}</p>
  {view.changedSinceRun&&<p role="status" className="text-xs text-muted-foreground">{t('changed')}</p>}
  {view.views.map(row=><CanonicalModuleJob key={row.viewId} view={row} ctx={ctx}/>)}
  {view.feedbackOutcome&&<p role="status" className="text-xs text-muted-foreground">{t('signalSaved',{rating:t(`signal_${view.feedbackOutcome}`)})}</p>}
  {!view.changedSinceRun?<form action={saveGovernedJobFeedbackAction} className="space-y-3 rounded-lg border p-4"><input type="hidden" name="jobId" value={view.jobId}/>
   <label className="flex items-start gap-2 text-xs"><input type="checkbox" name="consented" value="yes" required className="mt-0.5"/><span>{t('signalConsent')}</span></label>
   <div className="flex flex-wrap gap-2">{(['helpful','needs_correction','incorrect'] as const).map(outcome=><button key={outcome} type="submit" name="outcome" value={outcome}
    className="min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t(`signal_${outcome}`)}</button>)}</div>
  </form>:<p className="text-xs text-muted-foreground">{t('signalChanged')}</p>}
  <OwnClearForm kind="ratings" action={eraseGovernedJobFeedbackAction} label={t('eraseSignals')}/>
 </section>;
}
