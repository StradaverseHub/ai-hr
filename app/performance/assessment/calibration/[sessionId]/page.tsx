import { scopedSession } from '@/lib/scope';
import { getOnehrCalibration,getAssessmentFinalBands,getPerformanceAreaFacts } from '@/packs/performance/service';
import type { PerformanceCalibrationHint } from '@/packs/performance/onehr/tab-model';
import { PerformanceTabStrip } from '@/components/performance-tabs';
import { AssessmentCalibrationView } from '../../../onehr/calibration-view';
import { FinalBandsView } from '../../../onehr/final-bands-view';
/**
 * D-P1-32 PT-X2: the session renders under the Calibration strip, lit by the session's axis hint: the axis the
 * per-axis list opened it with (`?axis=`, when the session calibrates that axis), otherwise Talent box for a BG
 * session and the session's first axis for the others. The hint only lights a tab; the screen is unchanged.
 */
export default async function AssessmentCalibrationPage({params,searchParams}:{params:Promise<{sessionId:string}>;searchParams:Promise<{error?:string;view?:string;axis?:string}>}){
 const {s}=await scopedSession(),{sessionId}=await params,{error,view,axis}=await searchParams;
 const strip=async(hint:PerformanceCalibrationHint)=><div className="mx-auto max-w-[100rem]"><PerformanceTabStrip strip="calibration" facts={await getPerformanceAreaFacts(s)} hint={hint}/></div>;
 if(view==='final-bands'){const v=await getAssessmentFinalBands(s,sessionId);return <div className="space-y-3">{await strip(axis==='potential'?'potential':'performance')}<FinalBandsView v={v} error={error}/></div>;}
 const v=await getOnehrCalibration(s,sessionId);
 const hint:PerformanceCalibrationHint=axis==='performance'&&v.axes.pm||axis==='potential'&&v.axes.pot?axis:v.session.tier==='bg'?'talent_box':v.axes.pm?'performance':'potential';
 return <div className="space-y-3">{await strip(hint)}<AssessmentCalibrationView v={v} error={error}/></div>;
}
