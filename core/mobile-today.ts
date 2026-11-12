/**
 * Native Today (owner decisions, 12 November 2026) — COMPOSITION ONLY over the web Employee Today's own readers
 * (core/employee-today-reads.ts) and rules (lib/today/employee.ts), and the loops' own commands. The contract is
 * lib/mobile-api/v2/today.ts.
 *
 *   reminders  readLoopCards employeeOnly (clockOut, record, passport) and the person's own open undo windows
 *              (core/loops/autonomy-cards.ts autoFixed), in the web's card order; a record gap is labelled with the web
 *              card's own words (controlTower.readinessScreen.gap) in the caller's language, or left out
 *   steps      nextStepsFrom(the Before payroll checklist, the passport cards), as the Next step panel; a missed
 *              clock-out whose one-tap Confirm card is already a reminder is not sent twice
 *   hours      weekHours over the attendance owner's own week (attendance in use)
 *   payday     paydayView over the payroll owner's next payment and the checklist's cut-off (payroll in use): a date,
 *              never an amount
 *   comingUp   comingUp over the cut-off, the next payment, the person's Home calendar and their managers away
 *
 * AUTHORIZE FIRST. readOwnContext proves the caller's own employment before any section reads; every section receives
 * only that proven id and each owner repeats its own checks under the caller's session and row-level security. A
 * foreign or stale employment is the owner's HomeAccessError, never data. No service-role read, no model call.
 *
 * SECTIONS FAIL ON THEIR OWN. Each section is read and checked against its contract in its own try/catch: a failure is
 * `unavailable` ("could not check"), never an empty "nothing to do". A module not in use for the person's company is
 * `off`. A signed-out caller is 401 for the whole response. All sections share one read-only snapshot, as the web
 * render's panels do (lib/request-read-scope.ts).
 *
 * NO LINK LEAVES THE SERVER. Each item carries a destination from the contract's closed list of app screens.
 */
import {withTenant,type SessionContext} from '../db/client';
import {AuthRequiredError} from '../lib/auth-errors';
import {todayInKualaLumpur} from '../lib/hr-date';
import {withRequestReadScope} from '../lib/request-read-scope';
import {groupOfKind} from '../lib/pre-salary/items';
import {calendarComingUp,comingUp,nextStepsFrom,paydayView,weekHours,type NextStep} from '../lib/today/employee';
import {clockOutReasonText,type ClockOutRefusal} from '../lib/today/clock-out-reasons';
import {mobileTranslator} from '../lib/mobile-api/server-text';
import {
 CLOCK_OUT_REFUSALS_V2,LOOP_UNDO_REFUSALS_V2,TODAY_COMING_UP_LIMIT,TODAY_REMINDER_LIMIT,TODAY_STEP_KINDS,TODAY_STEP_LIMIT,TodayV2,
 type ClockOutConfirmCommandV2,type ClockOutConfirmResultV2,type LoopUndoCommandV2,type LoopUndoResultV2,type TodayDestination,type TodayReminder,type TodayStep,
} from '../lib/mobile-api/v2/today';
import type {Locale} from '../i18n/config';
import {HomeAccessError} from './employee-home';
import {moduleState,readManagersAway,readOwnCalendar,readOwnContext,readOwnLoopCards,readOwnPayHints,readOwnReadiness,readOwnWeek,sharedOwnRead} from './employee-today-reads';
import {readAutonomyCardsTx,type AutonomyCard} from './loops/autonomy-cards';
import {confirmMissedClockOut} from './loops/clock-out-confirm';
import {undoLoopAction,type LoopUndoRefusal} from './loops/undo';

// The owners' refusal codes are the contract's, exactly (a new owner code is a contract change).
type Same<A,B>=[A] extends [B]?([B] extends [A]?true:never):never;
const clockOutRefusalsMatch:Same<ClockOutRefusal,(typeof CLOCK_OUT_REFUSALS_V2)[number]>=true;
const undoRefusalsMatch:Same<LoopUndoRefusal,(typeof LOOP_UNDO_REFUSALS_V2)[number]>=true;
void clockOutRefusalsMatch;void undoRefusalsMatch;

type Section='reminders'|'steps'|'hours'|'payday'|'comingUp';
const UNAVAILABLE=Object.freeze({status:'unavailable' as const});
const OFF=Object.freeze({status:'off' as const});
type Settled<T>={ok:true;value:T}|{ok:false};
const attempt=async<T,>(read:()=>Promise<T>):Promise<Settled<T>>=>{try{return {ok:true,value:await read()};}catch{return {ok:false};}};
/** One read per request, however many sections show it (the web memoises the same readers per render). */
const once=<T,>(read:()=>Promise<T>)=>{let value:Promise<T>|undefined;return ()=>(value??=read());};

