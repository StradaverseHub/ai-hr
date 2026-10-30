/** Source-owned area guidance, never an assertion of the caller's action permissions. */
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '../../db/client';
import {assertCanonicalModuleJobView,type CanonicalModuleJobView} from '../../core/workspace-module-jobs';
import {MODULE_JOBS} from '../../lib/ai/module-jobs';

export async function AssistantCatalogueSummary({view,ctx}:{view:CanonicalModuleJobView;ctx:SessionContext}){
 try{
  assertCanonicalModuleJobView(view,ctx);
  if(view.state!=='ready'||view.presentation.module!=='assistant')return null;
  const modules=view.presentation.cards.map(card=>{
   if(card.title.kind!=='module'||card.withheld)throw Error();
   const code=card.title.module;if(!MODULE_JOBS.some(([module])=>module===code))throw Error();return code;
  });
  if(modules.length===0||new Set(modules).size!==modules.length)return null;
  const[copy,jobs]=await Promise.all([getTranslations('assistant.workspace.conversation'),getTranslations('assistant.workspace.jobs')]);
  const preferred=['leave','payroll','claims','org','employees','attendance','performance'] as const;
  const selected=[...preferred.filter(module=>modules.includes(module)),...modules.filter(module=>!preferred.some(code=>code===module))].slice(0,3);
  const examples=selected.map(module=><li key={module} className="text-sm leading-relaxed">{preferred.some(code=>code===module)?copy(`example_${module}`):copy('example_area',{area:jobs(`module_${module}`)})}</li>);
  const areas=modules.map(module=><li key={module} className="text-sm leading-relaxed">{jobs(`module_${module}`)}</li>);
  return <div className="space-y-3">
   <p className="text-sm leading-relaxed">{copy('catalogueIntro')}</p>
   <ul className="list-disc space-y-2 pl-5">{examples}</ul>
   <details><summary className="min-h-11 w-fit cursor-pointer py-2 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{copy('allAreas')}</summary><ul className="mt-2 space-y-2">{areas}</ul></details>
   <p className="text-xs text-muted-foreground">{copy('catalogueScope')}</p>
   {view.presentation.truncated&&<p className="text-xs text-muted-foreground">{jobs('truncated')}</p>}
  </div>;
 }catch{return null;}
}
