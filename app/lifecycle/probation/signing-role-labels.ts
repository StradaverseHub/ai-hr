import type {SigningAction,SigningRoute,SigningStep} from '@/lib/document-signing-model';
/** Presentation only: the signing owner decides whether these roles are covered. */
export function coveredRoleKeys(route:SigningRoute,entry:SigningStep|SigningAction):string[]{
 return [...new Set([entry.role,...(entry.coveredStepIds??[]).flatMap(id=>{const role=route.steps.find(step=>step.id===id)?.role;return role?[role]:[];})])];
}
