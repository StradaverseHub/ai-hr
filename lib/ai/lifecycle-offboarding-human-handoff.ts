/** Navigation only into the native offboarding workbench (ADR-0095). Outcome changes can create or
 * cancel IT Returns and reconcile checklist completion. Those effects stay in the native transaction.
 * No case, employment, company, date, delegation, outcome or confirmation is carried from a model.
 * This is deliberately not an executable registry action or a custody/receipt protocol.
 */
import {z} from 'zod';
export const LIFECYCLE_OFFBOARDING_HUMAN_HANDOFF_SCHEMA=z.object({
 module:z.literal('lifecycle'),action:z.literal('lifecycle.offboarding.workflow'),
 route:z.literal('/lifecycle/offboarding'),requiresHumanSelection:z.literal(true),
 effect:z.literal('none'),authority:z.literal('rechecked_on_native_page'),
}).strict();
export type LifecycleOffboardingHumanHandoff=Readonly<z.infer<typeof LIFECYCLE_OFFBOARDING_HUMAN_HANDOFF_SCHEMA>>;
const handoff:LifecycleOffboardingHumanHandoff=Object.freeze(LIFECYCLE_OFFBOARDING_HUMAN_HANDOFF_SCHEMA.parse({
 module:'lifecycle',action:'lifecycle.offboarding.workflow',route:'/lifecycle/offboarding',
 requiresHumanSelection:true,effect:'none',authority:'rechecked_on_native_page',
}));
export function lifecycleOffboardingHumanHandoff():LifecycleOffboardingHumanHandoff{
 if(arguments.length!==0)throw Error('Offboarding navigation unavailable.');
 return handoff;
}
export function checkedLifecycleOffboardingHumanHandoff(value:unknown):LifecycleOffboardingHumanHandoff{
 LIFECYCLE_OFFBOARDING_HUMAN_HANDOFF_SCHEMA.parse(value);
 return handoff;
}
