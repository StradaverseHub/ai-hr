import {z} from 'zod';
import {PeopleGeneralPolicyValues} from './people-general-policy-contract';
/** Only fresh authorized defaults for form selection, never private source/authority/revision. */
export const PeopleGeneralPolicyAvailability=z.discriminatedUnion('kind',[z.object({kind:z.literal('available'),tenantId:z.guid(),tenantName:z.string().min(1).max(4000),policy:PeopleGeneralPolicyValues}).strict(),z.object({kind:z.literal('unavailable')}).strict()]);
