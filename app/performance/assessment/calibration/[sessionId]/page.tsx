import { scopedSession } from '@/lib/scope';
import { getOnehrCalibration,getAssessmentFinalBands } from '@/packs/performance/service';
import { AssessmentCalibrationView } from '../../../onehr/calibration-view';
import { FinalBandsView } from '../../../onehr/final-bands-view';
export default async function AssessmentCalibrationPage({params,searchParams}:{params:Promise<{sessionId:string}>;searchParams:Promise<{error?:string;view?:string}>}){
 const {s}=await scopedSession(),{sessionId}=await params,{error,view}=await searchParams;
 if(view==='final-bands')return <FinalBandsView v={await getAssessmentFinalBands(s,sessionId)} error={error}/>;
 return <AssessmentCalibrationView v={await getOnehrCalibration(s,sessionId)} error={error}/>;
}
