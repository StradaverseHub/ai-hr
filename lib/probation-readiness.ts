import {PROBATION_AUTOMATION_CATALOGUE} from './automation/catalogues/probation';
import type {ProbationWorkflowEvent} from './probation-workflow';

export type ProbationRequiredWorkflowStatus={companyName:string;canConfigure:boolean;missing:ProbationWorkflowEvent[];summaryReady:boolean};
/**
 * I11: readiness of the notify-only engine's required messages once the shared Probation workflows are counted. An
 * event is covered when a shared workflow on its mapped trigger (the catalogue's `legacyEvents`) is Live, or was moved
 * from the notify-only engine; then it is not missing and the warning does not show for it. Pure.
 */
export function probationReadinessWithSharedWorkflows(status:ProbationRequiredWorkflowStatus,sharedTriggers:ReadonlySet<string>):ProbationRequiredWorkflowStatus{
 const covered=(event:string)=>{const mapping=PROBATION_AUTOMATION_CATALOGUE.legacyEvents?.find(e=>e.event===event);return !!mapping&&sharedTriggers.has(mapping.trigger);};
 return{...status,missing:status.missing.filter(event=>!covered(event)),summaryReady:status.summaryReady||covered('overdue_summary')};
}
