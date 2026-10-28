import {progressModules} from '@/packs/performance/onehr/progress-model';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { getAssessmentProgress,getAssessmentAssessorProgress } from '@/packs/performance/service';
import { Card } from '@/components/ui';
import { ProgressTable } from './progress-table';
/** `fixed` (D-P1-32 PT-X4): one admin Run page per module, so the module and the people/raters switch are set by the
 * page, not offered. A module the cycle does not run shows the empty state rather than another module's rows. */
export async function AssessmentProgressAdmin({cycleId,initial,fixed=false}:{cycleId:string;initial?:{progressModule?:string;progressKind?:string;progressGroup?:string;progressCompany?:string};fixed?:boolean}){
 const {s}=await scopedSession();
 const clean=(value:unknown)=>typeof value==='string'?value.slice(0,300):'';
 const module=progressModules.find(m=>m===initial?.progressModule)??'pm',kind=initial?.progressKind==='assessors'?'assessors':'assessments';
 const [assessment,assessors]=await Promise.all([getAssessmentProgress(s,cycleId,{module}),getAssessmentAssessorProgress(s,cycleId)]);
 if(fixed&&kind==='assessments'&&!assessment.availableModules.includes(module)){
  const t=await getTranslations('onehr');
  return <Card className="space-y-4 p-5"><h2 className="font-semibold">{t('progressAdmin.title')}</h2><p className="py-4 text-sm text-muted-foreground">{t('progressAdmin.empty')}</p></Card>;
 }
 return <ProgressTable key={JSON.stringify(initial)} assessment={assessment} assessors={assessors} fixed={fixed} initial={{kind,group:clean(initial?.progressGroup),company:clean(initial?.progressCompany)}}/>;
}
