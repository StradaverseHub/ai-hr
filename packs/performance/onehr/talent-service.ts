import { sql } from 'drizzle-orm';
import type { Tx } from '../../../db/client';
import { lastAppliedPromotionOnTx } from '../../../core/movement';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import type { Policy } from './model';
import { emptyTalentActions, promotionStandingReason, type TalentActions, type TalentHistory } from './talent-model';

/** A scoped projection: calibration users receive decisions, never the employee's private drafts. */
export async function talentContext(tx:Tx,tenantId:string,reviewId:string,employmentId:string,policy:Policy) {
 const [record]=await tx.execute<{value:{actions:TalentActions;history:TalentHistory[];revision:number}|null}>(sql`select app.assessment_talent_context(${reviewId}::uuid) as value`);
 if(!record?.value)throw Error('Talent decisions are outside your review scope.');
 const promotion=await lastAppliedPromotionOnTx(tx,tenantId,employmentId);
 const actions={...emptyTalentActions(),...record.value.actions};
 const standingReason=promotion.known?promotionStandingReason(record.value.history,promotion.date,Number(todayInKualaLumpur().slice(0,4)),policy.promotionRules):null;
 return {actions,revision:record.value.revision,history:record.value.history,standingReason,lastPromotionOn:promotion.date,promotionHistoryKnown:promotion.known,promotionEligible:actions.nominations.length>0||!!standingReason};
}
export async function writeTalentAction(tx:Tx,sessionId:string,reviewId:string,kind:'pip'|'promotion'|'specialReward'|'nomination',selected:boolean,reason:string,grade='',title='',revision=0) {
 await tx.execute(sql`select app.assessment_talent_write(${sessionId}::uuid,${reviewId}::uuid,${kind},${selected},${reason},${grade},${title},${revision})`);
}
