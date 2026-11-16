import {notFound} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationAdministrationOptions,probationSetup,probationLetterTemplates,probationSummaryRows} from '@/packs/probation/service';
import {automationAssignmentGroups,automationPeopleNames,listAutomationRoutings} from '@/packs/automation/service';
import {PROBATION_LETTER_ROUTING_STORED,probationTemplateRouting,type ProbationRoutedTemplate} from '@/core/probation-letter-routing';
import {TemplateWorkspace} from './template-workspace';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const ctx=await requireScopedLifecycleModule(),query=await searchParams,options=await probationAdministrationOptions(ctx),company=typeof query.company==='string'?options.companies.find(c=>c.id===query.company):options.companies[0];if(!company)notFound();
 const setup=await probationSetup(ctx,company.id);if(!setup.canConfigure)notFound();
 const definitions=Array.from(await probationLetterTemplates(ctx,company.id));
 // Routing choices come from the shared builders (row security: people who configure HR Automation see them); named
 // people are resolved for the ids already used in this company's routings. Preview cases: the first 50 of the company.
 const people=[...new Set(definitions.flatMap(d=>probationTemplateRouting(d.data as ProbationRoutedTemplate).flatMap(step=>step.who.kind==='people'?step.who.userIds:[])))];
 // One transaction at a time, so the page never holds several pool connections.
 const routings=await listAutomationRoutings(ctx),groups=await automationAssignmentGroups(ctx),names=await automationPeopleNames(ctx,people).catch(()=>[]),cases=await probationSummaryRows(ctx,{companyId:company.id,limit:50});
 return <TemplateWorkspace key={company.id} company={company} companies={options.companies} ruleOptions={{organisationMapping:options.organisationMapping,organisationCatalogs:options.organisationCatalogs,businessGroups:options.businessGroups,businessUnits:options.businessUnits.filter(u=>u.companyId===company.id),departments:options.departments.filter(d=>d.companyId===company.id),grades:options.grades}} definitions={definitions}
  routingChoices={{routings:routings.filter(r=>!r.retired).map(r=>({id:r.routing.id,name:r.routing.name})),groups,people:names}}
  previewCases={cases.rows.map(row=>({id:row.id,label:row.employeeCode?`${row.employeeName} · ${row.employeeCode}`:row.employeeName}))} routingStored={PROBATION_LETTER_ROUTING_STORED}/>;
}
