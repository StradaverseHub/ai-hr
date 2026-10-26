import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {z} from 'zod';
import {getBrowserCommandSession} from '@/lib/session';
import {isLocale} from '@/i18n/config';
import {readOrgModuleActionAvailability} from '@/core/assistant-actions/module-action-server';
import {ModuleOrgActionPanel} from './module-org-action-panel';
export async function ModuleOrgActionSection({resumeActionId:value}:{resumeActionId?:unknown}={}){
 const t=await getTranslations('assistant.workspace.orgActions'),unavailable=()=> <section className="space-y-3"><p role="alert" className="text-sm">{t('unavailable')}</p><Link href="/admin/personnel" className="inline-flex min-h-11 items-center text-sm underline">{t('manual')}</Link></section>;
 try{const resume=z.uuid().optional().safeParse(value);if(!resume.success)return unavailable();const selected=await getBrowserCommandSession();
  const ctx={...selected,roles:selected.roles?.slice(),grants:selected.grants?.map(g=>({...g}))};
  const locale=await getLocale();if(!ctx.userId||!isLocale(locale))return unavailable();
  const availability=z.discriminatedUnion('kind',[z.object({kind:z.literal('available')}).strict(),z.object({kind:z.literal('unavailable')}).strict()]).parse(await readOrgModuleActionAvailability(ctx));
  const grants=(ctx.grants??[]).map(g=>[g.role,g.companyId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Scope is searched rather than enumerated. A fresh actual server render always clears retained
  // private labels, even when the role names stayed the same while rule scope was revoked. This nonce
  // is neither posted nor persisted and confers no authority; every POST repeats source checks.
  const key=createHash('sha256').update(JSON.stringify(['org-action-panel:v1',ctx.tenantId,ctx.userId,ctx.personId??null,[...(ctx.roles??[])].sort(),grants,locale,resume.data??null,availability.kind,randomUUID()])).digest('hex');
  return <ModuleOrgActionPanel key={key} available={availability.kind==='available'} resumeActionId={resume.data}/>;
 }catch{return unavailable();}
}
