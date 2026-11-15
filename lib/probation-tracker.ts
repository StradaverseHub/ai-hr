/** Tracker row presentation rules (mockup screen 4): start status and the row action that follows what is waiting. Pure. */
export type ProbationRowAction='open'|'review_letter'|'record_action'|'log_followup';
export type ProbationRowStartStatus='waiting_for_start'|'did_not_join'|null;
type RowPart={state:string;dueOn:string;scoreBand:number|null};
type Row={state:string;closure?:string|null;startOn:string;endOn:string;letterWaiting:unknown;parts:RowPart[]};
const CLOSED=['withdrawn','confirmed','not_confirmed'];
const SETTLED_PART=['locked','recorded','completed_offline','cancelled','not_issued'];

/** Waiting for the start date (opened at activation) or closed because the hire did not join. */
export function probationRowStartStatus(row:Row,today:string):ProbationRowStartStatus{
 if(row.state==='withdrawn')return row.closure==='did_not_join'?'did_not_join':null;
 if(CLOSED.includes(row.state))return null;
 return row.startOn>today?'waiting_for_start':null;
}

/**
 * What the row button says: a letter waiting comes first, then a recorded low result (Band 1–2) that needs the PBP's
 * action, then overdue work or a passed end date with no outcome (log a follow-up). Everything else opens the case.
 */
export function probationRowAction(row:Row,today:string):ProbationRowAction{
 if(CLOSED.includes(row.state)||probationRowStartStatus(row,today))return 'open';
 if(row.letterWaiting)return 'review_letter';
 if(row.parts.some(part=>part.scoreBand!==null&&part.scoreBand<=2&&(part.state==='locked'||part.state==='recorded')))return 'record_action';
 if(row.endOn<today||row.parts.some(part=>!SETTLED_PART.includes(part.state)&&part.dueOn<today))return 'log_followup';
 return 'open';
}
