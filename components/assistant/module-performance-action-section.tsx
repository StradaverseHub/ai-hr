import 'server-only';
import {createHash} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {PerformanceActionChoices} from '@/lib/assistant-actions/module-action-http';
import {readPerformanceModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {ModulePerformanceActionPanel} from './module-performance-action-panel';
export async function ModulePerformanceActionSection({resumeActionId:value,resumeEngine:engineValue}:{resumeActionId?:unknown;resumeEngine?:unknown}={}){
 const t=await getTranslations('assistant.workspace.performanceActions');const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/me" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value),engine=z.enum(['standard','onehr']).optional().safeParse(engineValue);if(!resume.success||!engine.success||resume.data&&!engine.data)return unavailable();const source=await getBrowserCommandSession(),ctx={...source,roles:source.roles?.slice(),grants:source.grants?.map(grant=>({...grant}))};
  const grants=(ctx.grants??[]).map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));const principal=createHash('sha256').update(JSON.stringify(['performance-human-ack:v1',ctx.tenantId,ctx.userId,ctx.personId,[...(ctx.roles??[])].sort(),grants])).digest('hex');
  const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();const choices=PerformanceActionChoices.parse(ctx.personId?await readPerformanceModuleActionChoices(ctx):{kind:'unavailable'});const keyChoices=choices.kind==='choices'?{...choices,items:[...choices.items].sort((a,b)=>(a.action+':'+a.sourceId).localeCompare(b.action+':'+b.sourceId))}:choices;const key=createHash('sha256').update(JSON.stringify([principal,locale,resume.data??null,engine.data??null,keyChoices])).digest('hex');return <ModulePerformanceActionPanel key={key} choices={choices} resumeActionId={resume.data} resumeEngine={engine.data}/>;
 }catch{return unavailable();}
}