/** The person's own open undo windows (the autonomy ladder's autoFixed cards): admin false reads only their own. */
const readOwnAutoFixed=async(s:SessionContext)=>(await sharedOwnRead(s,()=>withTenant(s,tx=>readAutonomyCardsTx(tx,s,{scopeIds:[],admin:false}))))
 .flatMap(card=>card.kind==='autoFixed'?[card as Extract<AutonomyCard,{kind:'autoFixed'}>]:[]);

const RECORD_GAP_KEY_MAX=80,RECORD_GAP_LABEL_MAX=200,RECORD_GAP_LIMIT=20;
/** Each gap with the web card's own label for it in the caller's language; a gap with no label is left out. */
export function recordGaps(keys:readonly string[],label:(key:string)=>string|null):{key:string;label:string}[]{
 const out:{key:string;label:string}[]=[];
 for(const key of new Set(keys)){
  if(!key||key.length>RECORD_GAP_KEY_MAX)continue;
  const text=label(key);
  if(text&&text.length<=RECORD_GAP_LABEL_MAX)out.push({key,label:text});
 }
 return out.slice(0,RECORD_GAP_LIMIT);
}

const CORRECTION_KINDS:ReadonlySet<string>=new Set(['missed_clock_in','missed_clock_out','absent_no_leave']);
const STEP_KINDS:ReadonlySet<string>=new Set(TODAY_STEP_KINDS);
/** The app screen a step opens: an attendance day the person asks to correct, or opens; their own profile (details HR
 * keeps, a passport to renew); their leave history. null: no native screen yet (claims, acknowledgements, time in lieu,
 * overtime). */
export function stepDestination(step:Pick<NextStep,'kind'|'date'>):TodayDestination|null{
 if(step.kind==='passport_renew')return {screen:'profileEdit'};
 const group=groupOfKind(step.kind);
 if(group==='attendance')return step.date?{screen:CORRECTION_KINDS.has(step.kind)?'attendanceCorrection':'attendanceDay',date:step.date}:null;
 if(group==='leave')return {screen:'leaveHistory'};
 if(group==='details')return {screen:'profileEdit'};
 return null;
}

/** GET /api/mobile/v2/today for the caller's own `employmentId`. Throws the owner's HomeAccessError for an employment
 * that is not the caller's own and current; the route maps it. */
