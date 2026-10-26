import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {readLifecycleAckModuleActionAvailability} from '@/core/assistant-actions/module-action-server';
import {LifecycleAckActionAvailability} from '@/lib/assistant-actions/module-action-http';
import {ModuleLifecycleAckActionPanel} from './module-lifecycle-ack-action-panel';
export async function ModuleLifecycleAckActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.lifecycleActions'),unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/lifecycle/acknowledgement" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const selected=await getBrowserCommandSession(),ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))};const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();const availability=LifecycleAckActionAvailability.parse(await readLifecycleAckModuleActionAvailability(ctx)),grants=(ctx.grants??[]).map(g=>[g.role,g.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // A prehire CASE may have null person/employment links. The native owner still resolves the
  // real login's Person email; this component invents neither a link nor an identity.
  // A render-only nonce clears private serial/contact text on refresh, cancellation, relink or revoke.
  const key=createHash('sha256').update(JSON.stringify(['lifecycle-ack-action-panel:v1',ctx.tenantId,ctx.userId,ctx.personId??null,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,availability,randomUUID()])).digest('hex');return <ModuleLifecycleAckActionPanel key={key} currentCase={availability.kind==='available'?availability.currentCase:null} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
