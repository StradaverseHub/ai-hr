/** Deterministic self greeting. Event evidence is reduced here; no DOB or leave record enters transport. */
import {and,eq,sql} from 'drizzle-orm';
import {settleReadGroup} from '../lib/settle-read-group';
import {withTenant,type SessionContext} from '../db/client';
import {person} from '../db/schema';
import {readEmployeeHomeGreetingCardFactsTx,readEmployeeHomeGreetingSnapshotIdentityTx} from './employee-home';
import {ownerCardSectionReads} from './home-owner-reads';
import {sharedReadWindow} from '../db/shared-read';
import {readOwnEmployeeHomeConfiguration,type OwnHomeConfigurationRead} from './employee-home-configuration';
import {getEmployeeHomeDisplayPreferences} from './dashboard-prefs';
import {approvedLeavePresenceByEmploymentTx,approvedLeavePresenceFromRows,leaveCalendarPresenceRowsJsonSql} from '../packs/leave/service';
import {workedDayKindForTx} from '../packs/attendance/service';
import {isModuleEnabled} from './entitlements';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {homeDisplayClock,homeGreetingTemplate,renderHomeTemplate,type HomeGreetingTemplateKey} from '../lib/employee-home';
import type {Locale} from '../i18n/config';

export type EmployeeHomeGreeting={version:1;employmentId:string;serverNow:string;displayDate:string;timeZone:string;
 message:string|null;templateKey:HomeGreetingTemplateKey|null;photoHref:string|null};

/** The return-from-leave lookback: approved presence over the last fortnight and today. */
const LOOKBACK_DAYS=14;
type Lookback=Readonly<{employmentId:string;rows:unknown}>;

/** Positive evidence only: today must be scheduled work and not approved leave. Look back through
 * intervening non-work days for the preceding scheduled day, bounded to a fortnight. If no such day is
 * established, use the ordinary greeting; absence of this optional event never asserts attendance.
 * `lookback`: the same presence rows, read for this employment in the greeting's own statement (decision 13); without a
 * full-day candidate no transaction is needed, and with one the workday checks read as before. */
async function returnFromLeave(ctx:SessionContext,employmentId:string,today:string,signal?:AbortSignal,lookback?:Lookback){
 if(!isModuleEnabled(ctx,'attendance'))return false;
 let read:Map<string,Map<string,'full_day'|'part_day'>>|null=null;
 if(lookback&&lookback.employmentId===employmentId&&!ownerCardSectionReads()){
  try{read=approvedLeavePresenceFromRows(lookback.rows);}catch{read=null;}
  const days=read?.get(employmentId);
  if(read&&(!days||days.has(today)||![...days.values()].includes('full_day')))return false;
 }
 return withTenant(ctx,async tx=>{
  const days=(read??await approvedLeavePresenceByEmploymentTx(tx,[employmentId],addDaysIso(today,-LOOKBACK_DAYS),today)).get(employmentId);
  // A return greeting requires approved full-day leave. Without any candidate, there
  // is no need to resolve shifts, holidays, or overtime rules for the preceding days.
  if(!days||days.has(today)||![...days.values()].includes('full_day'))return false;
  if(await workedDayKindForTx(tx,employmentId,today)!=='workday')return false;
  for(let distance=1;distance<=LOOKBACK_DAYS;distance++){
   signal?.throwIfAborted();
   const prior=addDaysIso(today,-distance);
   if(await workedDayKindForTx(tx,employmentId,prior)==='workday')return days.get(prior)==='full_day';
  }
  return false;
 },{readSignal:signal});
}

/** Display time follows the saved account preference (default platform timezone). Employment/leave
 * dates stay on their canonical business clock. Birthday is matched by month/day in the display zone;
 * Feb29 has no invented Feb28/Mar1 substitute. Anniversary uses this selected employment's hire date. */
