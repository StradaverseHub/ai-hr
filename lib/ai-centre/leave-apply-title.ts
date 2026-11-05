/** Issue 10 — the specific title of a leave application card prepared in chat: "Annual Leave, Thu, Nov 5 (1 day)",
 * "Annual Leave, Mon, Nov 9 – Wed, Nov 11 (3 days)" or "Annual Leave, Thu, Nov 5 (half day, morning)", in the
 * person's locale (aiCentre.conversation.leaveApplyTitle, leaveApplyRangeTitle, leaveApplyMorningTitle and
 * leaveApplyAfternoonTitle in messages/ai-centre/<locale>.json).
 *
 * Every value is the signed proposal's own: the leave type name, the dates and the days the leave service counted,
 * and the duration selector. Nothing is computed here; a card without those facts keeps its generic title (null).
 * Calendar dates are formatted as dates, in UTC, so no time zone can move them by a day. Pure. */
export type LeaveApplyTitleKey='leaveApplyTitle'|'leaveApplyRangeTitle'|'leaveApplyMorningTitle'|'leaveApplyAfternoonTitle';
type Translate=(key:LeaveApplyTitleKey,values:Record<string,string|number>)=>string;
/** Formats one calendar date with LEAVE_APPLY_TITLE_DATE. */
type FormatDate=(date:Date)=>string;
type TitledProposal=Readonly<{what:Readonly<{action:string;selectors:Readonly<Record<string,string>>}>;
 facts?:Readonly<{leaveType?:string;startDate?:string;endDate?:string;days?:number}>}>;

export const LEAVE_APPLY_TITLE_DATE={weekday:'short',day:'numeric',month:'short',timeZone:'UTC'} as const;
/** Owner, 5 November 2026: the other date a card offers, written out in the message it fills ("Make it Friday, 13 November
 * 2026 instead."): the whole date in the Gregorian calendar (a Thai locale would otherwise write the Buddhist year), so the
 * person's next turn names an explicit date. A calendar date, formatted in UTC like the title. */
export const OTHER_DATE_PROMPT_DATE={weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC',calendar:'gregory'} as const;
const DATE=/^\d{4}-\d{2}-\d{2}$/;

export function leaveApplyCardTitle(body:TitledProposal,t:Translate,formatDate:FormatDate):string|null{
 if(body.what.action!=='leave.apply')return null;
 const {leaveType,startDate,days}=body.facts??{},endDate=body.facts?.endDate??startDate;
 if(!leaveType||!startDate||!endDate||!DATE.test(startDate)||!DATE.test(endDate)||typeof days!=='number'||!Number.isFinite(days))return null;
 const date=(value:string)=>formatDate(new Date(value+'T00:00:00.000Z'));
 if(endDate!==startDate)return t('leaveApplyRangeTitle',{leaveType,start:date(startDate),end:date(endDate),days});
 const duration=body.what.selectors.durationType;
 if(duration==='half_day_am')return t('leaveApplyMorningTitle',{leaveType,start:date(startDate)});
 if(duration==='half_day_pm')return t('leaveApplyAfternoonTitle',{leaveType,start:date(startDate)});
 return t('leaveApplyTitle',{leaveType,start:date(startDate),days});
}
