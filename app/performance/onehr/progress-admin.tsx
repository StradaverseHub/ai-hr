import {progressModules} from '@/packs/performance/onehr/progress-model';
import { scopedSession } from '@/lib/scope';
import { getAssessmentProgress,getAssessmentAssessorProgress } from '@/packs/performance/service';
import { ProgressTable } from './progress-table';
export async function AssessmentProgressAdmin({cycleId,initial}:{cycleId:string;initial?:{progressModule?:string;progressKind?:string;progressGroup?:string;progressCompany?:string}}){
 const {s}=await scopedSession();
 const clean=(value:unknown)=>typeof value==='string'?value.slice(0,300):'';
 const module=progressModules.find(m=>m===initial?.progressModule)??'pm';
 const [assessment,assessors]=await Promise.all([getAssessmentProgress(s,cycleId,{module}),getAssessmentAssessorProgress(s,cycleId)]);
 return <ProgressTable key={JSON.stringify(initial)} assessment={assessment} assessors={assessors} initial={{kind:initial?.progressKind==='assessors'?'assessors':'assessments',group:clean(initial?.progressGroup),company:clean(initial?.progressCompany)}}/>;
}
