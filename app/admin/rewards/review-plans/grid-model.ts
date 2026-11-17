/** Local staged choices; the server owns authorization, readiness, money and persistence. */
import type {RewardPlanGridEdit,RewardReviewPlanRow} from '@/packs/rewards/review-plans-model';
export function editFromRow(row:RewardReviewPlanRow):RewardPlanGridEdit{return{companyId:row.companyId,expectedRevision:row.revision,planType:row.planType,reason:row.reason,salaryVersionId:row.salaryVersionId,bonusVersionId:row.bonusVersionId,salaryReviewed:row.salarySuggestion.reviewed,bonusReviewed:row.bonusSuggestion.reviewed,branchAcknowledged:row.branchAcknowledged};}
export function changedPlanEdit(row:RewardReviewPlanRow,edit:RewardPlanGridEdit){return JSON.stringify(editFromRow(row))!==JSON.stringify(edit);}
export function acceptPlanSuggestions(row:RewardReviewPlanRow,current?:RewardPlanGridEdit):RewardPlanGridEdit{const value=current??editFromRow(row);return{...value,salaryReviewed:!!value.salaryVersionId,bonusReviewed:!!value.bonusVersionId};}
export function hasInvalidPlanEdit(edit:RewardPlanGridEdit,branch:boolean){return edit.planType==='no_awards'?edit.reason.trim().length<10:branch&&!edit.branchAcknowledged;}
