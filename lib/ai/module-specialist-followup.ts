/** Closed diagnostics over an ALREADY authenticated canonical projection. No model values,
 * thresholds, money arithmetic, action eligibility or effects. One bounded decision per module;
 * original factual cards/warnings remain intact. References are paths, never copied private values. */
import type {AgentModuleCode} from './module-agents';
import type {JobPresentation} from './module-jobs';
import {moduleHumanActionHandoffs} from './module-human-handoffs';
export const FOLLOWUP_CODES=['insufficient','no_followup','check_employment','review_reporting','read_reporting','track_leave','read_balance','review_profile_gaps','track_request','check_request_dates','read_published_index','inspect_payslip_gaps','read_payslip','review_attendance_record','read_attendance','inspect_claim_draft','track_claim','await_claim_payment','read_claim_payment','wait_review_release','read_performance','read_reward_stage','review_lifecycle_steps','inspect_credit_status','read_released_runs','inspect_component_unknown','read_component','review_statutory_gaps','read_notifications','read_notices','schema_boundary','select_native_workflow','verify_human_test','inspect_test_problem','continue_test','read_test_not_applicable'] as const;
export type FollowupCode=typeof FOLLOWUP_CODES[number];
export type SpecialistDiagnostic=Readonly<{version:1;recordNumber:number|null;state:'review'|'recorded'|'insufficient'|'no_followup';code:FollowupCode;evidencePaths:readonly string[];route:string|null;effect:'none';requiresHumanIntent:true}>;
const obj=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const rows=(v:unknown)=>{const r=obj(v)?.rows;return Array.isArray(r)?r.map(obj).filter((r):r is Record<string,unknown>=>r!==null):[];};
const numeric=(v:unknown):number|null=>{const n=typeof v==='number'?v:typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v)?Number(v):NaN;return Number.isFinite(n)?n:null;};
const known=(v:unknown,values:readonly string[])=>typeof v==='string'&&values.includes(v);
/** Only paths below are observable; arbitrary new/poison fields cannot enter a diagnostic. */
function singleDiagnostic(module:AgentModuleCode,data:unknown,presentation:JobPresentation):SpecialistDiagnostic{
 const emit=(state:SpecialistDiagnostic['state'],code:FollowupCode,path?:string):SpecialistDiagnostic=>Object.freeze({version:1,recordNumber:null,state,code,evidencePaths:Object.freeze(path?[path]:[]),route:null,effect:'none',requiresHumanIntent:true});
 const insufficient=()=>emit('insufficient','insufficient'),o=obj(data),r=rows(data),first=r[0];
 if(presentation.truncated||presentation.cards.some(card=>card.withheld)||!presentation.cards.length)return insufficient();
 // Each module is explicitly implemented. A new/future module is a refusal, never generic enablement.
 switch(module){
 case'employees':return first&&known(first.status,['active','probation','active_serving_notice','terminated','resigned','blacklisted'])?emit('recorded','check_employment','rows[0].status'):insufficient();
 case'org':{const lines=first?.reportingLines;if(!Array.isArray(lines))return insufficient();return lines.some(line=>obj(line)?.lineType==='administrative')?emit('recorded','read_reporting','rows[0].reportingLines'):emit('review','review_reporting','rows[0].reportingLines');}
 case'leave':{const balances=first?.balances;if(!Array.isArray(balances)||!balances.length)return insufficient();const b=obj(balances[0]);if(!b||b.withheld===true)return insufficient();if(numeric(b.pending)!==null&&numeric(b.pending)!>0)return emit('recorded','track_leave','rows[0].balances[0].pending');return numeric(b.available)!==null?emit('recorded','read_balance','rows[0].balances[0].available'):insufficient();}
 case'ess':case'country-my':{if(!o||numeric(o.employees)===null||numeric(o.employees)!<=0||!Array.isArray(o.gaps))return insufficient();if(o.gaps.length)return emit('review',module==='ess'?'review_profile_gaps':'review_statutory_gaps','gaps');return numeric(o.ready)!==null&&numeric(o.ready)===numeric(o.employees)?emit('no_followup','no_followup','ready'):insufficient();}
 case'approvals':return first?.hasRejectedDates===true?emit('review','check_request_dates','rows[0].hasRejectedDates'):first&&known(first.status,['pending','approved','rejected','cancelled'])?emit('recorded','track_request','rows[0].status'):insufficient();
 case'knowledge_base':return typeof first?.title==='string'?emit('recorded','read_published_index','rows[0].title'):insufficient();
 case'payroll':return first?emit(first.net==null||first.gross==null||first.deductions==null||first.currency==null?'review':'recorded',first.net==null||first.gross==null||first.deductions==null||first.currency==null?'inspect_payslip_gaps':'read_payslip','rows[0]'):insufficient();
 case'attendance':return first&&known(first.status,['absent','late','half_day','present','rest_day','holiday','on_leave'])?emit(['absent','late','half_day'].includes(String(first.status))?'review':'recorded',['absent','late','half_day'].includes(String(first.status))?'review_attendance_record':'read_attendance','rows[0].status'):insufficient();
 case'claims':{const claims=o?.claims;if(!Array.isArray(claims)||!claims.length)return insufficient();const claim=obj(claims[0]);switch(claim?.status){case'draft':return emit('review','inspect_claim_draft','claims[0].status');case'pending':return emit('recorded','track_claim','claims[0].status');case'approved':return emit('recorded','await_claim_payment','claims[0].status');case'paid':return emit('recorded','read_claim_payment','claims[0].status');default:return insufficient();}}
 case'performance':return first?.framework==='onehr'?known(first.artifact,['review','plan'])?emit('recorded','read_performance','rows[0].artifact'):insufficient():typeof first?.released==='boolean'?emit('recorded',first.released?'read_performance':'wait_review_release','rows[0].released'):insufficient();
 case'rewards':return first&&known(first.status,['draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn'])?emit('recorded','read_reward_stage','rows[0].status'):insufficient();
 case'lifecycle':{if(!o||!Array.isArray(o.steps))return insufficient();const relevant=o.steps.map(obj).filter(step=>step?.applicable===true);if(!relevant.length||relevant.some(step=>typeof step?.done!=='boolean'))return insufficient();if(relevant.some(step=>step?.done===false))return emit('review','review_lifecycle_steps','steps');const progress=obj(o.progress);return numeric(progress?.total)!==null&&numeric(progress?.total)!>0&&numeric(progress?.done)===numeric(progress?.total)?emit('no_followup','no_followup','steps'):insufficient();}
 case'toil':return first&&['active','expired','convertedToPay'].some(k=>numeric(first[k])!==null)?emit('recorded','inspect_credit_status','rows[0]'):insufficient();
 case'multi_cycle_payroll':return first&&numeric(first.runSeq)!==null?emit('recorded','read_released_runs','rows[0].runSeq'):insufficient();
 case'typed_pay_components':{const lines=rows(first?.lines);return lines.length?emit(lines[0].amount==null?'review':'recorded',lines[0].amount==null?'inspect_component_unknown':'read_component','rows[0].lines.rows[0].amount'):insufficient();}
 case'notifications':return first&&Object.hasOwn(first,'readAt')?emit(first.readAt==null?'review':'recorded',first.readAt==null?'read_notifications':'read_notices','rows[0].readAt'):insufficient();
 case'system_explorer':return numeric(o?.withheldTables)===0&&rows(o?.tables).length?emit('recorded','schema_boundary','tables.rows'):insufficient();
 case'assistant':return Array.isArray(o?.capabilities)&&o.capabilities.length?emit('recorded','select_native_workflow','capabilities'):insufficient();
 case'system_testing':return first&&known(first.status,['passed','failed','blocked','retest_required','not_started','in_progress','partial','not_applicable'])?emit(first.status==='passed'||first.status==='not_applicable'?'recorded':'review',first.status==='passed'?'verify_human_test':first.status==='not_applicable'?'read_test_not_applicable':['failed','blocked','retest_required'].includes(String(first.status))?'inspect_test_problem':'continue_test','rows[0].status'):insufficient();
 default:{const unsupported:never=module;void unsupported;throw Error('Unsupported diagnostic module.');}
 }
}

