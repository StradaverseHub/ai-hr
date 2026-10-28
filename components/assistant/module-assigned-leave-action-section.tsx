import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {readAssignedLeaveModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {AssignedLeaveActionChoices} from '@/lib/assistant-actions/module-action-http';
import {ModuleAssignedLeaveActionPanel} from './module-assigned-leave-action-panel';
export async function ModuleAssignedLeaveActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.approvalActions'),unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/approvals" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const selected=await getBrowserCommandSession(),ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))};const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();const choices=AssignedLeaveActionChoices.parse(await readAssignedLeaveModuleActionChoices(ctx)),grants=(ctx.grants??[]).map(g=>[g.role,g.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Render-only nonce clears private declarations on scope/policy refresh; it is never posted.
  const key=createHash('sha256').update(JSON.stringify(['assigned-leave-action-panel:v1',ctx.tenantId,ctx.userId,ctx.personId??null,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,choices,randomUUID()])).digest('hex');return <ModuleAssignedLeaveActionPanel key={key} choices={choices} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
