/** Real selected-cookie session/reset identity, not a posted actor or a synthetic empty profile. */
import 'server-only';
import {createHash} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {ProfileActionChoices} from '@/lib/assistant-actions/module-action-http';
import {readProfileModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {ModuleProfileActionPanel} from './module-profile-action-panel';
export async function ModuleProfileActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.profileActions');
 const unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/me/profile" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const source=await getBrowserCommandSession();const ctx={...source,roles:source.roles?.slice(),grants:source.grants?.map(grant=>({...grant}))};
  // Capture the opaque principal reset identity BEFORE the locale await. Neither private values nor
  // a shared mutable session object can retarget a retained editor across a login/scope change.
  const grants=(ctx.grants??[]).map(grant=>[grant.role,grant.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const principal=createHash('sha256').update(JSON.stringify(['profile-human-editor:v1',ctx.tenantId,ctx.userId,ctx.personId,[...(ctx.roles??[])].sort(),grants])).digest('hex');
  const locale=await getLocale();if(!ctx.userId||!ctx.personId||!isLocale(locale))return unavailable();const choices=ProfileActionChoices.parse(await readProfileModuleActionChoices(ctx));
  const keyChoices=choices.kind==='choices'?{kind:choices.kind,employments:choices.employments.map(row=>({...row,fields:[...row.fields].sort((a,b)=>a.fieldId.localeCompare(b.fieldId))})).sort((a,b)=>a.employmentId.localeCompare(b.employmentId))}:choices;
  const key=createHash('sha256').update(JSON.stringify([principal,locale,resume.data??null,keyChoices])).digest('hex');return <ModuleProfileActionPanel key={key} choices={choices} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
