import { scopedSession } from '@/lib/scope';
import { getAssessmentProgress,getAssessmentAssessorProgress } from '@/packs/performance/service';
import { ProgressTable } from './progress-table';
export async function AssessmentProgressAdmin({cycleId}:{cycleId:string}){
 const {s}=await scopedSession();
 const [assessment,assessors]=await Promise.all([getAssessmentProgress(s,cycleId),getAssessmentAssessorProgress(s,cycleId)]);
 return <ProgressTable assessment={assessment} assessors={assessors}/>;
}
