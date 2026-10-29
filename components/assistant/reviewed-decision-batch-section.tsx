import 'server-only';
import {randomUUID} from 'node:crypto';
import {getBrowserCommandSession} from '@/lib/session';
import {readAssignedLeaveModuleActionChoices} from '@/core/assistant-actions/module-action-server';
import {AssignedLeaveActionChoices} from '@/lib/assistant-actions/module-action-http';
import {REVIEWED_LEAVE_DECISION_ACTION} from '@/lib/assistant-actions/reviewed-leave-decision-contract';
import type {AssignedDecisionAction} from '@/lib/assistant-actions/assigned-decision-contract';
import {ReviewedDecisionBatch} from './reviewed-decision-batch';
export async function ReviewedDecisionBatchSection({action}:{action:AssignedDecisionAction|typeof REVIEWED_LEAVE_DECISION_ACTION}){
 const ctx=await getBrowserCommandSession();
 const choices=AssignedLeaveActionChoices.parse(action===REVIEWED_LEAVE_DECISION_ACTION?await readAssignedLeaveModuleActionChoices(ctx):{kind:'unavailable'});
 // Every server refresh remounts all private checkbox declarations, including scope/login refresh.
 return <ReviewedDecisionBatch key={randomUUID()} action={action} leaveChoices={choices}/>;
}
