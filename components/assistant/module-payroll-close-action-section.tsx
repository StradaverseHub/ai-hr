import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {readPayrollCloseModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {PayrollCloseActionChoices} from '@/lib/assistant-actions/module-action-http';
import {ModulePayrollCloseActionPanel} from './module-payroll-close-action-panel';
export async function ModulePayrollCloseActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.payrollCloseActions'),unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/payroll" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const selected=await getBrowserCommandSession(),ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))};const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();const availability=PayrollCloseActionChoices.parse(await readPayrollCloseModuleActionChoices(ctx)),grants=(ctx.grants??[]).map(g=>[g.role,g.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Render-only freshness clears retained human text on a real refresh/revocation. It is not posted,
  // persisted, a cookie replacement or an author capability. No own-person/employment is invented.
  const key=createHash('sha256').update(JSON.stringify(['payroll-close-action-panel:v1',ctx.tenantId,ctx.userId,ctx.personId??null,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,availability,randomUUID()])).digest('hex');return <ModulePayrollCloseActionPanel key={key} choices={availability.kind==='choices'?availability:null} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
