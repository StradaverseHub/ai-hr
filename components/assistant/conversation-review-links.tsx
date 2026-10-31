/** Human-review destinations are already present in a current source-owned card. This footer
 * grants no effect permission: the selected page still owns authorization, selection and consent. */
import {personnelReviewTitleKey} from '../../lib/ai/personnel-review-labels';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '../../db/client';
import {assertCanonicalModuleJobView,type CanonicalModuleJobView} from '../../core/workspace-module-jobs';
import {moduleHumanActionHandoffs} from '../../lib/ai/module-human-handoffs';
export async function ConversationReviewLinks({views,ctx}:{views:readonly CanonicalModuleJobView[];ctx:SessionContext}){
 try{
  // Validate the entire source set before reading any card; copied or cross-principal views refuse.
  for(const view of views)assertCanonicalModuleJobView(view,ctx);
  const seen=new Set<string>(),links:{module:string;route:string}[]=[];
  for(const view of views){if(view.state!=='ready')continue;
   const module=view.presentation.module,allowed=moduleHumanActionHandoffs(module);
   for(const card of view.presentation.cards){if(card.withheld||card.linkPurpose!=='human_review'||!card.href||card.title.kind!=='module'||card.title.module!==module)continue;
    if(!allowed.some(handoff=>handoff.module===module&&handoff.route===card.href))continue;
    const key=JSON.stringify([module,card.href]);if(seen.has(key))continue;seen.add(key);links.push({module,route:card.href});
   }
  }
  if(!links.length)return null;
  const t=await getTranslations('assistant.workspace.jobs'),titles=await getTranslations();
  return <div className="space-y-2"><p className="text-xs text-muted-foreground">{t('humanReviewNote')}</p><ul className="flex flex-wrap gap-2">{links.map(link=><li key={JSON.stringify([link.module,link.route])}><a href={link.route} className="inline-flex min-h-11 items-center rounded-md px-3 text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{personnelReviewTitleKey(link.module,link.route)?titles(personnelReviewTitleKey(link.module,link.route)!):<>{t('reviewAction')}{' — '}{t(`module_${link.module}`)}</>}</a></li>)}</ul></div>;
 }catch{return null;}
}
