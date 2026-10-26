/** Server composition binds real selected-cookie authentication and current source choices. No
 * session, actor/grants, recipient, native fingerprint or executor prop crosses the client boundary. */
import 'server-only';
import {createHash} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {readNotificationModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {ModuleNotificationActionPanel} from './module-notification-action-panel';
const Choices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),employments:z.array(z.object({employmentId:z.string().uuid(),employeeCode:z.string().max(100).nullable(),companyName:z.string().min(1).max(240)}).strict()).max(16).refine(rows=>new Set(rows.map(row=>row.employmentId)).size===rows.length)}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
]);
export async function ModuleNotificationActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.moduleActions');
 const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/me/notifications" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></section>;
 try{
  const resume=z.string().uuid().optional().safeParse(value);if(!resume.success)return unavailable();
  const session=await getBrowserCommandSession();
  // Capture the selected principal before another await can expose a retained cache object to mutation.
  const ctx={...session,roles:session.roles?.slice(),grants:session.grants?.map(grant=>({...grant}))};
  const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();
  const choices=Choices.parse(ctx.personId?await readNotificationModuleActionChoices(ctx):{kind:'unavailable'});
  const permittedChoices=choices.kind==='choices'?{kind:choices.kind,employments:[...choices.employments].sort((a,b)=>a.employmentId.localeCompare(b.employmentId))}:{kind:choices.kind};
  const grants=(ctx.grants??[]).map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const key=createHash('sha256').update(JSON.stringify(['notification-action-panel:v1',ctx.tenantId,ctx.userId,ctx.personId,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,permittedChoices])).digest('hex');
  // Explicit unavailable choices are not an invented empty/default preference set. Metadata recovery
  // may still be attempted; every private reopen/effect is freshly checked by the fixed POST owner.
  return <ModuleNotificationActionPanel key={key} choices={choices} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
