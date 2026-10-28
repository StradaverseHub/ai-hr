import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {readCountryStatutoryModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {CountryStatutoryActionChoices} from '@/lib/assistant-actions/module-action-http';
import {ModuleCountryStatutoryActionPanel} from './module-country-statutory-action-panel';
export async function ModuleCountryStatutoryActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){const t=await getTranslations('assistant.workspace.countryStatutoryActions'),unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/admin/personnel" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link></section>;try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const selected=await getBrowserCommandSession(),ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))},locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();const available=CountryStatutoryActionChoices.parse(await readCountryStatutoryModuleActionChoices(ctx)),grants=(ctx.grants??[]).map(g=>[g.role,g.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),key=createHash('sha256').update(JSON.stringify(['country-statutory-panel:v1',ctx.tenantId,ctx.userId,ctx.personId??null,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,available,randomUUID()])).digest('hex');return <ModuleCountryStatutoryActionPanel key={key} choices={available.kind==='choices'?available:null} resumeActionId={resume.data}/>;}catch{return unavailable();}}
