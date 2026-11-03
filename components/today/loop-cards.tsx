import {getTranslations} from 'next-intl/server';
import {CalendarCheck,ClipboardCheck,ClipboardList,Clock,UserCheck} from 'lucide-react';
import type {LoopCard} from '@/core/loops/cards';
import {ProposalCard} from '@/components/ai-centre/proposal-card';
import {ClockOutLoopCard,type ClockOutCardCopy} from './clock-out-loop-card';

/** Today (AI v2 W8): the cards the loops prepared, in "Needs you". Each is the one AI Centre card (ProposalCard) with
 * the loop's own facts, and its one action opens the owning service's own page, where the person confirms or changes
 * it: the card completes nothing. The missed clock-out card is the exception (./clock-out-loop-card.tsx): the person
 * picks their own reason on it and presses Confirm, which sends the slice 1 attendance correction for approval; Edit
 * still opens the correction form. A card the person must act on for themself is "prepared"; a list of what is missing
 * for HR is a "finding", as the other findings on Today are. Values come from components/today/reads.ts. */

/** An HR calendar date (yyyy-mm-dd) is a day, not an instant: format it as UTC so no offset moves it. */
const day=(locale:string,iso:string,style:'short'|'medium'='medium')=>new Intl.DateTimeFormat(locale,
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
  return <li key="passports" data-today-loop="passports">
   <ProposalCard tone="finding" icon={<CalendarCheck/>} title={t('passportsTitle',{count:card.count})}
    meta={[t('passportsFirst',{date:day(locale,card.first)}),source('loop_document_expiry')]} href={card.href} cta={t('passportsCta')}/>
  </li>;
 })}</>;
}
