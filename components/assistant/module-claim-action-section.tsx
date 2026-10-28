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
import {ModuleClaimCancellationPanel} from './module-claim-cancellation-panel';
import {readClaimCancellationChoices} from '@/core/assistant-actions/claim-cancellation-review-store';
import {OwnClaimCancellationChoices} from '@/lib/assistant-actions/own-claim-cancellation-contract';
export async function ModuleClaimActionSection({resumeActionId:value,flow:flowValue}:{resumeActionId?:unknown;flow?:unknown}={}){
 const t=await getTranslations('assistant.workspace.claimActions');const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/claims" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value),flow=z.enum(['draft','submit','cancel']).default('draft').safeParse(flowValue);if(!resume.success||!flow.success)return unavailable();const source=await getBrowserCommandSession(),ctx={...source,roles:source.roles?.slice(),grants:source.grants?.map(grant=>({...grant}))};
  const grants=(ctx.grants??[]).map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));const principal=createHash('sha256').update(JSON.stringify(['claims-human-draft:v1',ctx.tenantId,ctx.userId,ctx.personId,[...(ctx.roles??[])].sort(),grants])).digest('hex');
  const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();
  // ADR-0151 wave 1: own pending claim cancellation has its own choices and state machine.
  if(flow.data==='cancel'){const cancellable=OwnClaimCancellationChoices.parse(ctx.personId?await readClaimCancellationChoices(ctx):{kind:'unavailable'});const cancelKey=createHash('sha256').update(JSON.stringify([principal,locale,resume.data??null,'cancel',cancellable])).digest('hex');return <ModuleClaimCancellationPanel key={cancelKey} choices={cancellable} resumeActionId={resume.data}/>;}const choices=ClaimActionChoices.parse(ctx.personId?await readClaimModuleActionChoices(ctx):{kind:'unavailable'});const keyChoices=choices.kind==='choices'?{...choices,employments:[...choices.employments].sort((a,b)=>a.employmentId.localeCompare(b.employmentId)),types:[...choices.types].sort((a,b)=>a.id.localeCompare(b.id)),drafts:[...choices.drafts].sort((a,b)=>a.id.localeCompare(b.id))}:choices;const key=createHash('sha256').update(JSON.stringify([principal,locale,resume.data??null,flow.data,keyChoices])).digest('hex');return flow.data==='submit'?<ModuleClaimSubmissionPanel key={key} choices={choices} resumeActionId={resume.data}/>:<ModuleClaimActionPanel key={key} choices={choices} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
