import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {moduleActionEntryRoleFloor} from '@/lib/assistant-actions/module-action-entries';
import {readMultiCycleRunModuleActionChoices} from '@/core/assistant-actions/multi-cycle-run-choices';
import {MultiCycleRunActionChoices} from '@/lib/assistant-actions/multi-cycle-run-browser-contract';
import {ModuleMultiCycleRunActionPanel} from './module-multi-cycle-run-action-panel';
export async function ModuleMultiCycleRunActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.multiCycleRunActions'),jobs=await getTranslations('assistant.workspace.jobs'),notInToolkit=()=> <section className="space-y-3"><p role="status" className="text-sm">{jobs('actionNotInToolkit')}</p></section>,unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/payroll/process" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const selected=await getBrowserCommandSession(),ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))};const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();if(moduleActionEntryRoleFloor(ctx,'multi_cycle_run')===false)return notInToolkit();const availability=MultiCycleRunActionChoices.parse(await readMultiCycleRunModuleActionChoices(ctx)),grants=(ctx.grants??[]).map(g=>[g.role,g.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Render-only freshness clears retained human text on a real refresh/revocation. It is not posted,
  // persisted, a cookie replacement or an author capability. No own-person/employment is invented.
  const key=createHash('sha256').update(JSON.stringify(['multi-cycle-run-action-panel:v1',ctx.tenantId,ctx.userId,ctx.personId??null,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,availability,randomUUID()])).digest('hex');return <ModuleMultiCycleRunActionPanel key={key} choices={availability.kind==='choices'?availability:null} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
