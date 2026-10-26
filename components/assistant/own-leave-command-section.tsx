/** Complete server composition, deliberately UNMOUNTED until migration/source/security acceptance.
 * No route/page imports this section. It accepts no session, employment, type or executor props. */
import 'server-only';
import {createHash} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {withTenant} from '@/db/client';
import {isLocale} from '@/i18n/config';
import {getBrowserCommandSession} from '@/lib/session';
import {readOwnLeaveChoicesTx} from '@/core/assistant-actions/own-leave-choices';
import {ownLeaveCommandCopy} from './own-leave-command-copy';
import {OwnLeaveCommandPanel} from './own-leave-command-panel';

export async function OwnLeaveCommandSection({resumeActionId:resumeValue}:{resumeActionId?:unknown}={}){
 const messages=await ownLeaveCommandCopy(),t=await getTranslations('ownLeaveReview');
 const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{messages.unavailable}</p>
  <Link href="/leave?apply=1" className="inline-flex min-h-11 items-center rounded-md border border-input px-3 py-2 text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('openForm')}</Link></section>;
 try{
  const resume=z.string().uuid().optional().safeParse(resumeValue);if(!resume.success)return unavailable();
  const session=await getBrowserCommandSession();
  const ctx={...session,roles:session.roles?.slice(),grants:session.grants?.map(grant=>({...grant}))};
  const locale=await getLocale();if(!isLocale(locale))return unavailable();
  const choices=await withTenant(ctx,tx=>readOwnLeaveChoicesTx(tx,ctx,locale));
  if(!ctx.userId||!ctx.personId)return unavailable();
  const employments=choices.kind==='choices'?choices.employments:[];
  // A server-derived opaque React identity prevents cross-login or changed-resume state reuse.
  // This key grants no authority and contains no private text, raw session IDs or posted actor data.
  const key=createHash('sha256').update(JSON.stringify(['own-leave-panel-v1',ctx.tenantId,ctx.userId,ctx.personId,resume.data??null])).digest('hex');
  return <section className="space-y-4">
   {employments.length===0&&<p role="alert" className="text-sm">{messages.unavailable}</p>}
   <OwnLeaveCommandPanel key={key} employments={employments} messages={messages} resumeActionId={resume.data}/>
  </section>;
 }catch{return unavailable();}
}
