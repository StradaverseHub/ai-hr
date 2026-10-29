import {z} from 'zod';
/** The time is a device claim, never an authoritative attendance timestamp. */
export const ClockPreparation=z.object({requestId:z.string().uuid(),action:z.enum(['in','out']),claimedAt:z.number().int().positive().max(8640000000000000)}).strict();
export type ClockPreparation=z.infer<typeof ClockPreparation>;
export const ClockAttemptReceipt=z.object({requestId:z.string().uuid(),receivedAt:z.string().datetime()});
export type ClockAttemptReceipt=z.infer<typeof ClockAttemptReceipt>;
export const ClockAttemptsResponse=z.object({items:z.array(ClockPreparation.extend({receivedAt:z.string().datetime()})).max(20)});
export type ClockAttemptsResponse=z.infer<typeof ClockAttemptsResponse>;
