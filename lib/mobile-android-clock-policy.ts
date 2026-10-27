/** Deployment-owned requirements for current Android evidence. No defaults or attendance authority. */
import {z} from 'zod';

const signal=z.enum(['deny_reported','require_report']);
export const AndroidClockIntegrityPolicy=z.object({
 version:z.literal(1),minimumDeviceIntegrity:z.enum(['device','strong']),
 licensing:z.enum(['licensed','any_evaluated']),
 maxTokenAgeMs:z.number().int().min(1).max(120000),
 allowedFutureSkewMs:z.number().int().min(0).max(30000),
 locationSignals:z.object({mock:signal,simulated:signal,
  accessory:z.enum(['allow','deny_reported','require_report']),
 }).strict(),
}).strict();
export type AndroidClockIntegrityPolicy=z.infer<typeof AndroidClockIntegrityPolicy>;
