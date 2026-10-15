import { z } from 'zod';
import { todayInKualaLumpur,timeInKualaLumpur } from '../../../lib/hr-date';
import { windowCells,type Policy,type WindowCell } from './model';

export const assessmentReminderRulesSchema=z.object({
 enabled:z.boolean().default(false),onOpen:z.boolean().default(true),
 daysBefore:z.array(z.number().int().min(0)).max(100).default([7,3,1]).transform(days=>[...new Set(days)].sort((a,b)=>b-a)),
 everyDays:z.number().int().min(0).max(30).default(0),sendTime:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
}).strict();
export type AssessmentReminderRules=z.infer<typeof assessmentReminderRulesSchema>;
export const defaultAssessmentReminderRules=assessmentReminderRulesSchema.parse({});
const cellModule:Record<WindowCell,keyof Policy['modules']>={pm_setting:'pm',pm_setting_approve:'pm',pm_results:'pm',pm_approve:'pm',tc_self:'tm',tc_approve:'tm',f360:'tm',idp_self:'idp',idp_review:'idp',pm_hod:'pm',pot_hod:'calibration',pm_buceo:'pm',pot_buceo:'calibration',tb_bgceo:'calibration'};
export type AssessmentReminderReason={cell:WindowCell|null;kind:'opening'|'closing'|'repeat';days:number};
const dayDifference=(later:string,earlier:string)=>Math.round((Date.parse(`${later}T00:00:00Z`)-Date.parse(`${earlier}T00:00:00Z`))/86_400_000);
const dateOf=(instant:string|null|undefined)=>instant?todayInKualaLumpur(new Date(instant)):null;

/** Source scheduling: reasons combine into one run; only enabled module windows participate. */
export function assessmentReminderReasons(policy:Pick<Policy,'windows'|'modules'>,cycleEnd:string,day:string,rules:AssessmentReminderRules):AssessmentReminderReason[]{
 z.iso.date().parse(day);z.iso.date().parse(cycleEnd);if(!rules.enabled)return [];
 const reasons:AssessmentReminderReason[]=[];let anyDates=false;
 for(const cell of windowCells){
  if(policy.modules[cellModule[cell]]===false)continue;
  const window=policy.windows[cell],opens=dateOf(window?.opensAt),closes=dateOf(window?.closesAt);
  anyDates||=!!(opens||closes);const isOpen=(!opens||opens<=day)&&(!closes||closes>=day);
  if(rules.onOpen&&opens===day)reasons.push({cell,kind:'opening',days:0});
  const left=closes?dayDifference(closes,day):null;
  if(isOpen&&left!=null&&rules.daysBefore.includes(left))reasons.push({cell,kind:'closing',days:left});
  const elapsed=opens?dayDifference(day,opens):null;
  if(isOpen&&rules.everyDays&&elapsed!=null&&elapsed>0&&elapsed%rules.everyDays===0)reasons.push({cell,kind:'repeat',days:rules.everyDays});
 }
 const left=dayDifference(cycleEnd,day);
 if(!anyDates&&rules.daysBefore.includes(left))reasons.push({cell:null,kind:'closing',days:left});
 const seen=new Set<string>();return reasons.filter(reason=>{
  const subject=reason.cell==='pm_hod'||reason.cell==='pot_hod'?'department_review':reason.cell;
  const key=`${subject}:${reason.kind}:${reason.days}`;if(seen.has(key))return false;seen.add(key);return true;
 });
}
/** The minute sweep claims each Malaysia send-day once; configured time is a wall-clock time in that same zone. */
export function assessmentReminderDue(policy:Pick<Policy,'windows'|'modules'>,cycleEnd:string,rules:AssessmentReminderRules,now=new Date()){
 const day=todayInKualaLumpur(now),reasons=assessmentReminderReasons(policy,cycleEnd,day,rules);
 return {day,reasons,due:reasons.length>0&&timeInKualaLumpur(now)>=rules.sendTime};
}
export function nextAssessmentReminder(policy:Pick<Policy,'windows'|'modules'>,cycleEnd:string,rules:AssessmentReminderRules,now=new Date(),horizon=90){
 const start=todayInKualaLumpur(now);
 for(let offset=0;offset<horizon;offset++){
  const day=new Date(Date.parse(`${start}T00:00:00Z`)+offset*86_400_000).toISOString().slice(0,10),reasons=assessmentReminderReasons(policy,cycleEnd,day,rules);
  if(reasons.length)return {day,reasons};
 }
 return null;
}

export { assessmentReminderTaskKeys,assessmentReminderTaskSchema,assessmentReminderMailSchema,type AssessmentReminderTask } from '../../../lib/assessment-reminder-mail';