export async function readOwnTodayV2(s:SessionContext,employmentId:string,locale:Locale,now:Date=new Date()):Promise<TodayV2>{
 const today=todayInKualaLumpur(now);
 return withRequestReadScope({},async()=>{
  const own=await readOwnContext(s,employmentId);
  if(own.identity.selectedEmploymentId!==employmentId)throw new HomeAccessError('employmentUnavailable');
  const id=employmentId,companyId=own.companyId;
  const readiness=once(()=>readOwnReadiness(s,id,locale,today));
  const loopCards=once(()=>readOwnLoopCards(s,today));
  const payHints=once(()=>readOwnPayHints(s,id));
  let signedOut:unknown=null;
  const section=async<K extends Section>(name:K,read:()=>Promise<unknown>):Promise<TodayV2[K]>=>{
   try{return TodayV2.shape[name].parse(await read()) as TodayV2[K];}
   catch(error){
    if(error instanceof AuthRequiredError)signedOut??=error;
    // The cause may carry private HR or SQL text (lib/mobile-api/handler.ts privateFailure): log the section, never the error.
    else console.error('[mobile-api]',{event:'today_section_unavailable',section:name});
    return UNAVAILABLE as TodayV2[K];
   }
  };

  const reminders=section('reminders',async()=>{
   const [cards,autoFixed,gapLabel]=await Promise.all([loopCards(),readOwnAutoFixed(s),mobileTranslator(locale,'controlTower.readinessScreen.gap')]);
   const items:TodayReminder[]=[];
   for(const card of cards){
    if(card.kind==='clockOut')items.push({kind:'clockOut',caseId:card.caseId,date:card.date,checkIn:card.checkIn,proposedCheckOut:card.proposedCheckOut});
    else if(card.kind==='record'){const gaps=recordGaps(card.gaps,gapLabel);if(gaps.length)items.push({kind:'record',caseId:card.caseId,gaps,destination:{screen:'profileEdit'}});}
    else if(card.kind==='passport')items.push({kind:'passport',caseId:card.caseId,expiresOn:card.expiresOn,destination:{screen:'profile'}});
   }
   for(const card of autoFixed)items.push({kind:'autoFixed',actionId:card.actionId,date:card.date,checkOut:card.checkOut,undoUntil:card.undoUntil});
   return {status:'ok',items:items.slice(0,TODAY_REMINDER_LIMIT)};
  });

  const steps=section('steps',async()=>{
   const [ready,cards,shown]=await Promise.all([attempt(readiness),attempt(loopCards),reminders]);
   if(!ready.ok&&!cards.ok)throw new Error('No step source could be read');
   const items=ready.ok?ready.value?.items??[]:[];
   const passports=cards.ok?cards.value.flatMap(card=>card.kind==='passport'?[card]:[]):[];
   // A missed clock-out whose Confirm card is already a reminder is that card, not a second step.
   const confirmCase=new Map(items.flatMap(item=>item.action.kind==='confirm'&&item.action.card==='clockOut'?[[item.key,item.action.caseId] as const]:[]));
   const onReminders=new Set(shown.status==='ok'?shown.items.flatMap(item=>item.kind==='clockOut'?[item.caseId]:[]):[]);
   const kept=nextStepsFrom(items,passports).filter(step=>{const caseId=confirmCase.get(step.key);return !(caseId&&onReminders.has(caseId));});
   const sent:TodayStep[]=kept.filter(step=>STEP_KINDS.has(step.kind)).slice(0,TODAY_STEP_LIMIT).map(step=>({
    key:step.key,kind:step.kind as TodayStep['kind'],due:step.due,date:step.date,endDate:step.endDate??null,label:step.label??null,decider:step.decider,destination:stepDestination(step)}));
   // As the Next step panel: a source that failed, or a checklist group it could not read, is never all clear.
   return {status:'ok',items:sent,more:kept.length-sent.length,partial:!ready.ok||!cards.ok||(ready.ok&&!!ready.value?.failed)};
  });

  const hours=section('hours',async()=>{
   const state=moduleState(s,'attendance',companyId);
   if(state!=='on')return state==='off'?OFF:UNAVAILABLE;
   const week=weekHours(today,await readOwnWeek(s,id,today));
   return {status:'ok',week:{bars:week.bars.map(bar=>({date:bar.date,state:bar.state,workedMinutes:bar.workedMinutes,scheduledMinutes:bar.scheduledMinutes})),
    workedMinutes:week.workedMinutes,shiftMinutes:week.shiftMinutes}};
  });

  const payday=section('payday',async()=>{
   const state=moduleState(s,'payroll',companyId);
   if(state!=='on')return state==='off'?OFF:UNAVAILABLE;
   // As the Payday panel: the next recorded payment, else the open period's cut-off; "none" only when both were read.
   const [hints,ready]=await Promise.all([attempt(payHints),attempt(readiness)]);
   const next=paydayView(today,hints.ok?hints.value.nextPayment?.date??null:null,ready.ok?ready.value?.period.cutOff??null:null);
   if(next)return {status:'ok',next:{kind:next.kind,date:next.date,daysAway:next.daysAway}};
   return hints.ok&&ready.ok?{status:'ok',next:null}:UNAVAILABLE;
  });

  const coming=section('comingUp',async()=>{
   // Every source is needed: the contract has no partial list, so a source that failed makes the section unavailable.
   const payroll=moduleState(s,'payroll',companyId);
   if(payroll==='failed')throw new Error('Payroll entitlement unavailable');
   const [ready,calendar,away,hints]=await Promise.all([readiness(),readOwnCalendar(s,id,today.slice(0,7)),readManagersAway(s,id,today),
    payroll==='on'?payHints():Promise.resolve(null)]);
   const items=comingUp(today,{cutOff:ready?.period.cutOff??null,payday:hints?.nextPayment?.date??null,...calendarComingUp(calendar.days),managerAway:away},TODAY_COMING_UP_LIMIT);
   return {status:'ok',items:items.map(item=>({date:item.date,endDate:item.endDate,kind:item.kind,name:item.name}))};
  });

  const [r,st,h,p,c]=await Promise.all([reminders,steps,hours,payday,coming]);
  if(signedOut)throw signedOut;
  return {date:today,reminders:r,steps:st,hours:h,payday:p,comingUp:c};
 });
}

/** POST /api/mobile/v2/today/clock-out: the person's own Confirm on a missed clock-out reminder. The reason option
 * becomes its label in the caller's language (the card's own today.loops words), or the words they typed for Other;
 * the clock-out owner re-reads the case and sends the attendance correction for the usual approval. */
export async function confirmOwnClockOutV2(s:SessionContext,command:ClockOutConfirmCommandV2,locale:Locale):Promise<ClockOutConfirmResultV2>{
 const t=await mobileTranslator(locale,'today.loops','aiCentre');
 const reason=clockOutReasonText(command.reason,command.reason==='other'?command.other:undefined,
  {forgot:t('clockOutReasonForgot')??'',device:t('clockOutReasonDevice')??''});
 if(!reason)return {outcome:'refused',code:'invalid'};
 const result=await confirmMissedClockOut(s,{caseId:command.caseId,reason,confirm:command.confirm});
 return result.kind==='submitted'?{outcome:'submitted'}:{outcome:'refused',code:result.reason};
}

/** POST /api/mobile/v2/today/undo: Undo on the person's own autoFixed reminder, through the loop's undo owner. */
export async function undoOwnLoopActionV2(s:SessionContext,command:LoopUndoCommandV2):Promise<LoopUndoResultV2>{
 const result=await undoLoopAction(s,{actionId:command.actionId,confirm:command.confirm});
 return result.kind==='undone'?{outcome:'undone'}:{outcome:'refused',code:result.reason};
}
