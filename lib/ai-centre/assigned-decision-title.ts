/** AI v2 W2 (slice 3) — the specific title of an assigned approver's decision card prepared in chat: "Approve: Travel
 * claim, RM 42.60, 31 Oct", "Reject: Overtime request, Tue 4 Nov, 6:00 pm – 9:00 pm", "Approve: Clock-out correction,
 * Mon 3 Nov, 6:10 pm", in the person's locale. The decision wraps the request's own title, worded as the employee's own
 * card words it (aiCentre.conversation.decisionApproveTitle and decisionRejectTitle around claimSubmitTitle,
 * overtimeRequestTitle and the attendanceClock*Title keys in messages/ai-centre/<locale>.json).
 *
 * Every value is the signed proposal's own: the approver's decision, the claim type, the date and the amount exactly as
 * the claims service stored it, or the attendance day and times as the attendance service stored them. Nothing is
 * computed here; a card without those facts keeps its generic title (null). Dates are formatted as calendar dates and
 * times as wall times, in UTC, so no time zone can move them (they are already Kuala Lumpur values). Pure. */
export type AssignedDecisionTitleKey='decisionApproveTitle'|'decisionRejectTitle'|'claimSubmitTitle'|'overtimeRequestTitle'
 |'attendanceClockInTitle'|'attendanceClockOutTitle'|'attendanceClockBothTitle';
type Translate=(key:AssignedDecisionTitleKey,values:Record<string,string>)=>string;
type Format=(date:Date)=>string;
/** The claim date as the employee's claim card formats it (OWN_CHANGE_TITLE_DATE), the attendance day and times as the
 * attendance cards do (ATTENDANCE_TITLE_DATE, ATTENDANCE_TITLE_TIME). */
export type Formats=Readonly<{claimDate:Format;day:Format;time:Format}>;
type TitledProposal=Readonly<{what:Readonly<{action:string;selectors?:Readonly<Record<string,string>>}>;
 facts?:Readonly<{decision?:string;claimType?:string;incurredOn?:string;amount?:string;startDate?:string;plannedStart?:string;plannedEnd?:string;checkIn?:string;checkOut?:string}>}>;

const DATE=/^\d{4}-\d{2}-\d{2}$/,AMOUNT=/^\d{1,9}\.\d{2}$/,TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** "Travel Claim" already says claim: the title adds the word itself, so a trailing "claim" in the name is dropped. */
const typeName=(name:string)=>name.replace(/\s+claims?$/i,'').trim()||name;

/** The request's own title, as the employee's card words it, or null when its facts are incomplete. */
function itemTitle(body:TitledProposal,t:Translate,format:Formats):string|null{
 const facts=body.facts??{},at=(iso:string)=>new Date(iso+'T00:00:00.000Z'),formatTime=format.time;
 if(body.what.action==='approvals.claim.decide'){
  const {claimType,incurredOn,amount}=facts;
  if(!claimType||!incurredOn||!amount||!DATE.test(incurredOn)||!AMOUNT.test(amount))return null;
  return t('claimSubmitTitle',{claimType:typeName(claimType),amount,date:format.claimDate(at(incurredOn))});
 }
 if(body.what.action!=='approvals.attendance.decide'||!facts.startDate||!DATE.test(facts.startDate))return null;
 const time=(value:string|undefined)=>value&&TIME.test(value)?formatTime(new Date('1970-01-01T'+value+':00.000Z')):null,date=format.day(at(facts.startDate));
 if(body.what.selectors?.kind==='overtime'){
  const start=time(facts.plannedStart),end=time(facts.plannedEnd);
  return start&&end?t('overtimeRequestTitle',{date,start,end}):null;
 }
 const start=time(facts.checkIn),end=time(facts.checkOut);
 if(start&&end)return t('attendanceClockBothTitle',{date,start,end});
 if(start)return t('attendanceClockInTitle',{date,time:start});
 return end?t('attendanceClockOutTitle',{date,time:end}):null;
}

export function assignedDecisionCardTitle(body:TitledProposal,t:Translate,format:Formats):string|null{
 const decision=body.facts?.decision;
 if(decision!=='approved'&&decision!=='rejected')return null;
 const item=itemTitle(body,t,format);
 return item?t(decision==='approved'?'decisionApproveTitle':'decisionRejectTitle',{item}):null;
}
