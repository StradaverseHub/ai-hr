import {dateTimeFormatter} from '@/lib/date-time-formatter';
import {getTranslations} from 'next-intl/server';
import {CalendarCheck,ClipboardCheck,ClipboardList,Clock,UserCheck} from 'lucide-react';
import {ArrowDown,CheckCircle2,ListChecks} from 'lucide-react';
import type {LoopCard} from '@/core/loops/cards';
import {ProposalCard} from '@/components/ai-centre/proposal-card';
import {ClockOutLoopCard,type ClockOutCardCopy} from './clock-out-loop-card';
import {AutoFixLoopCard,type AutoFixCardCopy} from './auto-fix-loop-card';

/** Today (AI v2 W8): the cards the loops prepared, in "Needs you". Each is the one AI Centre card (ProposalCard) with
 * the loop's own facts, and its one action opens the owning service's own page, where the person confirms or changes
 * it: the card completes nothing. The missed clock-out card is the exception (./clock-out-loop-card.tsx): the person
 * picks their own reason on it and presses Confirm, which sends the slice 1 attendance correction for approval; Edit
 * still opens the correction form. A card the person must act on for themself is "prepared"; a list of what is missing
 * for HR is a "finding", as the other findings on Today are. Values come from components/today/reads.ts. */

/** An HR calendar date (yyyy-mm-dd) is a day, not an instant: format it as UTC so no offset moves it. */
const day=(locale:string,iso:string,style:'short'|'medium'='medium')=>dateTimeFormatter(locale,
 style==='short'?{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}:{dateStyle:'medium',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));
/** payroll.guide.check<Key>Title, the readiness report's own check names, already in every catalogue. */
const checkTitle=(key:string)=>`check${key.charAt(0).toUpperCase()}${key.slice(1)}Title`;

