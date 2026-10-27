import {sql,type SQL} from 'drizzle-orm';
/** Delegation keeps the stage's original clock; every newly approved stage starts a new one. */
export function letterStageEnteredAt(stageIndex:SQL,submittedAt:SQL,revisionId:SQL){
 return sql`case when ${stageIndex}=0 then ${submittedAt} else (select decision.created_at from letter_approval_decision decision where decision.revision_id=${revisionId} and decision.stage_index=${stageIndex}-1 and decision.action='approve') end`;
}
