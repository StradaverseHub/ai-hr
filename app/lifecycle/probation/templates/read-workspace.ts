import {probationLetterConversionReport} from '@/lib/probation-letter-builder';
import {probationNativeDocumentRoutingChoices,probationLetterBuilderCatalog} from '@/core/probation-letter';
import type {SessionContext} from '@/db/client';
import {probationAdministrationOptions,probationSetup,probationLetterTemplates,probationSummaryRows,ProbationError} from '@/packs/probation/service';
import {AutomationError,automationAssignmentGroups,listAutomationRoutings} from '@/packs/automation/service';
import {PROBATION_LETTER_ROUTING_STORED} from '@/core/probation-letter-routing';
/** Same canonical definitions for the original route and the module-aware template hub. */
export async function readProbationLetterWorkspace(ctx:SessionContext,companyId?:string){
 const options=await probationAdministrationOptions(ctx);
 const company=companyId?options.companies.find(company=>company.id===companyId):options.companies[0];
 if(!company)return null;
 const setup=await probationSetup(ctx,company.id);if(!setup.canConfigure)return null;
 const definitions=Array.from(await probationLetterTemplates(ctx,company.id));
 // Sequential requests avoid holding several database connections for one page.
 const builderCatalog=await probationLetterBuilderCatalog(ctx,company.id);
 const nativeRoutingChoices=await probationNativeDocumentRoutingChoices(ctx,company.id);
 const routings=await listAutomationRoutings(ctx),groups=await automationAssignmentGroups(ctx).catch(error=>{if(error instanceof AutomationError&&error.code==='forbidden')return nativeRoutingChoices.groups;throw error;}),cases=await probationSummaryRows(ctx,{companyId:company.id,limit:50}).catch(error=>{if(error instanceof ProbationError&&error.code==='forbidden')return{rows:[]};throw error;});
 const canonical=options.organisationCatalogs?.['personnel-v2']??options;
 const conversionReports=definitions.map(definition=>({id:definition.id,report:probationLetterConversionReport(definition.data,definition.version,{businessGroup:canonical.businessGroups,businessUnit:canonical.businessUnits,company:options.companies,department:options.departments,grade:options.grades.map(code=>({id:code,code,name:code}))})}));
 return {maxExtensions:setup.settings?.data.maxExtensions??2,builderCatalog,conversionReports,nativeRoutingChoices,company,companies:options.companies,ruleOptions:{organisationMapping:options.organisationMapping,organisationCatalogs:options.organisationCatalogs,businessGroups:options.businessGroups,businessUnits:options.businessUnits.filter(unit=>unit.companyId===company.id),departments:options.departments.filter(department=>department.companyId===company.id),grades:options.grades},definitions,
  routingChoices:{routings:routings.filter(routing=>!routing.retired).map(routing=>({id:routing.routing.id,name:routing.routing.name})),groups,people:options.users},
  previewCases:cases.rows.map(row=>({id:row.id,label:row.employeeCode?`${row.employeeName} · ${row.employeeCode}`:row.employeeName})),routingStored:PROBATION_LETTER_ROUTING_STORED};
}