/** Scan the complete admitted bounded cohort before selecting one diagnostic. Any later review
 * problem wins over recorded status. Unknown evidence prevents a cohort-clear result. The exact
 * visible cards/warnings are retained by the caller; this is not a complete work queue. */
export function canonicalSpecialistFollowup(module:AgentModuleCode,data:unknown,presentation:JobPresentation):SpecialistDiagnostic{
 if(presentation.truncated||presentation.cards.some(card=>card.withheld))return singleDiagnostic(module,data,{...presentation,truncated:true});
 const scopes:{data:unknown;prefix:string;row:number;card:number|null}[]=[],o=obj(data);
 if(module==='claims'&&Array.isArray(o?.claims))o.claims.forEach((claim,index)=>scopes.push({data:{...o,claims:[claim]},prefix:`claims[${index}]`,row:index,card:index}));
 else if(module==='leave'){let card=0;rows(data).forEach((row,index)=>{if(!Array.isArray(row.balances)||!row.balances.length)scopes.push({data:{rows:[row],truncated:false},prefix:`rows[${index}]`,row:index,card:null});else row.balances.forEach((balance,balanceIndex)=>scopes.push({data:{rows:[{...row,balances:[balance]}],truncated:false},prefix:`rows[${index}].balances[${balanceIndex}]`,row:index,card:card++}));});}
 else if(module==='org'){let card=0;rows(data).forEach((row,index)=>{const count=Array.isArray(row.reportingLines)?row.reportingLines.length:0;scopes.push({data:{rows:[row],truncated:false},prefix:`rows[${index}]`,row:index,card:count?card:null});card+=count;});}
 else if(module==='typed_pay_components'){rows(data).forEach((row,index)=>{const lines=rows(row.lines);if(!lines.length)scopes.push({data:{rows:[row],truncated:false},prefix:`rows[${index}]`,row:index,card:null});else lines.forEach((line,lineIndex)=>scopes.push({data:{rows:[{...row,lines:{rows:[line],truncated:false}}],truncated:false},prefix:`rows[${index}].lines.rows[${lineIndex}]`,row:index,card:null}));});}
 else if(o&&Array.isArray(o.rows))o.rows.forEach((row,index)=>scopes.push({data:{...o,rows:[row]},prefix:`rows[${index}]`,row:index,card:['org','toil','typed_pay_components'].includes(module)?null:index}));
 else scopes.push({data,prefix:'',row:0,card:null});
 if(!scopes.length)return singleDiagnostic(module,data,presentation);
 const decisions=scopes.map(scope=>{const d=singleDiagnostic(module,scope.data,presentation);return{scope,d:{...d,evidencePaths:d.evidencePaths.map(path=>scope.prefix.startsWith('claims')?path.replace(/^claims\[0\]/,scope.prefix):scope.prefix.includes('.lines.rows[')?path.replace(/^rows\[0\]\.lines\.rows\[0\]/,scope.prefix):scope.prefix.includes('.balances[')?path.replace(/^rows\[0\]\.balances\[0\]/,scope.prefix):scope.prefix?path.replace(/^rows\[0\]/,scope.prefix):path)}};});
 const important=new Set<FollowupCode>(['track_leave','track_request','track_claim','await_claim_payment','wait_review_release','verify_human_test']);
 const chosen=decisions.find(row=>row.d.state==='review')??decisions.find(row=>row.d.state==='insufficient')??decisions.find(row=>row.d.state==='recorded'&&important.has(row.d.code))??decisions.find(row=>row.d.state==='recorded')??decisions[0];
 // A canonical original-record href is code-owned by presentCanonicalModuleData, never raw input.
 // For selected diagnostic problems only, a closed human page may offer a fresh selection/review;
 // this grants no effect eligibility and carries no source ID or model-selected action arguments.
 const actions:Partial<Record<FollowupCode,string>>={review_reporting:'org.reporting.change',review_attendance_record:'attendance.correction.request',inspect_claim_draft:'claims.draft.save',review_lifecycle_steps:'lifecycle.acknowledgement.submit',inspect_test_problem:'system_testing.execution.save',continue_test:'system_testing.execution.save'};
 const native=chosen.d.state==='insufficient'||chosen.d.state==='no_followup'?null:(chosen.scope.card===null?undefined:presentation.cards[chosen.scope.card]?.href)??(chosen.d.state==='review'&&actions[chosen.d.code]?moduleHumanActionHandoffs(module).find(row=>row.action===actions[chosen.d.code])?.route:null)??null;
 return Object.freeze({...chosen.d,recordNumber:chosen.d.state==='insufficient'||chosen.d.state==='no_followup'?null:chosen.scope.card===null?null:chosen.scope.card+1,evidencePaths:Object.freeze(chosen.d.evidencePaths),route:native});
}
