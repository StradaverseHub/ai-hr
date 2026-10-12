import { scopedSession } from '@/lib/scope';
import { getOnehrCalibration } from '@/packs/performance/service';
import { AssessmentCalibrationView } from '../../../onehr/calibration-view';
export default async function AssessmentCalibrationPage({params,searchParams}:{params:Promise<{sessionId:string}>;searchParams:Promise<{error?:string}>}){
 const {s}=await scopedSession(),{sessionId}=await params,{error}=await searchParams;
 return <AssessmentCalibrationView v={await getOnehrCalibration(s,sessionId)} error={error}/>;
}
