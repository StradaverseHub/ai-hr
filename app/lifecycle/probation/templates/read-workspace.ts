import type {SessionContext} from '@/db/client';
import {probationAdministrationOptions,probationSetup,probationLetterTemplates,probationSummaryRows} from '@/packs/probation/service';
import {automationAssignmentGroups,automationPeopleNames,listAutomationRoutings} from '@/packs/automation/service';
import {PROBATION_LETTER_ROUTING_STORED,probationTemplateRouting,type ProbationRoutedTemplate} from '@/core/probation-letter-routing';
/** Same canonical definitions for the original route and the module-aware template hub. */
export async function readProbationLetterWorkspace(ctx:SessionContext,companyId?:string){
 const options=await probationAdministrationOptions(ctx);
 const company=companyId?options.companies.find(company=>company.id===companyId):options.companies[0];
 if(!company)return null;
 const setup=await probationSetup(ctx,company.id);if(!setup.canConfigure)return null;
 const definitions=Array.from(await probationLetterTemplates(ctx,company.id));
 const people=[...new Set(definitions.flatMap(definition=>probationTemplateRouting(definition.data as ProbationRoutedTemplate).flatMap(step=>step.who.kind==='people'?step.who.userIds:[])))];
 // Sequential requests avoid holding several database connections for one page.
 const routings=await listAutomationRoutings(ctx),groups=await automationAssignmentGroups(ctx),names=await automationPeopleNames(ctx,people).catch(()=>[]),cases=await probationSummaryRows(ctx,{companyId:company.id,limit:50});
 return {company,companies:options.companies,ruleOptions:{organisationMapping:options.organisationMapping,organisationCatalogs:options.organisationCatalogs,businessGroups:options.businessGroups,businessUnits:options.businessUnits.filter(unit=>unit.companyId===company.id),departments:options.departments.filter(department=>department.companyId===company.id),grades:options.grades},definitions,
  routingChoices:{routings:routings.filter(routing=>!routing.retired).map(routing=>({id:routing.routing.id,name:routing.routing.name})),groups,people:names},
  previewCases:cases.rows.map(row=>({id:row.id,label:row.employeeCode?`${row.employeeName} · ${row.employeeCode}`:row.employeeName})),routingStored:PROBATION_LETTER_ROUTING_STORED};
}
