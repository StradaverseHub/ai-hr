import type { KPI,Policy } from './model';
export const progressModules=['pm','competency','feedback','calibration','career'] as const;
export type ProgressModule=typeof progressModules[number];
export type ProgressState='pending'|'active'|'done';
export type ProgressCell={state:ProgressState;label:string;count:number;completed:number};
/** Every label assessmentProgress can give a module's cell, in the order the work moves: the stages the admin
 * area's module Overview counts (D-P1-32 PT-X4). A Quarterly cycle's Performance is check-ins only. */
export function progressStages(module:ProgressModule,kind:Policy['kind']):readonly string[]{
 switch(module){
  case 'pm':return kind==='quarterly'?['checkin_pending','checked_in']:['not_set','not_submitted','awaiting_approval','approved'];
  case 'competency':return ['not_assigned','not_submitted','awaiting_review','reviewed'];
  case 'feedback':return ['panel_missing','feedback_pending','feedback_complete'];
  case 'calibration':return ['not_started','under_review','calibrated'];
  case 'career':return ['not_shared','plan_shared','plan_closed'];
 }
}
export function assessmentProgress(input:{kpis:KPI[];performanceConfirmed:boolean;resultsSubmitted:boolean;competencyStatus:string;competencyCount:number;panelCount:number;panelSubmitted:number;calibration:'none'|'draft'|'locked';planStatus:string|null;policy:Policy}):Partial<Record<ProgressModule,ProgressCell>>{
 const {policy}=input,out:Partial<Record<ProgressModule,ProgressCell>>={};
 const cell=(state:ProgressState,label:string,count:number,completed:number):ProgressCell=>({state,label,count,completed});
 if(policy.modules.pm){
  const complete=policy.kind==='quarterly'?input.kpis.filter(k=>!!k.checkIn).length:input.performanceConfirmed?input.kpis.length:0;
  out.pm=policy.kind==='quarterly'?cell(input.kpis.length&&complete===input.kpis.length?'done':complete?'active':'pending',input.kpis.length&&complete===input.kpis.length?'checked_in':'checkin_pending',input.kpis.length,complete):cell(input.performanceConfirmed?'done':input.resultsSubmitted?'active':'pending',input.performanceConfirmed?'approved':input.resultsSubmitted?'awaiting_approval':input.kpis.length?'not_submitted':'not_set',input.kpis.length,complete);
 }
 if(policy.modules.tm){
  out.competency=cell(input.competencyStatus==='reviewed'?'done':input.competencyStatus==='submitted'?'active':'pending',input.competencyStatus==='reviewed'?'reviewed':input.competencyStatus==='submitted'?'awaiting_review':input.competencyCount?'not_submitted':'not_assigned',input.competencyCount,input.competencyStatus==='reviewed'?input.competencyCount:0);
  out.feedback=cell(input.panelCount>0&&input.panelSubmitted===input.panelCount?'done':input.panelSubmitted?'active':'pending',input.panelCount>0&&input.panelSubmitted===input.panelCount?'feedback_complete':input.panelCount?'feedback_pending':'panel_missing',input.panelCount,input.panelSubmitted);
 }
 if(policy.kind==='year_end'&&policy.modules.calibration!==false&&(policy.modules.pm||policy.modules.tm))out.calibration=cell(input.calibration==='locked'?'done':input.calibration==='draft'?'active':'pending',input.calibration==='locked'?'calibrated':input.calibration==='draft'?'under_review':'not_started',1,input.calibration==='locked'?1:0);
 if(policy.modules.idp)out.career=cell(input.planStatus==='closed'?'done':input.planStatus==='shared'?'active':'pending',input.planStatus==='closed'?'plan_closed':input.planStatus==='shared'?'plan_shared':'not_shared',1,input.planStatus==='closed'?1:0);
 return out;
}