export async function LoopCards({cards,locale}:{cards:readonly LoopCard[];locale:string}){
 if(!cards.length)return null;
 const [t,tGap,tCheck,ti,tPre]=await Promise.all([getTranslations('today.loops'),getTranslations('controlTower.readinessScreen.gap'),getTranslations('payroll.guide'),
  getTranslations('aiCentre.conversation.inline'),getTranslations('aiCentre.payrollCycle.checks')]);
 // The missed clock-out card's reason chooser and Confirm: its own reasons, and the chat cards' own buttons and outcomes.
 const clockOut:ClockOutCardCopy={legend:t('clockOutReasonLegend'),
  reasons:{forgot:t('clockOutReasonForgot'),device:t('clockOutReasonDevice'),other:t('clockOutReasonOther')},otherLabel:t('clockOutReasonOtherLabel'),
  confirm:ti('confirm'),confirming:ti('confirming'),edit:ti('edit'),actionsLabel:t('clockOutActionsLabel'),confirmedBy:ti('confirmedBy'),
  done:ti('done.attendanceSubmitted'),error:ti('error'),
  refused:{not_confirmed:ti('refused.invalid'),invalid:ti('refused.invalid'),retired:ti('refused.retired'),changed:t('clockOutChanged'),
   unavailable:ti('refused.unavailable'),expired:ti('refused.expired'),access:ti('refused.access')}};
 const source=(loop:'loop_probation_ending'|'loop_payroll_inputs'|'loop_missing_employee_data'|'loop_missed_clock_outs'|'loop_document_expiry')=>t('source',{loop:t(`names.${loop}`)});
 // AI v2 Phase 2 P2-1: a clock-out the loop set for the person (with Undo), and a loop that moved itself down (for HR).
 const [ta,tr]=await Promise.all([getTranslations('today.autonomy'),getTranslations('aiCentre.autonomy.actions.reasons')]);
 const item=(entry:{personName:string|null;date:string|null;reason:string|null})=>[entry.personName??ta('someone'),...(entry.date?[day(locale,entry.date,'short')]:[]),
  ...(entry.reason?[tr(entry.reason)]:[])].join(' · ');
 const autoFix:AutoFixCardCopy={undo:ta('undo'),undoing:ta('undoing'),undone:ta('undone'),error:ta('refused.unavailable'),actionsLabel:ta('actionsLabel'),
  refused:{not_confirmed:ta('refused.unavailable'),invalid:ta('refused.unavailable'),unavailable:ta('refused.unavailable'),expired:ta('refused.expired'),
   changed:ta('refused.changed'),access:ta('refused.access'),ask_hr:ta('refused.ask_hr')}};
 const instant=(iso:string)=>dateTimeFormatter(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(iso));
 return <>{cards.map(card=>{
  if(card.kind==='clockOut')return <li key={card.caseId} data-today-loop="clockOut">
   <ClockOutLoopCard caseId={card.caseId} icon={<Clock/>} title={t('clockOutTitle',{time:card.proposedCheckOut,date:day(locale,card.date,'short')})} awaitingLabel={t('awaiting')}
    meta={[t('clockOutCheckIn',{time:card.checkIn}),t('clockOutMissing'),t('clockOutRoster',{time:card.proposedCheckOut}),source('loop_missed_clock_outs'),t('clockOutNote')]}
    editHref={card.href} copy={clockOut}/>
  </li>;
  if(card.kind==='record')return <li key={card.caseId} data-today-loop="record">
   <ProposalCard tone="prepared" icon={<ClipboardCheck/>} title={t('recordTitle',{count:card.gaps.length})} awaitingLabel={t('awaiting')}
    meta={[card.gaps.filter(gap=>tGap.has(gap as never)).map(gap=>tGap(gap as never)).join(', '),source('loop_missing_employee_data'),t('recordNote')].filter(Boolean)}
    href={card.href} cta={t('recordCta')}/>
  </li>;
  if(card.kind==='passport')return <li key={card.caseId} data-today-loop="passport">
   <ProposalCard tone="prepared" icon={<CalendarCheck/>} title={t('passportTitle',{date:day(locale,card.expiresOn)})} awaitingLabel={t('awaiting')}
    meta={[t('passportNote'),source('loop_document_expiry')]} href={card.href} cta={t('passportCta')}/>
  </li>;
  if(card.kind==='probation')return <li key={card.caseId} data-today-loop="probation">
   <ProposalCard tone="prepared" icon={<UserCheck/>} title={card.name?t('probationTitle',{date:day(locale,card.endDate),name:card.name}):t('probationTitleUnnamed',{date:day(locale,card.endDate)})}
    awaitingLabel={t('awaiting')} meta={[t(`probationStage.${card.stage}`),...(card.overdue?[t('probationOverdue')]:[]),source('loop_probation_ending'),t('probationNote')]}
    href={card.href} cta={t('probationCta')}/>
  </li>;
  if(card.kind==='payroll')return <li key={card.caseId} data-today-loop="payroll">
   <ProposalCard tone="finding" icon={<ClipboardList/>}
    title={card.companyName?t('payrollTitle',{company:card.companyName,date:day(locale,card.cutOff)}):t('payrollTitleUnnamed',{date:day(locale,card.cutOff)})}
    meta={[(card.checks??[]).filter(key=>tPre.has(key as never)).map(key=>tPre(key as never)).join(', '),
     card.missing.filter(key=>tCheck.has(checkTitle(key) as never)).map(key=>tCheck(checkTitle(key) as never)).join(', '),
     ...(card.blockers>0?[t('payrollBlockers',{count:card.blockers})]:[]),source('loop_payroll_inputs')].filter(Boolean)}
    href={card.href} cta={t('payrollCta')}/>
  </li>;
  if(card.kind==='autoFixed')return <li key={card.actionId} data-today-loop="autoFixed">
   <AutoFixLoopCard actionId={card.actionId} icon={<CheckCircle2/>} title={ta('autoFixedTitle',{time:card.checkOut,date:day(locale,card.date,'short')})}
    meta={[ta('autoFixedRoster'),ta('autoFixedSource',{loop:t('names.loop_missed_clock_outs')}),ta('autoFixedUntil',{date:instant(card.undoUntil)}),ta('autoFixedNote')]} copy={autoFix}/>
  </li>;
  if(card.kind==='movedDown')return <li key={card.changeId} data-today-loop="movedDown">
   <ProposalCard tone="finding" icon={<ArrowDown/>}
    title={card.companyName?ta('movedDownTitle',{loop:t(`names.${card.workerId}`),company:card.companyName}):ta('movedDownTitleUnnamed',{loop:t(`names.${card.workerId}`)})}
    meta={[ta('movedDownShare',{corrected:card.corrected,applied:card.applied}),
     ...card.corrections.map(item=>ta(item.kind==='undone'?'correctionUndone':'correctionChanged',{name:item.personName??ta('someone'),
      date:item.date?day(locale,item.date,'short'):'—',by:ta(item.by==='hr'?'byHr':'byEmployee')})),
     ...(card.more>0?[ta('correctionMore',{count:card.more})]:[]),ta('movedDownNote')]}
    href={card.href} cta={ta('movedDownCta')}/>
  </li>;
  if(card.kind==='acted')return <li key={`acted:${card.workerId}:${card.companyId}`} data-today-loop="acted">
   <ProposalCard tone="finding" icon={<CheckCircle2/>} title={ta('actedTitle',{loop:t(`names.${card.workerId}`),count:card.count,company:card.companyName??'—'})}
    meta={[...card.items.map(item),...(card.more>0?[ta('correctionMore',{count:card.more})]:[]),ta('actedNote')]} href={card.href} cta={ta('movedDownCta')}/>
  </li>;
  if(card.kind==='sample')return <li key={`sample:${card.workerId}:${card.companyId}`} data-today-loop="sample">
   <ProposalCard tone="decide" icon={<ListChecks/>} title={ta('sampleTitle',{loop:t(`names.${card.workerId}`),company:card.companyName??'—'})}
    meta={[ta('sampleMeta',{size:card.size,total:card.total}),ta('sampleNote')]} href={card.href} cta={ta('sampleCta')}/>
  </li>;
  if(card.kind==='leftAlone')return <li key={`left:${card.workerId}:${card.companyId}`} data-today-loop="leftAlone">
   <ProposalCard tone="finding" icon={<Clock/>} title={ta('leftAloneTitle',{loop:t(`names.${card.workerId}`),count:card.count,company:card.companyName??'—'})}
    meta={[...card.items.map(item),...(card.more>0?[ta('correctionMore',{count:card.more})]:[]),ta('leftAloneNote')]} href={card.href} cta={ta('movedDownCta')}/>
  </li>;
  return <li key="passports" data-today-loop="passports">
   <ProposalCard tone="finding" icon={<CalendarCheck/>} title={t('passportsTitle',{count:card.count})}
    meta={[t('passportsFirst',{date:day(locale,card.first)}),source('loop_document_expiry')]} href={card.href} cta={t('passportsCta')}/>
  </li>;
 })}</>;
}