export async function readEmployeeHomeGreeting(ctx:SessionContext,employmentId:string,locale:Locale,now=new Date(),configurationRead?:OwnHomeConfigurationRead):Promise<EmployeeHomeGreeting>{
 // Configuration already binds the exact own employment and reads its hire date.
 const today=todayInKualaLumpur(now);
 const [view,{identity,display,birthday,lookback}]=await settleReadGroup([
  ()=>configurationRead?.read(ctx,employmentId)??readOwnEmployeeHomeConfiguration(ctx,employmentId),
  ()=>withTenant(ctx,async tx=>{
   // Decision 13: the names, the photo, the birthday match and (when no shared Home window holds it) the
   // return-from-leave lookback in one statement, after the same proofs and the display preferences.
   let shown:ReturnType<typeof homeDisplayClock>|undefined;
   const from=addDaysIso(today,-LOOKBACK_DAYS);
   const bundled=await readEmployeeHomeGreetingCardFactsTx(tx,ctx,employmentId,async()=>{
    const preferences=await getEmployeeHomeDisplayPreferences(ctx,tx);
    const clock=homeDisplayClock(now,preferences.timeZone??'Asia/Kuala_Lumpur');shown=clock;
    // Only whether to read it: returnFromLeave still asks the module gate itself, and throws where it threw.
    let attendance=false;try{attendance=isModuleEnabled(ctx,'attendance');}catch{attendance=false;}
    return {birthday:sql`(select coalesce(to_char(${person.dateOfBirth},'MM-DD')=${clock.date.slice(5)},false) from ${person}
      where ${and(eq(person.id,ctx.personId!),eq(person.tenantId,ctx.tenantId),sql`app.principal_snapshot_current() AND app.is_self_person(${person.id})`)} limit 1)`,
     ...(attendance&&!sharedReadWindow(tx,employmentId,from,today)?{lookback:leaveCalendarPresenceRowsJsonSql([employmentId],from,today,false)}:{})};
   });
   if(bundled){
    const birthday=bundled.more.birthday;
    if(birthday===null||birthday===undefined)throw Error('Own greeting identity unavailable');
    if(typeof birthday!=='boolean'||!shown)throw Error('Own greeting facts unavailable');
    return {identity:bundled.identity,display:shown,birthday,
     lookback:'lookback' in bundled.more?{employmentId,rows:bundled.more.lookback} as Lookback:undefined};
   }
   const identity=await readEmployeeHomeGreetingSnapshotIdentityTx(tx,ctx,employmentId);
   const preferences=await getEmployeeHomeDisplayPreferences(ctx,tx);
   const display=homeDisplayClock(now,preferences.timeZone??'Asia/Kuala_Lumpur');
   const [row]=await tx.select({birthday:sql<boolean>`coalesce(to_char(${person.dateOfBirth},'MM-DD')=${display.date.slice(5)},false)`})
    .from(person).where(and(eq(person.id,ctx.personId!),eq(person.tenantId,ctx.tenantId),sql`app.principal_snapshot_current() AND app.is_self_person(${person.id})`)).limit(1);
   if(!row)throw Error('Own greeting identity unavailable');
   return {identity,display,birthday:row.birthday,lookback:undefined as Lookback|undefined};
  },{readOnlySnapshot:true,readSignal:configurationRead?.signal}),
 ]);
 configurationRead?.signal?.throwIfAborted();
 const returnedFromLeave=await returnFromLeave(ctx,view.employmentId,today,configurationRead?.signal,lookback);
 const firstDay=view.hiredOn===today,years=Number(today.slice(0,4))-Number(view.hiredOn.slice(0,4));
 const anniversary=years>0&&view.hiredOn.slice(5)===today.slice(5);
 const template=homeGreetingTemplate({hour:display.hour,birthday,firstDay,anniversary,returnedFromLeave},view.configuration.templates);
 // No recorded personal name is replaced with a guessed first token from the legal full name.
 const message=template&&identity.name?renderHomeTemplate(template,locale,template.key==='greetingAnniversary'?{name:identity.name,years}:{name:identity.name}):null;
 return {version:1,employmentId:view.employmentId,serverNow:now.toISOString(),displayDate:display.date,timeZone:display.timeZone,
  message,templateKey:message?template!.key as HomeGreetingTemplateKey:null,photoHref:identity.photoHref};
}
