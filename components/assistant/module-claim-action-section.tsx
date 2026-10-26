import 'server-only';
import {createHash} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {ClaimActionChoices} from '@/lib/assistant-actions/module-action-http';
import {readClaimModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {ModuleClaimActionPanel,ModuleClaimSubmissionPanel} from './module-claim-action-panel';
export async function ModuleClaimActionSection({resumeActionId:value,flow:flowValue}:{resumeActionId?:unknown;flow?:unknown}={}){
 const t=await getTranslations('assistant.workspace.claimActions');const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/claims" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value),flow=z.enum(['draft','submit']).default('draft').safeParse(flowValue);if(!resume.success||!flow.success)return unavailable();const source=await getBrowserCommandSession(),ctx={...source,roles:source.roles?.slice(),grants:source.grants?.map(grant=>({...grant}))};
  const grants=(ctx.grants??[]).map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));const principal=createHash('sha256').update(JSON.stringify(['claims-human-draft:v1',ctx.tenantId,ctx.userId,ctx.personId,[...(ctx.roles??[])].sort(),grants])).digest('hex');
  const locale=await getLocale();if(!ctx.userId||!ctx.personId||!isLocale(locale))return unavailable();const choices=ClaimActionChoices.parse(await readClaimModuleActionChoices(ctx));const keyChoices=choices.kind==='choices'?{...choices,employments:[...choices.employments].sort((a,b)=>a.employmentId.localeCompare(b.employmentId)),types:[...choices.types].sort((a,b)=>a.id.localeCompare(b.id)),drafts:[...choices.drafts].sort((a,b)=>a.id.localeCompare(b.id))}:choices;const key=createHash('sha256').update(JSON.stringify([principal,locale,resume.data??null,flow.data,keyChoices])).digest('hex');return flow.data==='submit'?<ModuleClaimSubmissionPanel key={key} choices={choices} resumeActionId={resume.data}/>:<ModuleClaimActionPanel key={key} choices={choices} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
