import 'server-only';
import {createHash} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {readLeaveChangeChoices} from '@/core/assistant-actions/leave-change-review-store';
import {OwnLeaveChangeChoices} from '@/lib/assistant-actions/own-leave-change-contract';
import {OwnLeaveChangePanel} from './own-leave-change-panel';
/** ADR-0151 wave 1: the person's own pending plain leave requests, for cancellation or a date/reason edit.
 * GET composes choices only; every change is a separate explicit human POST. */
export async function OwnLeaveChangeSection({resumeActionId:value,resumeAction}:{resumeActionId?:unknown;resumeAction?:unknown}={}){
 const t=await getTranslations('ownLeaveChange');const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/leave" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value),mode=z.enum(['leave.cancel','leave.edit']).optional().safeParse(resumeAction);if(!resume.success||!mode.success)return unavailable();
  const source=await getBrowserCommandSession(),ctx={...source,roles:source.roles?.slice(),grants:source.grants?.map(grant=>({...grant}))},locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();
  const choices=OwnLeaveChangeChoices.parse(ctx.personId?await readLeaveChangeChoices(ctx):{kind:'unavailable'});
  const key=createHash('sha256').update(JSON.stringify(['own-leave-change:v1',ctx.tenantId,ctx.userId,ctx.personId,locale,resume.data??null,mode.data??null,choices])).digest('hex');
  return <OwnLeaveChangePanel key={key} choices={choices} resumeActionId={resume.data} resumeAction={mode.data}/>;
 }catch{return unavailable();}
}
