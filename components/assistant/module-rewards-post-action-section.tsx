import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {moduleActionEntryAccess} from '@/core/assistant-actions/module-action-entries';
import {readRewardsPostModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {RewardsPostActionChoices} from '@/lib/assistant-actions/module-action-http';
import {ModuleRewardsPostActionPanel} from './module-rewards-post-action-panel';
export async function ModuleRewardsPostActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.rewardsActions'),jobs=await getTranslations('assistant.workspace.jobs'),notInToolkit=()=> <section className="space-y-3"><p role="status" className="text-sm">{jobs('actionNotInToolkit')}</p></section>,unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/rewards" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const selected=await getBrowserCommandSession(),ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))};const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();if(await moduleActionEntryAccess(ctx,'rewards')==='refused')return notInToolkit();const availability=RewardsPostActionChoices.parse(await readRewardsPostModuleActionChoices(ctx)),grants=(ctx.grants??[]).map(g=>[g.role,g.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Render-only freshness clears retained human text on a real refresh/revocation. It is not posted,
  // persisted, a cookie replacement or an author capability. No own-person/employment is invented.
  const key=createHash('sha256').update(JSON.stringify(['rewards-post-action-panel:v1',ctx.tenantId,ctx.userId,ctx.personId??null,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,availability,randomUUID()])).digest('hex');return <ModuleRewardsPostActionPanel key={key} choices={availability.kind==='choices'?availability:null} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
