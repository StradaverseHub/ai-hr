import 'server-only';
import {createHash} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {TestingActionChoices} from '@/lib/assistant-actions/module-action-http';
import {readTestingModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {ModuleTestingActionPanel} from './module-testing-action-panel';
export async function ModuleTestingActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.testingActions');const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/system-testing" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const source=await getBrowserCommandSession(),ctx={...source,roles:source.roles?.slice(),grants:source.grants?.map(grant=>({...grant}))};
  const grants=(ctx.grants??[]).map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));const principal=createHash('sha256').update(JSON.stringify(['testing-human-observation:v1',ctx.tenantId,ctx.userId,ctx.personId,[...(ctx.roles??[])].sort(),grants])).digest('hex');
  const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();const choices=TestingActionChoices.parse(await readTestingModuleActionChoices(ctx));const keyChoices=choices.kind==='choices'?{...choices,items:[...choices.items].sort((a,b)=>a.assignmentId.localeCompare(b.assignmentId))}:choices;const key=createHash('sha256').update(JSON.stringify([principal,locale,resume.data??null,keyChoices])).digest('hex');return <ModuleTestingActionPanel key={key} choices={choices} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
