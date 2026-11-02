/** Issue 10 — the specific title of a leave application card prepared in chat: "Annual Leave, Thu, Nov 6 (1 day)",
 * "Annual Leave, Mon, Nov 10 – Wed, Nov 12 (3 days)" or "Annual Leave, Thu, Nov 6 (half day, morning)", in the
 * person's locale (aiCentre.conversation.leaveApplyTitle / leaveApplyRangeTitle in messages/ai-centre/<locale>.json).
 *
 * Every value is the signed proposal's own: the leave type name, the dates and the days the leave service counted,
 * and the duration selector. Nothing is computed here; a card without those facts keeps its generic title (null).
 * Calendar dates are formatted as dates, in UTC, so no time zone can move them by a day. Pure. */
type Translate=(key:'leaveApplyTitle'|'leaveApplyRangeTitle',values:Record<string,string|number>)=>string;
type FormatDate=(date:Date,options:Intl.DateTimeFormatOptions)=>string;
type TitledProposal=Readonly<{what:Readonly<{action:string;selectors:Readonly<Record<string,string>>}>;
 facts?:Readonly<{leaveType?:string;startDate?:string;endDate?:string;days?:number}>}>;

export const LEAVE_APPLY_TITLE_DATE:Intl.DateTimeFormatOptions=Object.freeze({weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
const DATE=/^\d{4}-\d{2}-\d{2}$/;

export function leaveApplyCardTitle(body:TitledProposal,t:Translate,formatDate:FormatDate):string|null{
 if(body.what.action!=='leave.apply')return null;
 const {leaveType,startDate,days}=body.facts??{},endDate=body.facts?.endDate??startDate;
 if(!leaveType||!startDate||!endDate||!DATE.test(startDate)||!DATE.test(endDate)||typeof days!=='number'||!Number.isFinite(days))return null;
 const date=(value:string)=>formatDate(new Date(value+'T00:00:00.000Z'),LEAVE_APPLY_TITLE_DATE);
 if(endDate!==startDate)return t('leaveApplyRangeTitle',{leaveType,start:date(startDate),end:date(endDate),days});
 return t('leaveApplyTitle',{leaveType,start:date(startDate),duration:body.what.selectors.durationType??'full_day',days});
}
