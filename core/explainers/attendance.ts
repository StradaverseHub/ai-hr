/** ADR-0170 step 4 — "Why was I marked late?" for one of the caller's own attendance days.
 *
 * The answer is core/attendance-explain.ts explainAttendanceDay over the day's stored trace, read for the
 * caller's own current employment through the same owners the employee's own day page uses
 * (app/attendance/my-records/[date]): attendanceForEmploymentRange, flagOf and personalAttendanceStatus. The
 * owner returns message keys and numbers; they are worded here exactly as the screen's panel words them
 * (components/attendance-figure-cells.tsx): clock args as clock times, counts as counts, everything else as
 * minutes, with the same formatters (components/attendance-format.ts). Nothing is recomputed. */
import type {SessionContext} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {fmtClock,fmtShort} from '../../components/attendance-format';
import {withAssistantRead} from '../assistant-read-session';
import {attendanceForEmploymentRange,explainAttendanceDay,flagOf,personalAttendanceStatus,type ExplainStep} from '../../packs/attendance/service';
import {provenance,refuse,type ExplainerOutcome} from './outcome';
import en from '../../messages/en.json';import ms from '../../messages/ms.json';import zh from '../../messages/zh.json';import vi from '../../messages/vi.json';import ta from '../../messages/ta.json';import th from '../../messages/th.json';

type AttendanceMessages={explain:Record<string,unknown>}&Record<string,unknown>;
const MESSAGES:Readonly<Record<string,AttendanceMessages>>={en:en.attendance,ms:ms.attendance,zh:zh.attendance,vi:vi.attendance,ta:ta.attendance,th:th.attendance} as Record<string,AttendanceMessages>;
// The panel's own argument classes (components/attendance-figure-cells.tsx CLOCK_ARGS, COUNT_ARGS, BUCKET_KEY).
const CLOCK_ARGS=new Set(['at','threshold','end']),COUNT_ARGS=new Set(['blocks','count']);
const BUCKET_KEY:Readonly<Record<string,string>>={flat:'colOtFlat',ot00:'colOt00',ot10:'colOt10',ot15:'colOt15',ot20:'colOt20',ot30:'colOt30'};
const text=(messages:AttendanceMessages,path:readonly string[]):string|null=>{let node:unknown=messages;for(const key of path)node=node&&typeof node==='object'?(node as Record<string,unknown>)[key]:undefined;return typeof node==='string'?node:null;};
/** One step as the panel words it, in `locale` (English when the locale lacks the sentence). */
export function wordStep(step:ExplainStep,locale='en'):string{
 const messages=MESSAGES[locale]??MESSAGES.en,values:Record<string,string>={};
 for(const [key,value] of Object.entries(step.args??{})){
  if(key==='bucket')values[key]=text(messages,[BUCKET_KEY[String(value)]??'colOvertime'])??text(MESSAGES.en,[BUCKET_KEY[String(value)]??'colOvertime'])??String(value);
  else if(typeof value!=='number')values[key]=String(value);
  else values[key]=CLOCK_ARGS.has(key)?fmtClock(value):COUNT_ARGS.has(key)?String(value):fmtShort(value);
 }
 const template=text(messages,['explain',step.key])??text(MESSAGES.en,['explain',step.key])??step.key;
 return template.replace(/\{(\w+)\}/g,(whole,name:string)=>values[name]??whole);
}

export async function explainOwnAttendanceDay(ctx:SessionContext,input:Readonly<{date?:string}>,locale='en',today=todayInKualaLumpur()):Promise<ExplainerOutcome>{
 const date=input.date;
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)return refuse('invalid_input','`date` must be a real calendar date in YYYY-MM-DD form.');
 if(date>today)return refuse('out_of_range','That day has not happened yet, so it has no attendance record.');
 // The read facade's guard (Assistant grant, attendance module, AI controls) and the caller's own employment.
 const own=await withAssistantRead(ctx,'attendance',read=>read.myEmployment());
 if(!own)return refuse('no_employment','The asking user has no current employee record, so they have no attendance days.');
 const [row]=await attendanceForEmploymentRange(ctx,own.employmentId,date,date);
 if(!row)return refuse('no_data','No attendance day is recorded for the asking person on that date.');
 const explanation=explainAttendanceDay(row.calcTrace),messages=MESSAGES[locale]??MESSAGES.en;
 const section=(value:{minutes:number|null;steps:ExplainStep[]})=>({minutes:value.minutes,steps:value.steps.map(step=>wordStep(step,locale))});
 const label=(group:'source'|'dayType',key:string)=>text(messages,['explain',group,key])??text(MESSAGES.en,['explain',group,key])??key;
 return{ok:true,date,company:own.company,status:personalAttendanceStatus(row,today),flag:flagOf(row),
  recorded:{lateMinutes:row.lateMinutes,earlyOutMinutes:row.earlyOutMinutes,workedMinutes:row.workedMinutes,overtimeMinutes:row.otMinutes},
  explained:explanation.kind==='explained',
  ...(explanation.kind==='unavailable'?{unavailableReason:explanation.reason}:{
   schedule:{source:label('source',explanation.schedule.source),dayType:label('dayType',explanation.schedule.dayType),
    shiftStart:explanation.schedule.startAbs===null?null:fmtClock(explanation.schedule.startAbs),shiftEnd:explanation.schedule.endAbs===null?null:fmtClock(explanation.schedule.endAbs),
    scheduledMinutes:explanation.schedule.scheduledMinutes,breakMinutes:explanation.schedule.breakMinutes,ruleApplied:explanation.schedule.ruleId!==null,crossesMidnight:explanation.schedule.crossesMidnight},
   punch:{checkIn:fmtClock(explanation.punch.inAbs),checkOut:explanation.punch.outAbs===null?null:fmtClock(explanation.punch.outAbs),workedMinutes:explanation.punch.workedMinutes},
   lateness:section(explanation.lateness),earlyOut:section(explanation.earlyOut),overtime:section(explanation.overtime)}),
  provenance:provenance('core/attendance-explain.ts#explainAttendanceDay','Not published: the stored working names the attendance rule that applied, but rules carry no version yet.','/attendance/my-records',
   'Read from the day\'s stored working, never recomputed. Days calculated before the working was recorded cannot be explained until they are recalculated.')};
}
