import 'server-only';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {getBrowserCommandSession} from '@/lib/session';
import {isAdmin} from '@/lib/authz-model';

/** Navigation only: each native destination rechecks its own current actor, scope and policy.
 * Never accepts an employment ID, manufactures clock evidence, or claims a completed action.
 * An unlinked USER can still reach the native explanation without being given a person identity.
 */
export async function AttendanceNativeWorkflows(){
 const t=await getTranslations('assistant.workspace.attendanceNativeWorkflows');
 let admin=false;
 try{const session=await getBrowserCommandSession();admin=!!session.userId&&isAdmin(session);}catch{/* Hide administrative navigation when the session is unavailable. */}
 const links=[{href:'/attendance/clock',label:'clock' as const},...(admin?[
  {href:'/assistant/schedule-group',label:'reviewGroup' as const},
  {href:'/assistant/day-schedule',label:'reviewDay' as const},
  {href:'/attendance/individual',label:'corrections' as const},
  {href:'/admin/attendance/schedule-assignment',label:'schedule' as const},
  {href:'/roster',label:'roster' as const},
  {href:'/admin/personnel',label:'calendar' as const},
 ]:[])];
 return <section aria-labelledby="attendance-native-workflows" className="space-y-3 rounded-lg border border-border p-5">
  <h2 id="attendance-native-workflows" className="font-semibold">{t('title')}</h2>
  <p className="text-sm text-muted-foreground">{t('description')}</p>
  <ul className="space-y-1">{links.map(({href,label})=><li key={label}><Link href={href} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(label)}</Link></li>)}</ul>
  {admin&&<p className="text-sm text-muted-foreground">{t('calendarHelp')}</p>}
 </section>;
}
