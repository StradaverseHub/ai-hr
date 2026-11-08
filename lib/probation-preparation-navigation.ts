/** Link facts only. Configuration/intake owners retain their native conditional gates. */
export const PROBATION_PREPARATION_LINKS=[
 {path:'settings',labelKey:'settings.title',navigationId:'nested.probationPreparation.settings'},
 {path:'forms',labelKey:'form.title',navigationId:'nested.probationPreparation.forms'},
 {path:'routes',labelKey:'routes.title',navigationId:'nested.probationPreparation.routes'},
 {path:'workflows',labelKey:'workflows.title',navigationId:'nested.probationPreparation.workflows'},
 {path:'templates',labelKey:'templates.title',navigationId:'nested.probationPreparation.templates'},
 {path:'intake',labelKey:'intake.title',navigationId:'nested.probationPreparation.intake'},
] as const;
export function probationPreparationHref(path:(typeof PROBATION_PREPARATION_LINKS)[number]['path'],companyId:string){return '/lifecycle/probation/'+path+'?company='+encodeURIComponent(companyId);}
