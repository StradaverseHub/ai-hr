/** Full native human observation contract. Models nominate a reference only, never statuses or text. */
import {z} from 'zod';
import {executionInputSchema,EXECUTION_STATUSES,testingUuid} from '../system-testing/model';
export const OwnTestingExecutionNomination=z.object({version:z.literal(1),executionId:testingUuid}).strict();
export const OwnTestingExecutionIntent=z.object({version:z.literal(1),humanObserved:z.literal(true),observation:executionInputSchema}).strict();
export type OwnTestingExecutionIntent=z.infer<typeof OwnTestingExecutionIntent>;
export const OwnTestingExecutionReview=z.object({version:z.literal(1),action:z.literal('system_testing.execution.save'),humanObservation:executionInputSchema,
 caseId:testingUuid,caseNo:z.number().int().positive(),assignmentId:testingUuid,executionId:testingUuid,versionId:testingUuid,instructionOrdinal:z.number().int().positive(),
 meaning:z.literal('human_observation_not_independently_verified'),reviewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const OwnTestingExecutionReceipt=z.object({version:z.literal(1),action:z.literal('system_testing.execution.save'),proof:z.literal('recorded_human_observation_current_own_run'),
 caseId:testingUuid,assignmentId:testingUuid,executionId:testingUuid,versionId:testingUuid,runId:testingUuid,eventId:testingUuid,revision:z.number().int().positive(),status:z.enum(EXECUTION_STATUSES),
 meaning:z.literal('human_observation_recorded_not_independently_verified')}).strict();
export type OwnTestingExecutionReceipt=z.infer<typeof OwnTestingExecutionReceipt>;
