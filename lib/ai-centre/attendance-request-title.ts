/** AI v2 W2 — the specific title of an attendance card prepared in chat: "Clock-out correction, Mon 3 Nov, 6:10 pm",
 * "Clock-in correction, …", "Clock correction, Mon 3 Nov, 9:00 am – 6:10 pm" or "Overtime request, Tue 4 Nov,
 * 6:00 pm – 9:00 pm", in the person's locale (aiCentre.conversation.attendanceClockOutTitle, attendanceClockInTitle,
 * attendanceClockBothTitle and overtimeRequestTitle in messages/ai-centre/<locale>.json).
 *
 * Every value is the signed proposal's own: the attendance day, which clock the person asked to correct (a selector),
 * the clock times the attendance service prepared and the overtime window it reviewed. Nothing is computed here; a card
 * without those facts keeps its generic title (null). The day is formatted as a calendar date and the times as wall
 * times, both in UTC, so no time zone can move them (they are already Kuala Lumpur values). Pure. */
export type AttendanceRequestTitleKey='attendanceClockOutTitle'|'attendanceClockInTitle'|'attendanceClockBothTitle'|'overtimeRequestTitle';
type Translate=(key:AttendanceRequestTitleKey,values:Record<string,string>)=>string;
type Format=(date:Date)=>string;
type TitledProposal=Readonly<{what:Readonly<{action:string;selectors:Readonly<Record<string,string>>}>;
 facts?:Readonly<{startDate?:string;checkIn?:string;checkOut?:string;plannedStart?:string;plannedEnd?:string}>}>;

/** Format options: the day with ATTENDANCE_TITLE_DATE, a wall time with ATTENDANCE_TITLE_TIME. */
export const ATTENDANCE_TITLE_DATE={weekday:'short',day:'numeric',month:'short',timeZone:'UTC'} as const;
export const ATTENDANCE_TITLE_TIME={hour:'numeric',minute:'2-digit',timeZone:'UTC'} as const;
const DATE=/^\d{4}-\d{2}-\d{2}$/,TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function attendanceRequestCardTitle(body:TitledProposal,t:Translate,formatDate:Format,formatTime:Format):string|null{
 const action=body.what.action,facts=body.facts??{},day=facts.startDate;
 if((action!=='attendance.correction.request'&&action!=='attendance.overtime.request')||!day||!DATE.test(day))return null;
 const date=formatDate(new Date(day+'T00:00:00.000Z'));
 const time=(value:string|undefined)=>value&&TIME.test(value)?formatTime(new Date('1970-01-01T'+value+':00.000Z')):null;
 if(action==='attendance.overtime.request'){
  const start=time(facts.plannedStart),end=time(facts.plannedEnd);
  return start&&end?t('overtimeRequestTitle',{date,start,end}):null;
 }
 const checkIn=time(facts.checkIn),checkOut=time(facts.checkOut),corrects=body.what.selectors.corrects;
 if(corrects==='check_out')return checkOut?t('attendanceClockOutTitle',{date,time:checkOut}):null;
 if(corrects==='check_in')return checkIn?t('attendanceClockInTitle',{date,time:checkIn}):null;
 if(corrects==='both')return checkIn&&checkOut?t('attendanceClockBothTitle',{date,start:checkIn,end:checkOut}):null;
 return null;
}
