import { z } from 'zod';
import type { CustomReportScheduleConfig } from '../db/schema';
export function validateMasterSchedule(raw:unknown):CustomReportScheduleConfig{
 const config=z.object({frequency:z.enum(['weekly','monthly']),day:z.number().int(),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59),timezone:z.string().min(1).max(64)}).strict().parse(raw);
 if(config.frequency==='weekly'?(config.day<0||config.day>6):(config.day<1||config.day>31))throw new Error('Choose a valid schedule day.');
 try{new Intl.DateTimeFormat('en',{timeZone:config.timezone}).format(new Date());}catch{throw new Error('Choose a valid time zone.');}return config;
}
const parts=(date:Date,formatter:Intl.DateTimeFormat)=>Object.fromEntries(formatter.formatToParts(date).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
/** Calendar matching in the selected zone; DST repeated local times select the first occurrence only.
 * The occurrence's scheduled instant is persisted once and uniquely identifies a delivery. */
export function nextMasterScheduleAt(config:CustomReportScheduleConfig,after:Date):Date{
 const checked=validateMasterSchedule(config),formatter=new Intl.DateTimeFormat('en-GB',{timeZone:checked.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),start=Math.floor(after.getTime()/60_000)*60_000+60_000;
 // At most 32 calendar days. Step through UTC minutes so skipped/repeated local times are not guessed.
 for(let time=start;time<=start+33*86_400_000;time+=60_000){const date=new Date(time),local=parts(date,formatter);if(local.hour!==checked.hour||local.minute!==checked.minute)continue;
 const daysInMonth=new Date(Date.UTC(local.year,local.month,0)).getUTCDate(),dayOfWeek=new Date(Date.UTC(local.year,local.month-1,local.day)).getUTCDay();
 if(checked.frequency==='weekly'?dayOfWeek===checked.day:local.day===Math.min(checked.day,daysInMonth)){
  // A clock-fold must not turn one weekly/monthly wall-time occurrence into two deliveries.
  let repeated=false;for(let previous=time-60_000;previous>=time-26*3_600_000;previous-=60_000){const earlier=parts(new Date(previous),formatter);if(earlier.year===local.year&&earlier.month===local.month&&earlier.day===local.day&&earlier.hour===local.hour&&earlier.minute===local.minute){repeated=true;break;}}
  if(!repeated)return date;
 }
 }throw new Error('The scheduled time does not occur within the next month. Choose another time.');
}
