/**
 * Plain-language title and button text for one Probation task (lane L, L5): the kind app.probation_task_list returns
 * for the caller's step (5751/5756/5760) and the part it belongs to. Keys live under `probation.taskKinds`; /tasks and
 * the /approvals Probation category both read them here, so the two queues never word the same step differently.
 * Labels only: the link still opens the case screen, which authorizes again.
 */
const PART_KINDS=['submit_employee','submit_manager','acknowledge','approve','record','confirm_extension','confirm_refusal','kpi_exception','employee_wait_exception'] as const;
const CASE_KINDS=['letter_prepare','letter_sign','letter_review','letter_approve','letter_revise','letter_release','low_result_action','choose_outcome'] as const;
export const PROBATION_TASK_KINDS=[...PART_KINDS,...CASE_KINDS] as const;
export type ProbationTaskLabel={title:string;action:string;values:{part:number}};
const partNumber=(part:number|string|null|undefined)=>{const n=typeof part==='string'?Number(part):part;return n===1||n===2||n===3?n:null;};
/** Message keys (relative to the `probation` namespace) for a task kind; an unknown kind reads "Probation task" / "Open". */
export function probationTaskLabel(kind:string,part:number|string|null|undefined):ProbationTaskLabel{
 const n=partNumber(part);
 // Part 1 has no assessment: the Line Manager's step there is setting the Week 1 KPIs.
 const key=kind==='submit_manager'&&n===1?'submit_manager_kpis':kind;
 if((PART_KINDS as readonly string[]).includes(kind)&&n!==null)return{title:'taskKinds.'+key+'.title',action:'taskKinds.'+key+'.action',values:{part:n}};
 if((CASE_KINDS as readonly string[]).includes(kind))return{title:'taskKinds.'+key+'.title',action:'taskKinds.'+key+'.action',values:{part:n??0}};
 return{title:'taskKinds.other.title',action:'taskKinds.other.action',values:{part:n??0}};
}
