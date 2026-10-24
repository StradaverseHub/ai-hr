/** Deterministic self greeting. Event evidence is reduced here; no DOB or leave record enters transport. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {person} from '../db/schema';
import {requireOwnHomeSubject} from './employee-home';
import {readEmployeeHomeGreetingIdentity} from './employee-home';
import {readOwnEmployeeHomeConfiguration} from './employee-home-configuration';
import {listEmployeeHomeCards} from './dashboard-card-config';
import {getEmployeeHomePreferences} from './dashboard-prefs';
import {approvedLeavePresenceByEmploymentTx} from '../packs/leave/service';
import {workedDayKindForTx} from '../packs/attendance/service';
import {isModuleEnabled} from './entitlements';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {homeDisplayClock,homeGreetingTemplate,renderHomeTemplate,type HomeGreetingTemplateKey} from '../lib/employee-home';
import type {Locale} from '../i18n/config';

export type EmployeeHomeGreeting={version:1;employmentId:string;serverNow:string;displayDate:string;timeZone:string;
 message:string|null;templateKey:HomeGreetingTemplateKey|null;photoHref:string|null};

/** Positive evidence only: today must be scheduled work and not approved leave. Look back through
 * intervening non-work days for the preceding scheduled day, bounded to a fortnight. If no such day is
 * established, use the ordinary greeting; absence of this optional event never asserts attendance. */
async function returnFromLeave(ctx:SessionContext,employmentId:string,today:string){
 if(!isModuleEnabled(ctx,'attendance'))return false;
 return withTenant(ctx,async tx=>{
  if(await workedDayKindForTx(tx,employmentId,today)!=='workday')return false;
  const days=(await approvedLeavePresenceByEmploymentTx(tx,[employmentId],addDaysIso(today,-14),today)).get(employmentId);
  if(days?.has(today))return false;
  for(let distance=1;distance<=14;distance++){
   const prior=addDaysIso(today,-distance);
   if(await workedDayKindForTx(tx,employmentId,prior)==='workday')return days?.get(prior)==='full_day';
  }
  return false;
 });
}

/** Display time follows the saved account preference (default platform timezone). Employment/leave
 * dates stay on their canonical business clock. Birthday is matched by month/day in the display zone;
 * Feb29 has no invented Feb28/Mar1 substitute. Anniversary uses this selected employment's hire date. */
export async function readEmployeeHomeGreeting(ctx:SessionContext,employmentId:string,locale:Locale,now=new Date()):Promise<EmployeeHomeGreeting>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 const [identity,view,preferences]=await Promise.all([
  readEmployeeHomeGreetingIdentity(ctx,subject.employmentId),
  readOwnEmployeeHomeConfiguration(ctx,subject.employmentId),
  listEmployeeHomeCards(ctx).then(cards=>getEmployeeHomePreferences(ctx,cards)),
 ]);
 const display=homeDisplayClock(now,preferences.timeZone??'Asia/Kuala_Lumpur'),today=todayInKualaLumpur(now);
 const [birthday,returnedFromLeave]=await Promise.all([
  withTenant(ctx,async tx=>{
   const [row]=await tx.select({birthday:sql<boolean>`coalesce(to_char(${person.dateOfBirth},'MM-DD')=${display.date.slice(5)},false)`})
    .from(person).where(and(eq(person.id,ctx.personId!),eq(person.tenantId,ctx.tenantId),sql`app.principal_snapshot_current() AND app.is_self_person(${person.id})`)).limit(1);
   if(!row)throw Error('Own greeting identity unavailable');return row.birthday;
  }),
  returnFromLeave(ctx,subject.employmentId,today),
 ]);
 const firstDay=subject.hiredOn===today,years=Number(today.slice(0,4))-Number(subject.hiredOn.slice(0,4));
 const anniversary=years>0&&subject.hiredOn.slice(5)===today.slice(5);
 const template=homeGreetingTemplate({hour:display.hour,birthday,firstDay,anniversary,returnedFromLeave},view.configuration.templates);
 // No recorded personal name is replaced with a guessed first token from the legal full name.
 const message=template&&identity.name?renderHomeTemplate(template,locale,template.key==='greetingAnniversary'?{name:identity.name,years}:{name:identity.name}):null;
 return {version:1,employmentId:subject.employmentId,serverNow:now.toISOString(),displayDate:display.date,timeZone:display.timeZone,
  message,templateKey:message?template!.key as HomeGreetingTemplateKey:null,photoHref:identity.photoHref};
}
